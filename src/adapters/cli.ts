import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalidCli, reviewerFailed } from "../core/errors.js";
import { assertAntigravityExecutableSupportsReviewPolicy } from "./antigravity.js";
import { claudeCliReviewPolicyCliFlags } from "./claude-tool-policy.js";
import { assertClaudeExecutableSupportsReviewPolicy } from "./claude.js";
import {
  claudeCliEffort,
  cliCapability,
  cliExecutableMetadata,
  cliExecutableSelection,
  copilotCliEffort,
  droidCliEffort,
  grokCliEffort,
  providerQualifiedModel,
} from "./cli-helpers.js";
import { resolveExecutable, runCli, trimForMetadata } from "./cli-process.js";
import { cliSpecs } from "./cli-specs.js";
import type { CliEngine, CliInvocation } from "./cli-types.js";
import { codexCliWebSearchPolicy, codexWebSearchMetadata } from "./codex-options.js";
import {
  copilotCliReviewPolicyCliFlags,
  copilotCliReviewPolicyFlagsForArgs,
  copilotReviewPolicyMetadata,
} from "./copilot-tool-policy.js";
import { assertCopilotExecutableSupportsReviewPolicy } from "./copilot.js";
import {
  type DroidCliReviewPolicyOptions,
  type DroidCliReviewPolicySupport,
  assertDroidExecutableSupportsReviewPolicy,
  droidCliReviewPolicyMetadata,
} from "./droid-tool-policy.js";
import {
  geminiCliReviewPolicyCliFlags,
  geminiCliReviewTrustedFoldersFileName,
  geminiCliTrustWorkspaceEnvVar,
  geminiCliTrustedFoldersPathEnvVar,
} from "./gemini-tool-policy.js";
import { assertGeminiExecutableSupportsReviewPolicy } from "./gemini.js";
import { grokCliReviewPolicyCliFlags } from "./grok-tool-policy.js";
import { assertGrokExecutableSupportsReviewPolicy } from "./grok.js";
import {
  type ResolutionSource,
  effortResolutionMetadata,
  mergeResolutionMetadataRecords,
  modelResolutionMetadata,
} from "./metadata.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerConfig,
} from "./types.js";

type CliRunContext = {
  kind: "cli";
  requestedExecutable: string;
  resolvedExecutable: string;
  path?: string;
};

type CliPolicyCheckEngine = Extract<
  CliEngine,
  "antigravity" | "claude" | "copilot" | "droid" | "gemini" | "grok"
>;
type CliExecutableIdentity = {
  realpath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};
type PreparedPolicyCheckState = {
  policyChecks: Set<CliPolicyCheckEngine>;
  resolvedExecutable: string;
  executableIdentity?: CliExecutableIdentity;
  envFingerprint: string;
  policyFingerprint?: string;
  droidPolicySupport?: DroidCliReviewPolicySupport;
};

const preparedPolicyChecks = new WeakMap<object, PreparedPolicyCheckState>();
const copilotCliNodeBootstrapEnvKeys = ["NODE_OPTIONS", "NODE_PATH"];
const copilotCliPolicyEnvIgnoredKeys = [
  "APPDATA",
  "COPILOT_ALLOW_ALL",
  "COPILOT_AUTO_UPDATE",
  "COPILOT_CACHE_HOME",
  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
  "COPILOT_HOME",
  "COPILOT_OTEL_ENABLED",
  "GH_CONFIG_DIR",
  "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NODE_PATH",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
];

