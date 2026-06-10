import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import { normalizeJsonLikeAdapterOutput } from "../core/adapter-output.js";
import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import { tryGetRepoRoot } from "../core/git.js";
import { providerQualifiedModel } from "./cli-helpers.js";
import { execCliFile, resolveExecutable } from "./cli-process.js";
import {
  copilotCliReviewPolicyCliFlags,
  copilotReviewExcludedTools,
  copilotReviewPolicyMetadata,
  copilotSdkReviewAvailableTools,
  createCopilotSdkPermissionHandler,
} from "./copilot-tool-policy.js";
import {
  effortResolutionMetadata,
  modelResolutionMetadata,
  sdkOutputMetadata,
  sdkPreflightMetadata,
} from "./metadata.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerConfig,
} from "./types.js";

// Preflight imports this package directly so broken/missing published entrypoints fail before run.
const copilotPackageName = "@github/copilot-sdk";
const defaultCopilotExecutable = "copilot";
const copilotRuntimeArgs = ["--no-auto-update", "--no-remote"];
const maxSdkWaitMs = 2_147_483_647;
const copilotIdleWithoutAssistantMessageSettleMs = 250;
const require = createRequire(import.meta.url);
const copilotAuthStateKeys = new Set([
  "copilotTokens",
  "lastLoggedInUser",
  "loggedInUsers",
  "staff",
]);
const copilotSdkProcessEnvUnsetKeys = [
  // Keep the staged HOME/COPILOT_HOME/GH_CONFIG_DIR/TMP* values built below;
  // this list only removes ambient escape hatches and runtime bootstrap hooks.
  "COPILOT_ALLOW_ALL",
  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
  "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
  "HOMEDRIVE",
  "HOMEPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
];

type CopilotSdk = typeof import("@github/copilot-sdk");

type CopilotAdapterDependencies = {
  loadSdk: () => Promise<CopilotSdk>;
  readPackageVersion: () => Promise<string | undefined>;
  resolveBundledRuntimeExecutable: () => Promise<string>;
};

type CopilotRunContext = {
  kind: "copilot";
  packageVersion?: string;
};

type CopilotSessionResult = {
  content: string;
  usage?: unknown;
  model?: string;
  effort?: string;
};

type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";

type CopilotRunDeadline = {
  expiresAtMs?: number;
};

type CopilotStagedBaseDirectory = {
  sourceBaseDirectory: string;
  baseDirectory: string;
  ghConfigDir: string;
  homeDirectory: string;
  toolOutputTempDir: string;
  tempRoot: string;
  cleanup(): Promise<void>;
};

type CopilotReviewSessionConfig = SessionConfig & {
  enableSkills?: boolean;
  disabledSkills?: string[];
  installedPlugins?: [];
  enableFileHooks?: boolean;
  enableHostGitOperations?: boolean;
  enableSessionStore?: boolean;
};

const defaultCopilotAdapterDependencies: CopilotAdapterDependencies = {
  loadSdk: loadCopilotSdk,
  readPackageVersion: readCopilotPackageVersion,
  resolveBundledRuntimeExecutable: resolveCopilotBundledRuntimeExecutable,
};

export function createCopilotAdapter(
  dependencies: CopilotAdapterDependencies = defaultCopilotAdapterDependencies,
): ReviewAdapter {
  return {
    name: "copilot",
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      return (await prepareCopilotAdapter(dependencies, input)).preflight;
    },
    async prepare(input: ReviewAdapterPreflightInput) {
      return prepareCopilotAdapter(dependencies, input);
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const sdk = await dependencies.loadSdk();
      const packageVersion =
        copilotRunContext(input.runContext)?.packageVersion ??
        (await dependencies.readPackageVersion());
      const reviewRoot = copilotReviewRoot(input);
      const sourcePathRoot = copilotSourcePathRoot(input);
      const executable = copilotSdkExecutable(input.reviewer);
      const resolvedExecutable =
        executable === undefined
          ? await dependencies.resolveBundledRuntimeExecutable()
          : await resolveCopilotRuntimeExecutable(executable, input.env, sourcePathRoot);
      assertCopilotRuntimeLaunchCommandSupported(resolvedExecutable);
      const sourceBaseDirectory = resolveCopilotReviewPath(
        requiredCopilotBaseDirectory(input.reviewer, input.env),
        sourcePathRoot,
      );
      const reviewRoots = [reviewRoot, input.target.repo_root];
      await assertCopilotBaseDirectoryOutsideWorkspace(reviewRoots, sourceBaseDirectory);
      // Even the adapter-default bundled runtime is executable code from the reviewed tree
      // in project-local installs, so fail closed and require an external runtime or CLI.
      await assertCopilotRuntimeOutsideWorkspace(reviewRoots, resolvedExecutable);
      await assertCopilotGithubAuthDirsOutsideWorkspace(reviewRoots, sourcePathRoot, input.env);
      const stagedBaseDirectory = await stageCopilotSdkBaseDirectory(
        sourceBaseDirectory,
        reviewRoots,
        input.env,
        sourcePathRoot,
      );
      const env = copilotProcessEnv(
        input.env,
        stagedBaseDirectory.baseDirectory,
        stagedBaseDirectory.ghConfigDir,
        stagedBaseDirectory.homeDirectory,
        stagedBaseDirectory.toolOutputTempDir,
      );
      const deadline = createCopilotRunDeadline(input.timeoutMs);
      let client: CopilotClient | undefined;
      let session: CopilotSession | undefined;

      try {
        const constructedClient = new sdk.CopilotClient(
          copilotClientOptions(
            sdk,
            input,
            env,
            stagedBaseDirectory.baseDirectory,
            resolvedExecutable,
            reviewRoot,
          ),
        );
        client = constructedClient;
        session = await withCopilotDeadline({
          signal: input.signal,
          deadline,
          timeoutMessage: "Copilot reviewer timed out starting session",
          abortMessage: "Copilot reviewer aborted before session startup",
          operation: () =>
            constructedClient.createSession(
              copilotSessionConfig(input, reviewRoot, stagedBaseDirectory.toolOutputTempDir),
            ),
          onCancel: () => constructedClient.stop(),
          onLateValue: (lateSession) => lateSession.disconnect(),
        });
        const result = await runCopilotSession(session, input, deadline);
        const output = normalizeJsonLikeAdapterOutput(
          result.content,
          copilotOutputMetadata(input.reviewer, {
            baseDirectory: stagedBaseDirectory.baseDirectory,
            sourceBaseDirectory: stagedBaseDirectory.sourceBaseDirectory,
            executable,
            resolvedExecutable,
            runtimeSource: executable === undefined ? "sdk-bundled" : "config",
            packageVersion,
            model: result.model,
            effort: result.effort,
          }),
        );
        if (result.usage !== undefined) {
          output.usage = result.usage;
        }
        return output;
      } catch (error) {
        if (error instanceof DiffwardenError) {
          throw error;
        }

        const detail = errorMessage(error);
        if (isCopilotAuthFailure(detail)) {
          throw missingAuth(`Copilot authentication failed: ${detail}`);
        }
        throw reviewerFailed(`Copilot reviewer failed: ${detail}`);
      } finally {
        await session?.disconnect().catch(() => undefined);
        await client?.stop().catch(() => []);
        await stagedBaseDirectory.cleanup().catch(() => undefined);
      }
    },
  };
}

