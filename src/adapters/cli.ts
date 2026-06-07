import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalidCli } from "../core/errors.js";
import { claudeCliReviewPolicyCliFlags } from "./claude-tool-policy.js";
import { assertClaudeExecutableSupportsReviewPolicy } from "./claude.js";
import {
  claudeCliEffort,
  cliCapability,
  cliExecutableMetadata,
  cliExecutableSelection,
  droidCliEffort,
  grokCliEffort,
  providerQualifiedModel,
} from "./cli-helpers.js";
import { resolveExecutable, runCli, trimForMetadata } from "./cli-process.js";
import { cliSpecs } from "./cli-specs.js";
import type { CliEngine, CliInvocation } from "./cli-types.js";
import { codexCliWebSearchPolicy, codexWebSearchMetadata } from "./codex-options.js";
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

type CliPolicyCheckEngine = Extract<CliEngine, "claude" | "gemini" | "grok">;
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
};

const preparedPolicyChecks = new WeakMap<object, PreparedPolicyCheckState>();

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
      const tempDir = await mkdtemp(path.join(tmpdir(), "diffwarden-cli-"));
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
          await prepareClaudeCliInvocation(
            invocation,
            input,
            await hasPreparedPolicyCheck(engine, preparedRunContext, invocation, input),
          );
        }
        if (engine === "gemini") {
          await prepareGeminiCliInvocation(
            invocation,
            input,
            await hasPreparedPolicyCheck(engine, preparedRunContext, invocation, input),
          );
        }
        if (engine === "grok") {
          await prepareGrokCliInvocation(
            invocation,
            input,
            await hasPreparedPolicyCheck(engine, preparedRunContext, invocation, input),
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
): Promise<boolean> {
  if (!isCliPolicyCheckEngine(engine) || runContext === undefined) {
    return false;
  }
  const policyChecks = preparedPolicyChecks.get(runContext);
  if (policyChecks?.policyChecks.delete(engine) !== true) {
    return false;
  }
  if (policyChecks.policyChecks.size === 0) {
    preparedPolicyChecks.delete(runContext);
  }
  if (policyChecks.executableIdentity === undefined) {
    return false;
  }
  if (policyChecks.envFingerprint !== cliPolicyCheckRunEnvFingerprint(engine, invocation, input)) {
    return false;
  }
  const currentIdentity = await cliExecutableIdentity(policyChecks.resolvedExecutable);
  return sameCliExecutableIdentity(policyChecks.executableIdentity, currentIdentity);
}

function isCliPolicyCheckEngine(engine: CliEngine): engine is CliPolicyCheckEngine {
  return engine === "claude" || engine === "gemini" || engine === "grok";
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
    engine === "gemini" ? [geminiCliTrustedFoldersPathEnvVar] : [],
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
  const tempDir = await mkdtemp(path.join(tmpdir(), "diffwarden-gemini-preflight-"));
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

function cliInvocationEnv(
  invocation: CliInvocation,
  input: Pick<ReviewAdapterInput, "env">,
): NodeJS.ProcessEnv {
  const env = {
    ...(input.env ?? process.env),
    ...invocation.env,
  };

  for (const key of invocation.unsetEnv ?? []) {
    Reflect.deleteProperty(env, key);
  }

  return env;
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