export function createCliAdapter(engine: CliEngine): ReviewAdapter {
  const spec = cliSpecs[engine];
  const capability = cliCapability(engine);
  return {
    name: `${engine}:cli`,
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      return prepareCliAdapter(engine, capability, input).then((prepared) => prepared.preflight);
    },
    async prepare(input: ReviewAdapterPreflightInput) {
      return prepareCliAdapter(engine, capability, input);
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      validateSupportedCliOverrides(engine, input.reviewer);
      const tempDir = await createCliTempDir(input, "diffwarden-cli-", {
        requireOutsideWorkspace: cliTempRootRequiresExternalWorkspace(engine),
      });
      try {
        const invocation = await spec.buildInvocation(input, tempDir);
        const executableSelection = cliExecutableSelection(
          input.reviewer,
          capability.defaultExecutable,
        );
        const runContext = cliRunContext(input.runContext);
        const preparedRunContext = canUsePreparedExecutable(
          invocation.executable,
          input,
          runContext,
        )
          ? runContext
          : undefined;
        if (preparedRunContext !== undefined) {
          invocation.resolvedExecutable = preparedRunContext.resolvedExecutable;
        }
        if (engine === "claude") {
          const preparedPolicyCheck = await hasPreparedPolicyCheck(
            engine,
            preparedRunContext,
            invocation,
            input,
          );
          await prepareClaudeCliInvocation(invocation, input, preparedPolicyCheck !== undefined);
        }
        if (engine === "gemini") {
          const preparedPolicyCheck = await hasPreparedPolicyCheck(
            engine,
            preparedRunContext,
            invocation,
            input,
          );
          await prepareGeminiCliInvocation(invocation, input, preparedPolicyCheck !== undefined);
        }
        if (engine === "copilot") {
          const preparedPolicyCheck = await hasPreparedPolicyCheck(
            engine,
            preparedRunContext,
            invocation,
            input,
          );
          await prepareCopilotCliInvocation(invocation, input, preparedPolicyCheck !== undefined);
        }
        if (engine === "droid") {
          const preparedPolicyCheck = await hasPreparedPolicyCheck(
            engine,
            preparedRunContext,
            invocation,
            input,
          );
          await prepareDroidCliInvocation(invocation, input, preparedPolicyCheck);
        }
        if (engine === "grok") {
          const preparedPolicyCheck = await hasPreparedPolicyCheck(
            engine,
            preparedRunContext,
            invocation,
            input,
          );
          await prepareGrokCliInvocation(invocation, input, preparedPolicyCheck !== undefined);
        }
        if (engine === "antigravity") {
          const preparedPolicyCheck = await hasPreparedPolicyCheck(
            engine,
            preparedRunContext,
            invocation,
            input,
          );
          await prepareAntigravityCliInvocation(
            invocation,
            input,
            preparedPolicyCheck !== undefined,
          );
        }
        const result = await runCli(invocation, input);
        const output = await spec.parseOutput(result, invocation);
        output.metadata = mergeResolutionMetadataRecords(
          cliSelectionMetadata(engine, input.reviewer),
          output.metadata,
          {
            transport: "cli",
            ...cliExecutableMetadata(executableSelection, result.executable),
            stderr: trimForMetadata(result.stderr),
          },
        );
        return output;
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  };
}

async function prepareCliAdapter(
  engine: CliEngine,
  capability: ReturnType<typeof cliCapability>,
  input: ReviewAdapterPreflightInput,
): Promise<{ preflight: ReviewAdapterPreflightResult; runContext: CliRunContext }> {
  validateSupportedCliOverrides(engine, input.reviewer);
  const executableSelection = cliExecutableSelection(input.reviewer, capability.defaultExecutable);
  const resolvedExecutable = await resolveExecutable(executableSelection.executable, input.env);
  const executableIdentity = await cliExecutableIdentity(resolvedExecutable);
  const metadata: ReviewAdapterPreflightResult["metadata"] = {
    readonlyCapability: capability.readonlyCapability,
    transport: "cli",
    ...cliExecutableMetadata(executableSelection, resolvedExecutable),
    ...cliSelectionMetadata(engine, input.reviewer),
  };
  const policyChecks: ReviewAdapterPreflightResult["checks"] = [];
  const verifiedPolicyChecks: CliPolicyCheckEngine[] = [];
  let policyCheckEnvFingerprint: string | undefined;
  let policyCheckFingerprint: string | undefined;
  let droidPolicySupport: DroidCliReviewPolicySupport | undefined;

  if (engine === "claude") {
    const policyEnv = input.env ?? process.env;
    await assertClaudeExecutableSupportsReviewPolicy(
      resolvedExecutable,
      policyEnv,
      claudeCliReviewPolicyCliFlags,
    );
    policyCheckEnvFingerprint = cliPolicyEnvFingerprint(policyEnv);
    verifiedPolicyChecks.push(engine);
    policyChecks.push({
      name: "claude-policy",
      status: "passed",
      detail: "Claude executable supports Diffwarden review policy flags.",
    });
  }
  if (engine === "gemini") {
    policyCheckEnvFingerprint = await assertGeminiExecutableSupportsReviewPolicyWithIsolatedTrust(
      resolvedExecutable,
      input,
    );
    verifiedPolicyChecks.push(engine);
    policyChecks.push({
      name: "gemini-policy",
      status: "passed",
      detail: "Gemini executable supports Diffwarden review policy flags.",
    });
  }
  if (engine === "copilot") {
    const requiredFlags = copilotCliReviewPolicyFlagsForArgs([
      ...copilotCliReviewPolicyCliFlags,
      ...(input.reviewer.model !== undefined ? ["--model"] : []),
      ...(input.reviewer.effort !== undefined ? ["--effort"] : []),
    ]);
    await assertCopilotCliExecutableOutsideWorkspace(resolvedExecutable, input);
    policyCheckEnvFingerprint = await assertCopilotExecutableSupportsReviewPolicyWithIsolatedHome(
      resolvedExecutable,
      input,
      requiredFlags,
    );
    verifiedPolicyChecks.push(engine);
    policyChecks.push({
      name: "copilot-policy",
      status: "passed",
      detail: "Copilot executable supports Diffwarden review policy flags.",
    });
    Object.assign(metadata, copilotReviewPolicyMetadata());
  }
  if (engine === "droid") {
    const policyEnv = input.env ?? process.env;
    const droidPolicyOptions = droidCliReviewPolicyOptions(input.reviewer, input.cwd);
    droidPolicySupport = await assertDroidExecutableSupportsReviewPolicy(
      resolvedExecutable,
      policyEnv,
      droidPolicyOptions,
    );
    policyCheckEnvFingerprint = cliPolicyEnvFingerprint(policyEnv);
    policyCheckFingerprint = droidCliReviewPolicyOptionsFingerprint(droidPolicyOptions);
    verifiedPolicyChecks.push(engine);
    policyChecks.push({
      name: "droid-policy",
      status: "passed",
      detail: "Droid executable supports Diffwarden review policy flags and tool allowlist.",
    });
    Object.assign(metadata, droidCliReviewPolicyMetadata());
  }
  if (engine === "grok") {
    const policyEnv = input.env ?? process.env;
    await assertGrokExecutableSupportsReviewPolicy(
      resolvedExecutable,
      policyEnv,
      grokCliReviewPolicyCliFlags,
    );
    policyCheckEnvFingerprint = cliPolicyEnvFingerprint(policyEnv);
    verifiedPolicyChecks.push(engine);
    policyChecks.push({
      name: "grok-policy",
      status: "passed",
      detail: "Grok executable supports Diffwarden review policy flags.",
    });
  }
  if (engine === "antigravity") {
    const policyEnv = input.env ?? process.env;
    await assertAntigravityExecutableSupportsReviewPolicy(resolvedExecutable, policyEnv);
    policyCheckEnvFingerprint = cliPolicyEnvFingerprint(policyEnv);
    verifiedPolicyChecks.push(engine);
    policyChecks.push({
      name: "antigravity-policy",
      status: "passed",
      detail: "Antigravity executable supports Diffwarden review policy settings.",
    });
  }

  const runContext: CliRunContext = {
    kind: "cli",
    requestedExecutable: executableSelection.executable,
    resolvedExecutable,
    ...pathContext(input.env),
  };
  if (verifiedPolicyChecks.length > 0 && policyCheckEnvFingerprint !== undefined) {
    preparedPolicyChecks.set(runContext, {
      policyChecks: new Set(verifiedPolicyChecks),
      resolvedExecutable,
      envFingerprint: policyCheckEnvFingerprint,
      ...(policyCheckFingerprint !== undefined
        ? { policyFingerprint: policyCheckFingerprint }
        : {}),
      ...(droidPolicySupport !== undefined ? { droidPolicySupport } : {}),
      ...(executableIdentity !== undefined
        ? { executableIdentity: { ...executableIdentity } }
        : {}),
    });
  }
  Object.freeze(runContext);

  return {
    preflight: {
      checks: [
        {
          name: "executable",
          status: "passed",
          detail: `Using ${resolvedExecutable}.`,
        },
        ...policyChecks,
        {
          name: "readonly",
          status: capability.readonlyCapability === "prompt-only" ? "warning" : "passed",
          detail: readonlyDetail(capability.readonlyCapability),
        },
        {
          name: "auth",
          status: "skipped",
          detail: "CLI authentication is delegated to the selected executable.",
        },
        {
          name: "model",
          status: input.reviewer.model === undefined ? "skipped" : "passed",
          detail:
            input.reviewer.model === undefined
              ? "No model override was requested."
              : `Passing model override to CLI: ${input.reviewer.model}.`,
        },
        {
          name: "effort",
          status: input.reviewer.effort === undefined ? "skipped" : "passed",
          detail:
            input.reviewer.effort === undefined
              ? "No effort override was requested."
              : `Passing effort override to CLI: ${input.reviewer.effort}.`,
        },
      ],
      metadata,
    },
    runContext,
  };
}

function cliRunContext(value: unknown): CliRunContext | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "cli" ||
    !("requestedExecutable" in value) ||
    typeof value.requestedExecutable !== "string" ||
    !("resolvedExecutable" in value) ||
    typeof value.resolvedExecutable !== "string"
  ) {
    return undefined;
  }

  return value as CliRunContext;
}