async function prepareCopilotAdapter(
  dependencies: CopilotAdapterDependencies,
  input: ReviewAdapterPreflightInput,
): Promise<{ preflight: ReviewAdapterPreflightResult; runContext: CopilotRunContext }> {
  await dependencies.loadSdk();
  const packageVersion = await dependencies.readPackageVersion();
  const reviewRoot = await copilotPreflightReviewRoot(input);
  const sourcePathRoot = copilotSourcePathRoot(input);
  const baseDirectory = resolveCopilotReviewPath(
    requiredCopilotBaseDirectory(input.reviewer, input.env),
    sourcePathRoot,
  );
  const executable = copilotSdkExecutable(input.reviewer);
  const resolvedExecutable =
    executable === undefined
      ? await dependencies.resolveBundledRuntimeExecutable()
      : await resolveCopilotRuntimeExecutable(executable, input.env, sourcePathRoot);
  assertCopilotRuntimeLaunchCommandSupported(resolvedExecutable);
  await assertCopilotBaseDirectoryOutsideWorkspace([reviewRoot, input.cwd], baseDirectory);
  // Even the adapter-default bundled runtime is executable code from the reviewed tree
  // in project-local installs, so fail closed and require an external runtime or CLI.
  await assertCopilotRuntimeOutsideWorkspace([reviewRoot, input.cwd], resolvedExecutable);
  await assertCopilotGithubAuthDirsOutsideWorkspace(
    [reviewRoot, input.cwd],
    sourcePathRoot,
    input.env,
  );
  const effort = copilotSdkEffort(input.reviewer.effort);

  return {
    preflight: {
      checks: [
        {
          name: "sdk",
          status: "passed",
          detail: `${copilotPackageName} loaded successfully.`,
        },
        {
          name: "auth",
          status: "skipped",
          detail:
            "Copilot SDK authentication is delegated to the Copilot runtime and stored Copilot/GitHub credentials.",
        },
        {
          name: "runtime",
          status: "passed",
          detail:
            executable === undefined
              ? `Copilot SDK bundled runtime resolved: ${resolvedExecutable}.`
              : `Copilot SDK executable resolved: ${resolvedExecutable}.`,
        },
        {
          name: "readonly",
          status: "passed",
          detail:
            "Copilot SDK sessions use empty-mode defaults, read/search tool allowlisting, and a deny-by-default permission handler.",
        },
        {
          name: "tools",
          status: "passed",
          detail: "Copilot review tools are restricted to view/read_file/file_search/grep_search.",
        },
        {
          name: "model",
          status: input.reviewer.model === undefined ? "skipped" : "passed",
          detail:
            input.reviewer.model === undefined
              ? "Using Copilot's default model."
              : `Passing model override to Copilot: ${providerQualifiedModel(input.reviewer)}.`,
        },
        {
          name: "effort",
          status: effort === undefined ? "skipped" : "passed",
          detail:
            effort === undefined
              ? "No SDK reasoning effort override was requested."
              : `Passing reasoning effort to Copilot: ${effort}.`,
        },
      ],
      metadata: sdkPreflightMetadata("copilot", {
        ...copilotReviewPolicyMetadata(),
        ...(packageVersion !== undefined ? { sdkVersion: packageVersion } : {}),
        ...(input.reviewer.model !== undefined ? { model: input.reviewer.model } : {}),
        ...copilotModelMetadata(input.reviewer),
        ...copilotSdkEffortMetadata(input.reviewer),
        copilotBaseDirectory: baseDirectory,
        copilotBaseDirectorySource: copilotBaseDirectorySource(input.reviewer, input.env),
        copilotRuntimeSource: executable === undefined ? "sdk-bundled" : "config",
        ...(executable !== undefined ? { executable } : {}),
        resolvedExecutable,
      }),
    },
    runContext: {
      kind: "copilot",
      ...(packageVersion !== undefined ? { packageVersion } : {}),
    },
  };
}

async function copilotPreflightReviewRoot(input: ReviewAdapterPreflightInput): Promise<string> {
  return input.repoRoot ?? (await tryGetRepoRoot(input.cwd)) ?? input.cwd;
}

export const copilotAdapter = createCopilotAdapter();