function canUsePreparedExecutable(
  executable: string,
  input: ReviewAdapterInput,
  runContext: CliRunContext | undefined,
): runContext is CliRunContext {
  return (
    runContext !== undefined &&
    runContext.requestedExecutable === executable &&
    runContext.path === pathContext(input.env).path
  );
}

async function hasPreparedPolicyCheck(
  engine: CliEngine,
  runContext: CliRunContext | undefined,
  invocation: CliInvocation,
  input: ReviewAdapterInput,
): Promise<PreparedPolicyCheckState | undefined> {
  if (!isCliPolicyCheckEngine(engine) || runContext === undefined) {
    return undefined;
  }
  const policyChecks = preparedPolicyChecks.get(runContext);
  if (policyChecks?.policyChecks.delete(engine) !== true) {
    return undefined;
  }
  if (policyChecks.policyChecks.size === 0) {
    preparedPolicyChecks.delete(runContext);
  }
  if (policyChecks.executableIdentity === undefined) {
    return undefined;
  }
  if (policyChecks.envFingerprint !== cliPolicyCheckRunEnvFingerprint(engine, invocation, input)) {
    return undefined;
  }
  if (
    policyChecks.policyFingerprint !== undefined &&
    policyChecks.policyFingerprint !== cliPolicyCheckRunPolicyFingerprint(engine, input)
  ) {
    return undefined;
  }
  const currentIdentity = await cliExecutableIdentity(policyChecks.resolvedExecutable);
  return sameCliExecutableIdentity(policyChecks.executableIdentity, currentIdentity)
    ? policyChecks
    : undefined;
}