export async function assertCopilotExecutableSupportsReviewPolicy(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  requiredFlags: readonly string[] = copilotCliReviewPolicyCliFlags,
): Promise<void> {
  let output: string;
  try {
    const { stdout, stderr } = await execCliFile(executable, ["--help"], {
      ...(env !== undefined ? { env } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    output = `${stdout}${stderr}`;
  } catch (error) {
    throw missingRequirement(`Copilot executable policy preflight failed: ${errorMessage(error)}`);
  }

  const missingFlags = requiredFlags.filter((flag) => !helpOutputHasFlag(output, flag));
  if (missingFlags.length) {
    throw missingRequirement(
      `Copilot executable does not support Diffwarden review policy flags: ${missingFlags.join(", ")}. Upgrade GitHub Copilot CLI or configure a newer executable.`,
    );
  }
}

async function loadCopilotSdk(): Promise<CopilotSdk> {
  try {
    return await import("@github/copilot-sdk");
  } catch (error) {
    throw missingRequirement(`Failed to load ${copilotPackageName}: ${errorMessage(error)}`);
  }
}

async function readCopilotPackageVersion(): Promise<string | undefined> {
  const packageRoot = await copilotSdkPackageRoot();
  if (packageRoot === undefined) {
    return undefined;
  }

  const packageJson = await readCopilotPackageJson(packageRoot);
  return typeof packageJson?.version === "string" ? packageJson.version : undefined;
}

async function copilotSdkPackageRoot(): Promise<string | undefined> {
  try {
    const entryPath = require.resolve(copilotPackageName);
    let directory = path.dirname(entryPath);
    while (true) {
      const packageJson = await readCopilotPackageJson(directory);
      if (packageJson?.name === copilotPackageName) {
        return directory;
      }

      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  } catch {
    return undefined;
  }
}

export async function resolveCopilotBundledRuntimeExecutable(): Promise<string> {
  const packageRoot = await copilotSdkPackageRoot();
  if (packageRoot === undefined) {
    throw missingRequirement(
      `Failed to locate ${copilotPackageName} package root for bundled Copilot runtime.`,
    );
  }

  // Resolution may find a project-local runtime; review-root launch policy decides if it is safe.
  const runtime = await firstReadableFile(copilotBundledRuntimeCandidates(packageRoot));
  if (runtime === undefined) {
    throw missingRequirement(
      `Copilot SDK bundled runtime was not found. Reinstall dependencies so ${copilotPackageName}'s @github/copilot dependency is available.`,
    );
  }
  return runtime;
}

function copilotBundledRuntimeCandidates(packageRoot: string): string[] {
  const sdkRequire = createRequire(path.join(packageRoot, "package.json"));
  const searchPaths = sdkRequire.resolve.paths("@github/copilot") ?? [];
  // @github/copilot hides index.js behind package exports; direct candidates handle pnpm links.
  return [
    path.join(path.dirname(packageRoot), "copilot", "index.js"),
    ...searchPaths.map((base) => path.join(base, "@github", "copilot", "index.js")),
  ];
}

async function firstReadableFile(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Keep searching Node's package resolution paths.
    }
  }
  return undefined;
}

async function stageCopilotSdkBaseDirectory(
  sourceBaseDirectory: string,
  reviewRoots: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  sourcePathRoot: string,
): Promise<CopilotStagedBaseDirectory> {
  const tempParent = copilotTempRoot(env, sourcePathRoot);
  if (await pathIsInsideReviewWorkspace(reviewRoots, tempParent)) {
    throw reviewerFailed(
      "Copilot SDK isolated base directory resolved inside the review workspace; set TMPDIR, TMP, or TEMP outside the repository before running Copilot SDK reviews.",
    );
  }
  await mkdir(tempParent, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempParent, "diffwarden-copilot-sdk-"));
  const baseDirectory = path.join(tempRoot, "base");
  const ghConfigDir = path.join(tempRoot, "gh");
  const homeDirectory = path.join(tempRoot, "home");
  const toolOutputTempDir = path.join(tempRoot, "tool-output-temp");
  try {
    if (await pathIsInsideReviewWorkspace(reviewRoots, baseDirectory)) {
      throw reviewerFailed(
        "Copilot SDK isolated base directory resolved inside the review workspace; set TMPDIR, TMP, or TEMP outside the repository before running Copilot SDK reviews.",
      );
    }
    await mkdir(baseDirectory, { recursive: true });
    await mkdir(ghConfigDir, { recursive: true });
    await mkdir(toolOutputTempDir, { recursive: true });
    await mkdir(path.join(homeDirectory, ".config"), { recursive: true });
    await mkdir(path.join(homeDirectory, ".local", "state"), { recursive: true });
    await mkdir(path.join(homeDirectory, ".cache"), { recursive: true });
    await mkdir(path.join(homeDirectory, "AppData", "Roaming"), { recursive: true });
    await mkdir(path.join(homeDirectory, "AppData", "Local"), { recursive: true });
    await stageCopilotSdkGithubAuthState(
      env,
      reviewRoots,
      sourcePathRoot,
      ghConfigDir,
      homeDirectory,
    );
    await writeCopilotJson(
      path.join(baseDirectory, "config.json"),
      await readCopilotSdkAuthState(sourceBaseDirectory),
    );
    await writeCopilotJson(path.join(baseDirectory, "settings.json"), copilotSdkReviewSettings());
    await writeFile(path.join(baseDirectory, "mcp-config.json"), "{}\n", "utf8");
  } catch (error) {
    await rm(tempRoot, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }

  return {
    sourceBaseDirectory,
    baseDirectory,
    ghConfigDir,
    homeDirectory,
    toolOutputTempDir,
    tempRoot,
    cleanup: () => rm(tempRoot, { force: true, recursive: true }),
  };
}

function copilotTempRoot(env: NodeJS.ProcessEnv | undefined, sourcePathRoot: string): string {
  const effectiveEnv = env ?? process.env;
  const configured =
    effectiveEnv.TMPDIR?.trim() || effectiveEnv.TMP?.trim() || effectiveEnv.TEMP?.trim();
  if (configured !== undefined && configured !== "") {
    return path.isAbsolute(configured) ? configured : path.resolve(sourcePathRoot, configured);
  }
  return tmpdir();
}

async function readCopilotSdkAuthState(
  sourceBaseDirectory: string,
): Promise<Record<string, unknown>> {
  const filtered: Record<string, unknown> = {};
  for (const filename of ["config.json", "config"]) {
    let parsed: unknown;
    try {
      const raw = await readFile(path.join(sourceBaseDirectory, filename), "utf8");
      parsed = parseCopilotAuthConfig(raw, filename);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (
        copilotAuthStateKeys.has(key) &&
        !hasCopilotAuthValue(filtered[key]) &&
        hasCopilotAuthValue(value)
      ) {
        filtered[key] = value;
      }
    }
  }
  return filtered;
}

async function stageCopilotSdkGithubAuthState(
  env: NodeJS.ProcessEnv | undefined,
  reviewRoots: readonly string[],
  sourcePathRoot: string,
  isolatedGhConfigDir: string,
  isolatedHome: string,
): Promise<void> {
  const sourceHosts = copilotGithubAuthDirs(env, sourcePathRoot).map((dir) =>
    path.join(dir, "hosts.yml"),
  );
  const sourceHost = await firstPresentFile(sourceHosts);
  if (sourceHost === undefined) {
    return;
  }
  const sourceDir = path.dirname(sourceHost);
  if (await pathIsInsideReviewWorkspace(reviewRoots, sourceDir)) {
    throw reviewerFailed(
      "Copilot SDK GitHub CLI auth state resolved inside the review workspace; set GH_CONFIG_DIR, XDG_CONFIG_HOME, HOME, or USERPROFILE outside the repository before running Copilot SDK reviews.",
    );
  }
  const isolatedHomeGhConfigDir = path.join(isolatedHome, ".config", "gh");
  const isolatedWindowsGhConfigDir = path.join(isolatedHome, "AppData", "Roaming", "GitHub CLI");
  await mkdir(isolatedHomeGhConfigDir, { recursive: true });
  await mkdir(isolatedWindowsGhConfigDir, { recursive: true });
  await copyFile(sourceHost, path.join(isolatedGhConfigDir, "hosts.yml"));
  await copyFile(sourceHost, path.join(isolatedHomeGhConfigDir, "hosts.yml"));
  await copyFile(sourceHost, path.join(isolatedWindowsGhConfigDir, "hosts.yml"));
}

function hasCopilotAuthValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function parseCopilotAuthConfig(value: string, filename: string): unknown | undefined {
  return parseJsonc(value) ?? (filename === "config" ? parseLegacyCopilotConfig(value) : undefined);
}

function parseLegacyCopilotConfig(value: string): Record<string, unknown> | undefined {
  const parsed: Record<string, unknown> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    parsed[key] = parseJsonc(rawValue) ?? parseLegacyCopilotScalar(rawValue);
  }
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function parseLegacyCopilotScalar(value: string): unknown {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function copilotSdkReviewSettings(): Record<string, unknown> {
  return {
    askUser: false,
    autoUpdate: false,
    memory: false,
    remoteSessions: false,
    skillDirectories: [],
    disabledSkills: ["*", "customize-cloud-agent"],
    disabledMcpServers: ["*"],
    enabledMcpServers: [],
    enabledPlugins: {},
    disableAllHooks: true,
    customAgents: {
      defaultLocalOnly: true,
    },
    extensions: {
      mode: "disabled",
      disabledExtensions: ["*"],
    },
  };
}

async function writeCopilotJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonc(value: string): unknown | undefined {
  return parseJson(value) ?? parseJson(removeJsonTrailingCommas(stripJsonComments(value)));
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stripJsonComments(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) {
        output += value[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function removeJsonTrailingCommas(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "," && nextJsonToken(value, index + 1)?.match(/^[}\]]$/)) {
      continue;
    }

    output += char;
  }

  return output;
}

function nextJsonToken(value: string, startIndex: number): string | undefined {
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char !== undefined && !/\s/.test(char)) {
      return char;
    }
  }
  return undefined;
}

async function resolveCopilotRuntimeExecutable(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  sourcePathRoot: string,
): Promise<string> {
  const runtimeExecutable = resolveCopilotRuntimePath(executable, sourcePathRoot);
  if (path.extname(runtimeExecutable).toLowerCase() !== ".js") {
    const runtime = await resolveExecutable(runtimeExecutable, env);
    assertCopilotRuntimeExecutableName(runtime, executable);
    return runtime;
  }

  const runtime = await firstReadableFile(copilotRuntimeCandidates(runtimeExecutable, env));
  if (runtime === undefined) {
    throw missingRequirement(`CLI executable not found: ${executable}`);
  }
  return runtime;
}

function resolveCopilotRuntimePath(executable: string, sourcePathRoot: string): string {
  if (!isPathLikeCopilotRuntime(executable) || path.isAbsolute(executable)) {
    return executable;
  }
  return path.resolve(sourcePathRoot, executable);
}

function assertCopilotRuntimeExecutableName(resolvedExecutable: string, executable: string): void {
  const basename = path.basename(resolvedExecutable).toLowerCase();
  if (basename.includes("copilot")) {
    return;
  }

  throw missingRequirement(
    `Copilot SDK executable must be a Copilot runtime binary or readable .js entrypoint, not ${executable}.`,
  );
}

function copilotRuntimeCandidates(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  if (isPathLikeCopilotRuntime(executable)) {
    return [executable];
  }

  return ((env === undefined ? process.env.PATH : env.PATH) ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));
}

function isPathLikeCopilotRuntime(executable: string): boolean {
  return (
    executable.includes(path.sep) || (process.platform === "win32" && executable.includes("/"))
  );
}