function isCliPolicyCheckEngine(engine: CliEngine): engine is CliPolicyCheckEngine {
  return (
    engine === "antigravity" ||
    engine === "claude" ||
    engine === "copilot" ||
    engine === "droid" ||
    engine === "gemini" ||
    engine === "grok"
  );
}

async function cliExecutableIdentity(
  executable: string,
): Promise<CliExecutableIdentity | undefined> {
  try {
    const realExecutablePath = await realpath(executable);
    const stats = await stat(realExecutablePath);
    return {
      realpath: realExecutablePath,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function sameCliExecutableIdentity(
  expected: CliExecutableIdentity,
  actual: CliExecutableIdentity | undefined,
): boolean {
  return (
    actual !== undefined &&
    expected.realpath === actual.realpath &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

function cliPolicyCheckRunEnvFingerprint(
  engine: CliPolicyCheckEngine,
  invocation: CliInvocation,
  input: ReviewAdapterInput,
): string {
  return cliPolicyEnvFingerprint(
    cliInvocationEnv(invocation, input),
    cliPolicyEnvIgnoredKeys(engine),
  );
}

function cliPolicyEnvIgnoredKeys(engine: CliPolicyCheckEngine): string[] {
  if (engine === "gemini") {
    return [geminiCliTrustedFoldersPathEnvVar];
  }
  if (engine === "copilot") {
    return copilotCliPolicyEnvIgnoredKeys;
  }
  return [];
}

function cliPolicyCheckRunPolicyFingerprint(
  engine: CliPolicyCheckEngine,
  input: ReviewAdapterInput,
): string | undefined {
  if (engine !== "droid") {
    return undefined;
  }
  return droidCliReviewPolicyOptionsFingerprint(
    droidCliReviewPolicyOptions(input.reviewer, input.cwd),
  );
}

function cliPolicyEnvFingerprint(env: NodeJS.ProcessEnv, ignoredKeys: string[] = []): string {
  const ignored = new Set(ignoredKeys);
  const hash = createHash("sha256");
  for (const key of Object.keys(env).sort()) {
    if (ignored.has(key)) {
      continue;
    }
    hash.update(key);
    hash.update("\0");
    hash.update(env[key] ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertGeminiExecutableSupportsReviewPolicyWithIsolatedTrust(
  resolvedExecutable: string,
  input: ReviewAdapterPreflightInput,
): Promise<string> {
  const tempDir = await createCliTempDir(input, "diffwarden-gemini-preflight-");
  try {
    const trustedFoldersPath = path.join(tempDir, geminiCliReviewTrustedFoldersFileName);
    await writeFile(trustedFoldersPath, "{}\n", "utf8");
    const env = {
      ...(input.env ?? process.env),
      [geminiCliTrustedFoldersPathEnvVar]: trustedFoldersPath,
    };
    Reflect.deleteProperty(env, geminiCliTrustWorkspaceEnvVar);
    await assertGeminiExecutableSupportsReviewPolicy(
      resolvedExecutable,
      env,
      geminiCliReviewPolicyCliFlags,
    );
    return cliPolicyEnvFingerprint(env, [geminiCliTrustedFoldersPathEnvVar]);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function assertCopilotExecutableSupportsReviewPolicyWithIsolatedHome(
  resolvedExecutable: string,
  input: ReviewAdapterPreflightInput,
  requiredFlags: readonly string[],
): Promise<string> {
  const tempDir = await createCliTempDir(input, "diffwarden-copilot-preflight-", {
    requireOutsideWorkspace: true,
  });
  try {
    const env = await copilotCliPolicyProbeEnv(input, tempDir);
    await assertCopilotExecutableSupportsReviewPolicy(resolvedExecutable, env, requiredFlags);
    return cliPolicyEnvFingerprint(env, cliPolicyEnvIgnoredKeys("copilot"));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function copilotCliPolicyProbeEnv(
  input: ReviewAdapterPreflightInput,
  tempDir: string,
): Promise<NodeJS.ProcessEnv> {
  const home = path.join(tempDir, "copilot-home");
  const copilotHome = path.join(home, ".copilot");
  const ghConfigDir = path.join(home, ".config", "gh");
  const toolOutputTempDir = path.join(tempDir, "copilot-tool-output-temp");
  await Promise.all([
    mkdir(copilotHome, { recursive: true }),
    mkdir(ghConfigDir, { recursive: true }),
    mkdir(path.join(home, ".cache", "copilot"), { recursive: true }),
    mkdir(path.join(home, ".local", "state"), { recursive: true }),
    mkdir(path.join(home, "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(home, "AppData", "Local"), { recursive: true }),
    mkdir(toolOutputTempDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(copilotHome, "config.json"), "{}\n", "utf8"),
    writeFile(path.join(copilotHome, "settings.json"), "{}\n", "utf8"),
    writeFile(path.join(copilotHome, "mcp-config.json"), "{}\n", "utf8"),
  ]);

  return scrubCliEnvKeys(
    {
      ...(input.env ?? process.env),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      GH_CONFIG_DIR: ghConfigDir,
      COPILOT_HOME: copilotHome,
      COPILOT_CACHE_HOME: path.join(home, ".cache", "copilot"),
      COPILOT_AUTO_UPDATE: "false",
      COPILOT_OTEL_ENABLED: "false",
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
      TMPDIR: toolOutputTempDir,
      TMP: toolOutputTempDir,
      TEMP: toolOutputTempDir,
    },
    [
      "COPILOT_ALLOW_ALL",
      "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
      "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
      "HOMEDRIVE",
      "HOMEPATH",
      ...copilotCliNodeBootstrapEnvKeys,
    ],
  );
}

async function createCliTempDir(
  input: ReviewAdapterInput | ReviewAdapterPreflightInput,
  prefix: string,
  options: { requireOutsideWorkspace?: boolean } = {},
): Promise<string> {
  const parent = cliTempRoot(input.env, input.cwd);
  if (
    options.requireOutsideWorkspace === true &&
    (await pathIsInsideReviewWorkspace(cliTempReviewRoots(input), parent))
  ) {
    throw reviewerFailed(
      "CLI temporary directory resolved inside the review workspace; set TMPDIR, TMP, or TEMP outside the repository before running CLI reviews.",
    );
  }
  await mkdir(parent, { recursive: true });
  return await mkdtemp(path.join(parent, prefix));
}

function cliTempRootRequiresExternalWorkspace(engine: CliEngine): boolean {
  return engine === "copilot" || engine === "antigravity";
}

function cliTempRoot(env: NodeJS.ProcessEnv | undefined, cwd: string): string {
  const effectiveEnv = env ?? process.env;
  const configured =
    effectiveEnv.TMPDIR?.trim() || effectiveEnv.TMP?.trim() || effectiveEnv.TEMP?.trim();
  if (configured !== undefined && configured !== "") {
    return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
  }
  return tmpdir();
}

function cliTempReviewRoots(input: ReviewAdapterInput | ReviewAdapterPreflightInput): string[] {
  const repoRoot = "target" in input ? input.target.repo_root : input.repoRoot;
  return [repoRoot, input.cwd].filter((root): root is string => Boolean(root));
}

async function pathIsInsideReviewWorkspace(
  reviewRoots: readonly string[],
  candidatePath: string,
): Promise<boolean> {
  const candidate = await realpathOrResolve(candidatePath);
  for (const reviewRoot of new Set(reviewRoots.filter(Boolean))) {
    if (isPathInside(await realpathOrResolve(reviewRoot), candidate)) {
      return true;
    }
  }
  return false;
}

async function realpathOrResolve(inputPath: string): Promise<string> {
  try {
    return await realpath(inputPath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      const resolved = path.resolve(inputPath);
      const parent = path.dirname(resolved);
      if (parent === resolved) {
        return resolved;
      }
      return path.join(await realpathOrResolve(parent), path.basename(resolved));
    }
    throw error;
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function prepareClaudeCliInvocation(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
  policyAlreadyChecked = false,
): Promise<void> {
  const env = cliInvocationEnv(invocation, input);
  invocation.resolvedExecutable =
    invocation.resolvedExecutable ?? (await resolveExecutable(invocation.executable, env));
  if (policyAlreadyChecked) {
    return;
  }
  await assertClaudeExecutableSupportsReviewPolicy(
    invocation.resolvedExecutable,
    env,
    claudeCliReviewPolicyCliFlags,
  );
}

async function prepareGeminiCliInvocation(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
  policyAlreadyChecked = false,
): Promise<void> {
  const env = cliInvocationEnv(invocation, input);
  invocation.resolvedExecutable =
    invocation.resolvedExecutable ?? (await resolveExecutable(invocation.executable, env));
  if (policyAlreadyChecked) {
    return;
  }
  await assertGeminiExecutableSupportsReviewPolicy(
    invocation.resolvedExecutable,
    env,
    geminiCliReviewPolicyCliFlags,
  );
}

async function prepareDroidCliInvocation(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
  preparedPolicyCheck: PreparedPolicyCheckState | undefined,
): Promise<void> {
  const env = cliInvocationEnv(invocation, input);
  invocation.resolvedExecutable =
    invocation.resolvedExecutable ?? (await resolveExecutable(invocation.executable, env));
  const support =
    preparedPolicyCheck?.droidPolicySupport ??
    (await assertDroidExecutableSupportsReviewPolicy(
      invocation.resolvedExecutable,
      env,
      droidCliReviewPolicyOptions(input.reviewer, input.cwd),
    ));
  applyDroidCliPolicySupport(invocation, support);
}

async function prepareCopilotCliInvocation(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
  policyAlreadyChecked = false,
): Promise<void> {
  const env = cliInvocationEnv(invocation, input);
  invocation.resolvedExecutable =
    invocation.resolvedExecutable ?? (await resolveExecutable(invocation.executable, env));
  await assertCopilotCliExecutableOutsideWorkspace(invocation.resolvedExecutable, input);
  const requiredFlags = copilotCliReviewPolicyFlagsForArgs(invocation.args);
  if (policyAlreadyChecked && requiredFlags.length === copilotCliReviewPolicyCliFlags.length) {
    return;
  }
  await assertCopilotExecutableSupportsReviewPolicy(
    invocation.resolvedExecutable,
    env,
    requiredFlags,
  );
}

function applyDroidCliPolicySupport(
  invocation: CliInvocation,
  support: DroidCliReviewPolicySupport,
): void {
  if (support.logGroupId) {
    return;
  }

  const index = invocation.args.indexOf("--log-group-id");
  if (index !== -1) {
    invocation.args.splice(index, 2);
  }
  invocation.droidLogGroupId = undefined;
}

function droidCliReviewPolicyOptions(
  reviewer: ReviewReviewerConfig,
  cwd: string,
): DroidCliReviewPolicyOptions {
  const model = providerQualifiedModel(reviewer);
  const effort =
    reviewer.effort !== undefined && reviewer.effort !== "off"
      ? droidCliEffort(reviewer.effort)
      : undefined;
  return {
    cwd,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

function droidCliReviewPolicyOptionsFingerprint(options: DroidCliReviewPolicyOptions): string {
  return JSON.stringify({
    cwd: options.cwd,
    model: options.model,
    effort: options.effort,
  });
}

async function prepareGrokCliInvocation(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
  policyAlreadyChecked = false,
): Promise<void> {
  const env = cliInvocationEnv(invocation, input);
  invocation.resolvedExecutable =
    invocation.resolvedExecutable ?? (await resolveExecutable(invocation.executable, env));
  if (policyAlreadyChecked) {
    return;
  }
  await assertGrokExecutableSupportsReviewPolicy(
    invocation.resolvedExecutable,
    env,
    grokCliReviewPolicyCliFlags,
  );
}

async function prepareAntigravityCliInvocation(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
  policyAlreadyChecked = false,
): Promise<void> {
  const env = cliInvocationEnv(invocation, input);
  invocation.resolvedExecutable =
    invocation.resolvedExecutable ?? (await resolveExecutable(invocation.executable, env));
  if (policyAlreadyChecked) {
    return;
  }
  await assertAntigravityExecutableSupportsReviewPolicy(invocation.resolvedExecutable, env);
}

async function assertCopilotCliExecutableOutsideWorkspace(
  resolvedExecutable: string,
  input: ReviewAdapterInput | ReviewAdapterPreflightInput,
): Promise<void> {
  // The support probe executes before Copilot's own tool policy applies, so reject repo wrappers.
  if (await pathIsInsideReviewWorkspace(cliTempReviewRoots(input), resolvedExecutable)) {
    throw reviewerFailed(
      "Copilot CLI executable resolved inside the review workspace; install Copilot outside the repository or set cliOptions.executable to an external binary.",
    );
  }
}

function cliInvocationEnv(
  invocation: CliInvocation,
  input: Pick<ReviewAdapterInput, "env">,
): NodeJS.ProcessEnv {
  const env = {
    ...(input.env ?? process.env),
    ...invocation.env,
  };

  for (const key of invocation.unsetEnv ?? []) {
    deleteCliEnvKey(env, key);
  }

  return env;
}

function scrubCliEnvKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of keys) {
    deleteCliEnvKey(next, key);
  }
  return next;
}

function deleteCliEnvKey(env: NodeJS.ProcessEnv, key: string): void {
  Reflect.deleteProperty(env, key);
  const normalized = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === normalized) {
      Reflect.deleteProperty(env, existingKey);
    }
  }
}

function pathContext(env: NodeJS.ProcessEnv | undefined): { path?: string } {
  const value = (env ?? process.env).PATH;
  return value === undefined ? {} : { path: value };
}

function validateSupportedCliOverrides(engine: CliEngine, reviewer: ReviewReviewerConfig): void {
  const capability = cliCapability(engine);
  if (!capability.supportsModel && reviewer.model !== undefined) {
    throw invalidCli(`${engine} CLI transport does not support per-run model overrides`);
  }
  if (!capability.supportsEffort && reviewer.effort !== undefined) {
    throw invalidCli(`${engine} CLI transport does not support per-run effort overrides`);
  }
}

function cliSelectionMetadata(
  engine: CliEngine,
  reviewer: ReviewReviewerConfig,
): Record<string, string> {
  const model = providerQualifiedModel(reviewer);
  const effort = cliEffortResolution(engine, reviewer);

  return {
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(model !== undefined
      ? modelResolutionMetadata({
          requested: model,
          resolved: model,
          source: reviewer.modelSource ?? "requested",
        })
      : {}),
    ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
    ...(effort !== undefined
      ? effortResolutionMetadata({
          requested: reviewer.effort,
          resolved: effort.resolved,
          source: effort.source,
        })
      : {}),
    ...(engine === "codex" ? codexWebSearchMetadata(codexCliWebSearchPolicy(reviewer)) : {}),
  };
}

function cliEffortResolution(
  engine: CliEngine,
  reviewer: ReviewReviewerConfig,
): { resolved?: string; source: ResolutionSource } | undefined {
  const effort = reviewer.effort;
  if (effort === undefined) {
    return undefined;
  }

  if (effort === "off" && cliOmitsOffEffort(engine)) {
    return {
      source: "adapter-selection",
    };
  }

  const resolved = cliResolvedEffort(engine, effort);
  return {
    resolved,
    source: resolved === effort ? (reviewer.effortSource ?? "requested") : "adapter-selection",
  };
}

function cliOmitsOffEffort(engine: CliEngine): boolean {
  return ["claude", "codex", "droid", "grok", "opencode"].includes(engine);
}

function cliResolvedEffort(engine: CliEngine, effort: string): string {
  if (engine === "claude") {
    return effort === "off" ? "off" : claudeCliEffort(effort);
  }
  if (engine === "droid") {
    return effort === "off" ? "off" : droidCliEffort(effort);
  }
  if (engine === "copilot") {
    return copilotCliEffort(effort);
  }
  if (engine === "grok") {
    return effort === "off" ? "off" : grokCliEffort(effort);
  }
  return effort;
}

function readonlyDetail(
  capability: NonNullable<ReviewAdapterOutput["metadata"]>["readonlyCapability"],
): string {
  if (capability === "enforced") {
    return "CLI invocation includes an engine-level read-only sandbox.";
  }
  if (capability === "tool-restricted") {
    return "CLI invocation restricts available tools to read-oriented review operations.";
  }
  return "CLI invocation uses the most restrictive documented mode, but read-only behavior is prompt-dependent.";
}