async function readCopilotPackageJson(
  directory: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function copilotClientOptions(
  sdk: CopilotSdk,
  input: ReviewAdapterInput,
  env: NodeJS.ProcessEnv,
  baseDirectory: string,
  resolvedExecutable: string,
  reviewRoot: string,
): CopilotClientOptions {
  return {
    mode: "empty",
    workingDirectory: reviewRoot,
    baseDirectory,
    env,
    // Copilot SDK spawns .js runtime entries through Node, so the bundled runtime path is cross-platform.
    connection: sdk.RuntimeConnection.forStdio({
      ...copilotRuntimeLaunchCommand(resolvedExecutable),
    }),
  };
}

function copilotRuntimeLaunchCommand(resolvedExecutable: string): { path: string; args: string[] } {
  const extension = path.extname(resolvedExecutable).toLowerCase();
  if (extension === ".js") {
    return { path: process.execPath, args: [resolvedExecutable, ...copilotRuntimeArgs] };
  }

  return { path: resolvedExecutable, args: [...copilotRuntimeArgs] };
}

function assertCopilotRuntimeLaunchCommandSupported(resolvedExecutable: string): void {
  const extension = path.extname(resolvedExecutable).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    throw reviewerFailed(
      "Copilot SDK command-script runtimes (.cmd/.bat) cannot preserve SDK stdio flags reliably; use Copilot CLI transport or configure a JavaScript/native SDK runtime executable.",
    );
  }
}

function copilotSessionConfig(
  input: ReviewAdapterInput,
  reviewRoot: string,
  toolOutputTempDir: string,
): SessionConfig {
  const model = providerQualifiedModel(input.reviewer);
  const effort = copilotSdkEffort(input.reviewer.effort);
  const config: CopilotReviewSessionConfig = {
    clientName: "diffwarden",
    workingDirectory: reviewRoot,
    availableTools: [...copilotSdkReviewAvailableTools],
    excludedTools: [...copilotReviewExcludedTools],
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    coauthorEnabled: false,
    manageScheduleEnabled: false,
    requestExtensions: false,
    enableMcpApps: false,
    mcpServers: {},
    enableSkills: false,
    disabledSkills: ["*", "customize-cloud-agent"],
    installedPlugins: [],
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    customAgents: [],
    skillDirectories: [],
    pluginDirectories: [],
    instructionDirectories: [],
    defaultAgent: {
      excludedTools: [...copilotReviewExcludedTools],
    },
    streaming: false,
    includeSubAgentStreamingEvents: false,
    mcpOAuthTokenStorage: "in-memory",
    enableSessionTelemetry: false,
    infiniteSessions: { enabled: false },
    onPermissionRequest: createCopilotSdkPermissionHandler(reviewRoot, [toolOutputTempDir]),
  };
  if (model !== undefined) {
    config.model = model;
  }
  if (effort !== undefined) {
    config.reasoningEffort = effort;
  }
  return config;
}

async function runCopilotSession(
  session: CopilotSession,
  input: ReviewAdapterInput,
  deadline: CopilotRunDeadline,
): Promise<CopilotSessionResult> {
  let lastAssistantContent: string | undefined;
  let lastAssistantModel: string | undefined;
  let lastUsage: unknown;
  let lastUsageEffort: string | undefined;
  const unsubscribe = session.on((event: SessionEvent) => {
    if (!isRootCopilotSessionEvent(event)) {
      return;
    }
    if (event.type === "assistant.message") {
      lastAssistantContent = event.data.content;
      lastAssistantModel = event.data.model ?? lastAssistantModel;
      return;
    }
    if (event.type === "assistant.usage") {
      lastUsage = event.data;
      lastAssistantModel = event.data.model ?? lastAssistantModel;
      lastUsageEffort = event.data.reasoningEffort ?? lastUsageEffort;
    }
  });

  try {
    await waitForCopilotIdle(session, input, deadline, () => ({
      content: lastAssistantContent,
      usage: lastUsage,
      model: lastAssistantModel,
      effort: lastUsageEffort,
    }));
  } finally {
    unsubscribe();
  }

  if (lastAssistantContent === undefined || !lastAssistantContent.trim()) {
    throw reviewerFailed("Copilot reviewer did not return an assistant message");
  }

  return {
    content: lastAssistantContent,
    ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
    ...(lastAssistantModel !== undefined ? { model: lastAssistantModel } : {}),
    ...(lastUsageEffort !== undefined ? { effort: lastUsageEffort } : {}),
  };
}

async function waitForCopilotIdle(
  session: CopilotSession,
  input: ReviewAdapterInput,
  deadline: CopilotRunDeadline,
  currentResult: () => {
    content: string | undefined;
    usage: unknown;
    model: string | undefined;
    effort: string | undefined;
  },
): Promise<void> {
  let unsubscribeIdle: (() => void) | undefined;
  let promptStarted = false;
  let finishIdle: (() => void) | undefined;
  let sessionError: string | undefined;
  let sawIdleBeforePromptStarted = false;
  let sawIdleWithoutAssistantMessage = false;
  let idleWithoutAssistantMessageTimer: NodeJS.Timeout | undefined;
  let settleAfterAssistantMessage: NodeJS.Timeout | undefined;
  const idle = new Promise<void>((resolve) => {
    const finish = () => {
      finishIdle = undefined;
      if (idleWithoutAssistantMessageTimer !== undefined) {
        clearTimeout(idleWithoutAssistantMessageTimer);
        idleWithoutAssistantMessageTimer = undefined;
      }
      if (settleAfterAssistantMessage !== undefined) {
        clearTimeout(settleAfterAssistantMessage);
        settleAfterAssistantMessage = undefined;
      }
      unsubscribeIdle?.();
      unsubscribeIdle = undefined;
      resolve();
    };
    finishIdle = finish;
    unsubscribeIdle = session.on((event: SessionEvent) => {
      if (!isRootCopilotSessionEvent(event)) {
        return;
      }
      if (event.type === "session.idle" && !promptStarted) {
        // Pre-send idle can be stale session state. Remember it only to release a
        // later assistant message; do not treat it as terminal no-output.
        sawIdleBeforePromptStarted = true;
        return;
      }
      if (event.type === "session.idle" && promptStarted) {
        if (copilotSessionResultHasAssistantMessage(currentResult())) {
          finish();
          return;
        }
        sawIdleWithoutAssistantMessage = true;
        idleWithoutAssistantMessageTimer ??= setTimeout(
          finish,
          copilotIdleWithoutAssistantMessageSettleMs,
        );
        // Idle can precede final SDK events; give them a bounded settle window.
        return;
      }
      if (
        event.type === "assistant.message" &&
        (sawIdleWithoutAssistantMessage || sawIdleBeforePromptStarted) &&
        settleAfterAssistantMessage === undefined &&
        copilotSessionResultHasAssistantMessage(currentResult())
      ) {
        // If idle arrived first, defer completion one turn so an immediately trailing
        // fatal error/shutdown can still win over provisional review text.
        settleAfterAssistantMessage = setTimeout(finish, 0);
        return;
      }
      if (event.type === "session.error" && !isRecoverableCopilotSessionError(event.data)) {
        sessionError = sessionError ?? formatEventData(event.data);
        finish();
        return;
      }
      if (event.type === "session.shutdown" && promptStarted) {
        if (event.data.shutdownType === "error" && sessionError === undefined) {
          sessionError =
            typeof event.data.errorReason === "string" && event.data.errorReason.trim()
              ? event.data.errorReason.trim()
              : formatEventData(event.data);
        }
        finish();
      }
    });
  });

  try {
    await withCopilotDeadline({
      signal: input.signal,
      deadline,
      timeoutMessage: "Copilot reviewer timed out waiting for session idle",
      abortMessage: "Copilot reviewer aborted before sending prompt",
      operation: async () => {
        await session.send({ prompt: input.prompt });
        promptStarted = true;
        if (copilotSessionResultHasAssistantMessage(currentResult())) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          finishIdle?.();
        }
        await idle;
      },
      onCancel: () => session.abort(),
    });
    const result = currentResult();
    if (sessionError !== undefined) {
      throw reviewerFailed(`Copilot reviewer failed: ${sessionError}`);
    }
    if (result.content === undefined) {
      throw reviewerFailed("Copilot reviewer became idle without producing an assistant message");
    }
  } finally {
    if (idleWithoutAssistantMessageTimer !== undefined) {
      clearTimeout(idleWithoutAssistantMessageTimer);
      idleWithoutAssistantMessageTimer = undefined;
    }
    if (settleAfterAssistantMessage !== undefined) {
      clearTimeout(settleAfterAssistantMessage);
      settleAfterAssistantMessage = undefined;
    }
    unsubscribeIdle?.();
  }
}

function copilotSessionResultHasAssistantMessage(result: {
  content: string | undefined;
}): boolean {
  return result.content !== undefined;
}

function isRootCopilotSessionEvent(event: SessionEvent): boolean {
  // Sub-agent lifecycle and usage events are independent from the root review response.
  const agentId = (event as { agentId?: unknown }).agentId;
  return typeof agentId !== "string" || agentId.trim() === "";
}

async function withCopilotDeadline<T>(options: {
  signal: AbortSignal | undefined;
  deadline: CopilotRunDeadline;
  timeoutMessage: string;
  abortMessage: string;
  operation: () => Promise<T>;
  onCancel?: () => Promise<unknown> | unknown;
  onLateValue?: (value: T) => Promise<unknown> | unknown;
}): Promise<T> {
  throwIfAborted(options.signal, options.abortMessage);
  const timeoutMs = remainingCopilotTimeoutMs(options.deadline, options.timeoutMessage);
  let timeout: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  let canceled = false;

  const guard = new Promise<never>((_, reject) => {
    removeAbortListener = bindAbortSignal(options.signal, () => {
      canceled = true;
      void Promise.resolve(options.onCancel?.()).catch(() => undefined);
      reject(reviewerFailed(options.abortMessage));
    });

    timeout = setTimeout(() => {
      canceled = true;
      void Promise.resolve(options.onCancel?.()).catch(() => undefined);
      reject(reviewerFailed(options.timeoutMessage));
    }, timeoutMs);
  });

  try {
    if (options.signal?.aborted) {
      canceled = true;
      void Promise.resolve(options.onCancel?.()).catch(() => undefined);
      throw reviewerFailed(options.abortMessage);
    }

    const operation = Promise.resolve().then(options.operation);
    operation.then(
      (value) => {
        if (canceled) {
          void Promise.resolve(options.onLateValue?.(value)).catch(() => undefined);
        }
      },
      () => undefined,
    );

    return await Promise.race([operation, guard]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    removeAbortListener?.();
  }
}

function copilotOutputMetadata(
  reviewer: ReviewReviewerConfig,
  options: {
    baseDirectory: string;
    sourceBaseDirectory?: string | undefined;
    executable?: string | undefined;
    resolvedExecutable?: string | undefined;
    runtimeSource: "config" | "sdk-bundled";
    packageVersion?: string | undefined;
    model?: string | undefined;
    effort?: string | undefined;
  },
): NonNullable<ReviewAdapterOutput["metadata"]> {
  return sdkOutputMetadata("copilot", {
    ...copilotReviewPolicyMetadata(),
    ...(options.packageVersion !== undefined ? { sdkVersion: options.packageVersion } : {}),
    copilotBaseDirectory: options.baseDirectory,
    ...(options.sourceBaseDirectory !== undefined
      ? { copilotSourceBaseDirectory: options.sourceBaseDirectory }
      : {}),
    copilotRuntimeSource: options.runtimeSource,
    ...(options.executable !== undefined ? { executable: options.executable } : {}),
    ...(options.resolvedExecutable !== undefined
      ? { resolvedExecutable: options.resolvedExecutable }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...copilotModelMetadata(reviewer, options.model),
    ...copilotSdkEffortMetadata(reviewer, options.effort),
  });
}

function copilotModelMetadata(
  reviewer: ReviewReviewerConfig,
  resolvedModel = providerQualifiedModel(reviewer),
): Record<string, string> {
  const requested = providerQualifiedModel(reviewer);
  return requested === undefined && resolvedModel === undefined
    ? {}
    : modelResolutionMetadata({
        requested,
        resolved: resolvedModel,
        source:
          resolvedModel === requested ? (reviewer.modelSource ?? "requested") : "provider-result",
      });
}

function copilotSdkEffortMetadata(
  reviewer: ReviewReviewerConfig,
  resultEffort?: string | undefined,
): Record<string, string> {
  const selected = copilotSdkEffort(reviewer.effort);
  const resolved = resultEffort ?? selected;
  if (reviewer.effort === undefined && resolved === undefined) {
    return {};
  }

  return effortResolutionMetadata({
    requested: reviewer.effort,
    resolved,
    source:
      resultEffort !== undefined
        ? "provider-result"
        : selected === reviewer.effort
          ? (reviewer.effortSource ?? "requested")
          : "adapter-selection",
  });
}

function copilotSdkEffort(effort: string | undefined): CopilotReasoningEffort | undefined {
  if (effort === undefined || effort === "off") {
    return undefined;
  }
  return (effort === "minimal" ? "low" : effort) as CopilotReasoningEffort;
}

function requiredCopilotBaseDirectory(
  reviewer: ReviewReviewerConfig,
  env: NodeJS.ProcessEnv | undefined,
): string {
  const baseDirectory = copilotBaseDirectory(reviewer, env);
  if (baseDirectory === undefined) {
    throw reviewerFailed(
      "Copilot SDK base directory could not be resolved from the explicit environment; set sdkOptions.baseDirectory, COPILOT_HOME, HOME, or USERPROFILE before running Copilot SDK reviews.",
    );
  }
  return baseDirectory;
}

function copilotBaseDirectory(
  reviewer: ReviewReviewerConfig,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  const configured = stringSdkOption(reviewer, "baseDirectory");
  if (configured !== undefined) {
    return configured;
  }
  const effectiveEnv = env ?? process.env;
  const copilotHome = effectiveEnv.COPILOT_HOME?.trim();
  if (copilotHome) {
    return copilotHome;
  }
  const home = effectiveEnv.HOME?.trim();
  if (home) {
    return path.join(home, ".copilot");
  }
  const userProfile = effectiveEnv.USERPROFILE?.trim();
  if (userProfile) {
    return path.join(userProfile, ".copilot");
  }
  const homeDrive = effectiveEnv.HOMEDRIVE?.trim();
  const homePath = effectiveEnv.HOMEPATH?.trim();
  if (homeDrive && homePath) {
    return path.join(`${homeDrive}${homePath}`, ".copilot");
  }
  if (env !== undefined && env !== process.env) {
    return undefined;
  }
  return path.join(homedir(), ".copilot");
}

async function assertCopilotBaseDirectoryOutsideWorkspace(
  reviewRoots: readonly string[],
  baseDirectory: string,
): Promise<void> {
  if (await pathIsInsideReviewWorkspace(reviewRoots, baseDirectory)) {
    throw reviewerFailed(
      "Copilot SDK base directory resolved inside the review workspace; set sdkOptions.baseDirectory, COPILOT_HOME, or HOME outside the repository before running Copilot SDK reviews.",
    );
  }
}

async function assertCopilotRuntimeOutsideWorkspace(
  reviewRoots: readonly string[],
  runtimePath: string,
): Promise<void> {
  // Intentional fail-closed boundary: SDK runtime code must not execute from the reviewed tree.
  // Project-local installs should use Copilot CLI transport or an external SDK runtime override.
  if (await pathIsInsideReviewWorkspace(reviewRoots, runtimePath)) {
    throw reviewerFailed(
      "Copilot SDK runtime resolved inside the review workspace; install Diffwarden outside the repository or set sdkOptions.executable to a Copilot runtime outside the repository.",
    );
  }
}

function copilotReviewRoot(input: ReviewAdapterInput): string {
  return path.resolve(input.target.repo_root || input.cwd);
}

function copilotSourcePathRoot(
  input: Pick<ReviewAdapterInput | ReviewAdapterPreflightInput, "cwd">,
): string {
  return path.resolve(input.cwd);
}

function resolveCopilotReviewPath(inputPath: string, pathRoot: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(pathRoot, inputPath);
}

function copilotBaseDirectorySource(
  reviewer: ReviewReviewerConfig,
  env: NodeJS.ProcessEnv | undefined,
): string {
  if (stringSdkOption(reviewer, "baseDirectory") !== undefined) {
    return "config";
  }
  const effectiveEnv = env ?? process.env;
  if (
    effectiveEnv.COPILOT_HOME?.trim() ||
    effectiveEnv.HOME?.trim() ||
    effectiveEnv.USERPROFILE?.trim() ||
    (effectiveEnv.HOMEDRIVE?.trim() && effectiveEnv.HOMEPATH?.trim())
  ) {
    return "env";
  }
  return "default";
}

function copilotSdkExecutable(reviewer: ReviewReviewerConfig): string | undefined {
  return stringSdkOption(reviewer, "executable");
}

function copilotProcessEnv(
  env: NodeJS.ProcessEnv | undefined,
  baseDirectory: string,
  ghConfigDir: string,
  homeDirectory: string,
  toolOutputTempDir: string,
): NodeJS.ProcessEnv {
  const next = {
    ...(env ?? process.env),
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_CONFIG_HOME: path.join(homeDirectory, ".config"),
    XDG_STATE_HOME: path.join(homeDirectory, ".local", "state"),
    XDG_CACHE_HOME: path.join(homeDirectory, ".cache"),
    APPDATA: path.join(homeDirectory, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDirectory, "AppData", "Local"),
    COPILOT_HOME: baseDirectory,
    COPILOT_CACHE_HOME: path.join(homeDirectory, ".cache", "copilot"),
    GH_CONFIG_DIR: ghConfigDir,
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_OTEL_ENABLED: "false",
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
    TMPDIR: toolOutputTempDir,
    TMP: toolOutputTempDir,
    TEMP: toolOutputTempDir,
  };
  for (const key of copilotSdkProcessEnvUnsetKeys) {
    deleteEnvKey(next, key);
  }
  return next;
}

function deleteEnvKey(env: NodeJS.ProcessEnv, key: string): void {
  Reflect.deleteProperty(env, key);
  const normalized = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === normalized) {
      Reflect.deleteProperty(env, existingKey);
    }
  }
}

async function assertCopilotGithubAuthDirsOutsideWorkspace(
  reviewRoots: readonly string[],
  sourcePathRoot: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  const sourceHost = await firstPresentFile(
    copilotGithubAuthDirs(env, sourcePathRoot).map((dir) => path.join(dir, "hosts.yml")),
  );
  if (
    sourceHost !== undefined &&
    (await pathIsInsideReviewWorkspace(reviewRoots, path.dirname(sourceHost)))
  ) {
    throw reviewerFailed(
      "Copilot SDK GitHub CLI auth state resolved inside the review workspace; set GH_CONFIG_DIR, XDG_CONFIG_HOME, HOME, or USERPROFILE outside the repository before running Copilot SDK reviews.",
    );
  }
}

function copilotGithubAuthDirs(
  env: NodeJS.ProcessEnv | undefined,
  sourcePathRoot: string,
): string[] {
  const effectiveEnv = env ?? process.env;
  const configuredGhConfigDir = effectiveEnv.GH_CONFIG_DIR?.trim();
  if (configuredGhConfigDir) {
    return [resolveCopilotReviewPath(configuredGhConfigDir, sourcePathRoot)];
  }

  const dirs: string[] = [];
  const xdgConfigHome = effectiveEnv.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    dirs.push(path.join(resolveCopilotReviewPath(xdgConfigHome, sourcePathRoot), "gh"));
  }
  const home = copilotGithubAuthHome(env);
  if (home !== undefined) {
    dirs.push(path.join(resolveCopilotReviewPath(home, sourcePathRoot), ".config", "gh"));
  }
  const appData = copilotGithubAuthAppData(env, home);
  if (appData !== undefined) {
    dirs.push(path.join(resolveCopilotReviewPath(appData, sourcePathRoot), "GitHub CLI"));
  }
  return [...new Set(dirs)];
}

async function firstPresentFile(paths: readonly string[]): Promise<string | undefined> {
  for (const filePath of paths) {
    try {
      await access(filePath);
      return filePath;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return undefined;
}

function copilotGithubAuthHome(
  env: NodeJS.ProcessEnv | undefined,
  fallbackHome = homedir(),
): string | undefined {
  const effectiveEnv = env ?? process.env;
  const home = effectiveEnv.HOME?.trim();
  if (home) {
    return home;
  }
  const userProfile = effectiveEnv.USERPROFILE?.trim();
  if (userProfile) {
    return userProfile;
  }
  const homeDrive = effectiveEnv.HOMEDRIVE?.trim();
  const homePath = effectiveEnv.HOMEPATH?.trim();
  if (homeDrive && homePath) {
    return path.join(`${homeDrive}${homePath}`);
  }
  if (env !== undefined && env !== process.env) {
    return undefined;
  }
  return fallbackHome;
}

function copilotGithubAuthAppData(
  env: NodeJS.ProcessEnv | undefined,
  home: string | undefined,
): string | undefined {
  const effectiveEnv = env ?? process.env;
  const configured = effectiveEnv.APPDATA?.trim();
  if (configured) {
    return configured;
  }
  const userProfile = effectiveEnv.USERPROFILE?.trim();
  if (userProfile) {
    return path.join(userProfile, "AppData", "Roaming");
  }
  return home === undefined ? undefined : path.join(home, "AppData", "Roaming");
}

function stringSdkOption(reviewer: ReviewReviewerConfig, key: string): string | undefined {
  const value = reviewer.sdkOptions?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function copilotRunContext(value: unknown): CopilotRunContext | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "copilot"
  ) {
    return undefined;
  }

  return value as CopilotRunContext;
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

function createCopilotRunDeadline(timeoutMs: number | undefined): CopilotRunDeadline {
  if (timeoutMs === undefined) {
    return {};
  }

  return {
    expiresAtMs: Date.now() + Math.min(Math.max(timeoutMs, 0), maxSdkWaitMs),
  };
}

function remainingCopilotTimeoutMs(deadline: CopilotRunDeadline, timeoutMessage: string): number {
  if (deadline.expiresAtMs === undefined) {
    return maxSdkWaitMs;
  }

  const remainingMs = deadline.expiresAtMs - Date.now();
  if (remainingMs <= 0) {
    throw reviewerFailed(timeoutMessage);
  }
  return Math.min(remainingMs, maxSdkWaitMs);
}

function bindAbortSignal(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }

  if (signal.reason instanceof DiffwardenError) {
    throw signal.reason;
  }

  throw reviewerFailed(message);
}

function isCopilotAuthFailure(detail: string): boolean {
  return /auth|login|log in|not authenticated|unauthorized|forbidden|401|403/i.test(detail);
}

function helpOutputHasFlag(output: string, flag: string): boolean {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escapedFlag}(?=$|[^\\w-])`).test(output);
}

function formatEventData(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = value.message;
    if (typeof message === "string") {
      return message;
    }
  }
  return JSON.stringify(value);
}

function isRecoverableCopilotSessionError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "errorType" in value &&
    isRecoverableCopilotSessionErrorType(value.errorType)
  );
}

function isRecoverableCopilotSessionErrorType(errorType: unknown): boolean {
  return (
    errorType === "model_call" ||
    // Read-only reviews may deny exploratory tool calls before Copilot returns the final review.
    errorType === "permission" ||
    errorType === "permission_denied" ||
    errorType === "tool_call" ||
    errorType === "tool_permission"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

export const copilotDefaultExecutable = defaultCopilotExecutable;
