import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultReviewerTransport, isReviewerSdk } from "../src/adapters/capabilities.js";
import type { ReviewerSdk, ReviewerTransport } from "../src/adapters/capabilities.js";
import { resolveCopilotBundledRuntimeExecutable } from "../src/adapters/copilot.js";
import { loadDiffwardenConfig } from "../src/core/config.js";
import type { DiffwardenConfig } from "../src/core/config.js";
import { tryGetRepoRoot } from "../src/core/git.js";

type Check = {
  id: string;
  kind: "sdk" | "cli";
  engine?: ReviewerSdk;
  configTransports?: ReviewerTransport[];
  executable?: string;
  executableRequired?: "always" | "configured";
  executableEnvNames?: string[];
  auth: string | ((env: NodeJS.ProcessEnv) => string);
};

type CliCheck = Check & {
  kind: "cli" | "sdk";
  engine: ReviewerSdk;
  executable: string;
};

type ConfiguredReviewer = NonNullable<DiffwardenConfig["reviewers"]>[number];

type ActiveReviewer = {
  id: string;
  sdk: ReviewerSdk;
  transport?: ReviewerTransport | undefined;
  cliOptions?: Record<string, unknown> | undefined;
  sdkOptions?: Record<string, unknown> | undefined;
};

type ActiveExecutable =
  | {
      kind: "executable";
      executable: string;
      reviewerId: string;
      source: Extract<LiveDoctorSelectionSource, "adapter-default" | "config">;
    }
  | {
      kind: "bundled-runtime";
      reviewerId: string;
      source: Extract<LiveDoctorSelectionSource, "adapter-default">;
    };

type ExecutableSelection =
  | {
      kind: "single";
      executable: string;
      source: LiveDoctorSelectionSource;
      detail?: string;
    }
  | {
      kind: "multiple-active";
      executables: ActiveExecutable[];
    }
  | {
      kind: "bundled-runtime";
      source: LiveDoctorSelectionSource;
      detail: string;
    };

export type LiveDoctorSelectionSource = "adapter-default" | "config" | "env";

export type LiveDoctorRow = {
  id: string;
  kind: "sdk" | "cli" | "config";
  status: string;
  auth: string;
  executable?: string;
  resolvedExecutable?: string;
  executableSource?: LiveDoctorSelectionSource;
  executableSourceDetail?: string;
};

const checks: Check[] = [
  {
    id: "cursor-sdk",
    kind: "sdk",
    auth: (env) => (env.CURSOR_API_KEY ? "env present" : "missing CURSOR_API_KEY"),
  },
  {
    id: "claude-sdk",
    kind: "sdk",
    auth: (env) =>
      env.ANTHROPIC_API_KEY
        ? "ANTHROPIC_API_KEY present"
        : "API key absent; Claude Code auth may work",
  },
  { id: "pi-sdk", kind: "sdk", auth: "provider auth checked by Pi preflight" },
  {
    id: "droid-sdk",
    kind: "sdk",
    engine: "droid",
    configTransports: ["sdk"],
    executable: "droid",
    executableEnvNames: ["DIFFWARDEN_LIVE_DROID_SDK_EXECUTABLE"],
    auth: (env) =>
      env.FACTORY_API_KEY ? "FACTORY_API_KEY present" : "API key absent; Droid local auth may work",
  },
  {
    id: "copilot-sdk",
    kind: "sdk",
    engine: "copilot",
    configTransports: ["sdk"],
    executable: "copilot",
    executableRequired: "configured",
    // Live-doctor executable env overrides are diagnostics-only; runtime overrides belong in config.
    executableEnvNames: ["DIFFWARDEN_LIVE_COPILOT_SDK_EXECUTABLE"],
    auth: "delegated to Copilot runtime",
  },
  {
    id: "codex",
    kind: "cli",
    engine: "codex",
    configTransports: ["cli", "app-server"],
    executable: "codex",
    auth: "delegated to CLI",
  },
  {
    id: "claude-cli",
    kind: "cli",
    engine: "claude",
    configTransports: ["cli"],
    executable: "claude",
    auth: "delegated to CLI",
  },
  {
    id: "cursor-cli",
    kind: "cli",
    engine: "cursor",
    configTransports: ["cli"],
    executable: "cursor-agent",
    auth: "delegated to CLI",
  },
  {
    id: "gemini",
    kind: "cli",
    engine: "gemini",
    configTransports: ["cli"],
    executable: "gemini",
    auth: "delegated to CLI",
  },
  {
    id: "opencode",
    kind: "cli",
    engine: "opencode",
    configTransports: ["cli"],
    executable: "opencode",
    auth: "delegated to CLI",
  },
  {
    id: "pi-cli",
    kind: "cli",
    engine: "pi",
    configTransports: ["cli"],
    executable: "pi",
    auth: "delegated to CLI",
  },
  {
    id: "droid-cli",
    kind: "cli",
    engine: "droid",
    configTransports: ["cli"],
    executable: "droid",
    executableEnvNames: ["DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE"],
    auth: "delegated to CLI",
  },
  {
    id: "copilot-cli",
    kind: "cli",
    engine: "copilot",
    configTransports: ["cli"],
    executable: "copilot",
    auth: "delegated to CLI",
  },
  {
    id: "grok",
    kind: "cli",
    engine: "grok",
    configTransports: ["cli"],
    executable: "grok",
    auth: "delegated to CLI",
  },
  {
    id: "antigravity",
    kind: "cli",
    engine: "antigravity",
    configTransports: ["cli"],
    executable: "agy",
    auth: "delegated to CLI",
  },
];

export async function collectLiveDoctorRows(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  repoRoot?: string;
}): Promise<LiveDoctorRow[]> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const discoveredRepoRoot = options.repoRoot ?? (await tryGetRepoRoot(cwd));
  const reviewRoot = discoveredRepoRoot ?? cwd;
  const reviewRoots = [...new Set([reviewRoot, cwd])];
  const configResult = await loadConfigForDoctor({
    cwd,
    ...(discoveredRepoRoot !== undefined ? { repoRoot: discoveredRepoRoot } : {}),
    env,
  });
  const activeReviewers = configResult.activeReviewers;
  const rows = await Promise.all(
    checks.map(async (check): Promise<LiveDoctorRow> => {
      const auth = checkAuth(check, env);
      if (!isExecutableCheck(check)) {
        return { id: check.id, kind: check.kind, status: "n/a", auth };
      }

      const selection = selectExecutable(check, env, activeReviewers);
      if (selection.kind === "bundled-runtime") {
        return await bundledRuntimeRow(check, selection, auth, reviewRoots);
      }
      if (selection.kind === "multiple-active") {
        return await multipleActiveExecutableRow(
          check,
          selection.executables,
          env,
          platform,
          auth,
          reviewRoots,
        );
      }

      const resolved = await resolveCheckExecutable(
        check,
        selection.executable,
        env,
        platform,
        reviewRoots,
      );
      return {
        id: check.id,
        kind: check.kind,
        auth,
        executable: selection.executable,
        executableSource: selection.source,
        ...(selection.detail !== undefined ? { executableSourceDetail: selection.detail } : {}),
        ...(resolved !== undefined ? { resolvedExecutable: resolved } : {}),
        status:
          resolved === undefined
            ? `missing executable: ${selection.executable}`
            : `found: ${resolved}`,
      };
    }),
  );

  return configResult.warning === undefined ? rows : [configResult.warning, ...rows];
}

export function formatLiveDoctorRows(rows: LiveDoctorRow[]): string {
  return rows
    .map((row) =>
      [
        row.id.padEnd(12),
        row.kind.padEnd(3),
        row.status.padEnd(46),
        sourceLabel(row).padEnd(32),
        row.auth,
      ].join(" "),
    )
    .join("\n");
}

async function main(): Promise<void> {
  process.stdout.write(`${formatLiveDoctorRows(await collectLiveDoctorRows({}))}\n`);
}

function selectExecutable(
  check: CliCheck,
  env: NodeJS.ProcessEnv,
  activeReviewers: ActiveReviewer[] | undefined,
): ExecutableSelection {
  const envExecutable = executableEnvOverride(check, env);
  if (envExecutable !== undefined) {
    return {
      kind: "single",
      executable: envExecutable.executable,
      source: "env",
      detail: envExecutable.name,
    };
  }

  const configured = activeExecutableSelection(
    activeReviewers,
    check.engine,
    check.configTransports,
    check.executable,
    check.executableRequired,
  );
  if (configured !== undefined) {
    return configured;
  }

  if (check.executableRequired === "configured") {
    return {
      kind: "bundled-runtime",
      source: "adapter-default",
      detail: "SDK bundled runtime",
    };
  }

  return { kind: "single", executable: check.executable, source: "adapter-default" };
}

function isExecutableCheck(check: Check): check is CliCheck {
  return check.executable !== undefined && check.engine !== undefined;
}

function executableEnvOverride(
  check: CliCheck,
  env: NodeJS.ProcessEnv,
): { executable: string; name: string } | undefined {
  for (const name of check.executableEnvNames ?? [
    `DIFFWARDEN_LIVE_${envName(check.id)}_EXECUTABLE`,
  ]) {
    const executable = stringValue(env[name]);
    if (executable !== undefined) {
      return { executable, name };
    }
  }

  return undefined;
}

function activeExecutableSelection(
  activeReviewers: ActiveReviewer[] | undefined,
  engine: ReviewerSdk,
  configTransports: ReviewerTransport[] | undefined,
  fallbackExecutable: string,
  executableRequired: Check["executableRequired"],
): ExecutableSelection | undefined {
  if (activeReviewers === undefined) {
    return undefined;
  }

  const executables: ActiveExecutable[] = [];
  for (const reviewer of activeReviewers) {
    const transport = effectiveTransport(reviewer);
    if (
      reviewer.sdk !== engine ||
      !configuredTransportMatches(configTransports, transport) ||
      !isExecutableBackedTransport(engine, transport)
    ) {
      continue;
    }

    const executable = configuredReviewerExecutable(reviewer, transport);
    if (executable === undefined && executableRequired === "configured") {
      executables.push({
        kind: "bundled-runtime",
        reviewerId: reviewer.id,
        source: "adapter-default",
      });
      continue;
    }
    executables.push(
      executable === undefined
        ? {
            kind: "executable",
            executable: fallbackExecutable,
            reviewerId: reviewer.id,
            source: "adapter-default",
          }
        : { kind: "executable", executable, reviewerId: reviewer.id, source: "config" },
    );
  }

  const distinctExecutables = uniqueActiveExecutables(executables);
  if (distinctExecutables.length === 0) {
    return undefined;
  }
  if (distinctExecutables.length === 1) {
    const configured = distinctExecutables[0];
    if (configured === undefined) {
      return undefined;
    }
    return {
      ...(configured.kind === "bundled-runtime"
        ? {
            kind: "bundled-runtime" as const,
            source: configured.source,
            detail: "SDK bundled runtime",
          }
        : {
            kind: "single" as const,
            executable: configured.executable,
            source: configured.source,
            ...(configured.source === "config"
              ? { detail: `reviewer ${configured.reviewerId}` }
              : {}),
          }),
    };
  }

  return { kind: "multiple-active", executables: distinctExecutables };
}

function isExecutableBackedTransport(engine: ReviewerSdk, transport: ReviewerTransport): boolean {
  return (
    transport === "cli" ||
    (engine === "codex" && transport === "app-server") ||
    (engine === "droid" && transport === "sdk") ||
    (engine === "copilot" && transport === "sdk")
  );
}

function configuredTransportMatches(
  configTransports: ReviewerTransport[] | undefined,
  transport: ReviewerTransport,
): boolean {
  return configTransports === undefined
    ? true
    : configTransports.some((candidate) => candidate === transport);
}

async function multipleActiveExecutableRow(
  check: CliCheck,
  executables: ActiveExecutable[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  auth: string,
  reviewRoots: readonly string[],
): Promise<LiveDoctorRow> {
  const resolved = await Promise.all(
    executables.map(async (entry) =>
      entry.kind === "bundled-runtime"
        ? { ...entry, resolved: await resolveBundledRuntimeForDoctor(reviewRoots) }
        : {
            ...entry,
            resolved: await resolveCheckExecutable(
              check,
              entry.executable,
              env,
              platform,
              reviewRoots,
            ),
          },
    ),
  );
  const missing = resolved.find((entry) => entry.resolved === undefined);
  const hasBundledRuntime = executables.some((entry) => entry.kind === "bundled-runtime");

  return {
    id: check.id,
    kind: check.kind,
    auth,
    executableSource: "config",
    executableSourceDetail: `multiple active reviewers: ${executables
      .map((entry) =>
        entry.kind === "bundled-runtime"
          ? `${entry.reviewerId} (${entry.source}: bundled runtime)`
          : `${entry.reviewerId} (${entry.source})`,
      )
      .join(", ")}`,
    status:
      missing === undefined
        ? hasBundledRuntime
          ? "found multiple active runtimes"
          : "found multiple active executables"
        : missing.kind === "bundled-runtime"
          ? "missing active bundled runtime"
          : `missing active executable: ${missing.executable}`,
  };
}

async function bundledRuntimeRow(
  check: CliCheck,
  selection: Extract<ExecutableSelection, { kind: "bundled-runtime" }>,
  auth: string,
  reviewRoots: readonly string[],
): Promise<LiveDoctorRow> {
  const resolved = await resolveBundledRuntimeForDoctor(reviewRoots);
  return {
    id: check.id,
    kind: check.kind,
    status:
      resolved === undefined ? "missing bundled runtime" : `found bundled runtime: ${resolved}`,
    auth,
    executableSource: selection.source,
    executableSourceDetail: selection.detail,
    ...(resolved !== undefined ? { resolvedExecutable: resolved } : {}),
  };
}

async function resolveBundledRuntimeForDoctor(
  reviewRoots: readonly string[],
): Promise<string | undefined> {
  try {
    const resolved = await resolveCopilotBundledRuntimeExecutable();
    return (await pathIsInsideReviewWorkspace(reviewRoots, resolved)) ? undefined : resolved;
  } catch {
    return undefined;
  }
}

function checkAuth(check: Check, env: NodeJS.ProcessEnv): string {
  return typeof check.auth === "function" ? check.auth(env) : check.auth;
}

function configuredReviewerExecutable(
  reviewer: ActiveReviewer,
  transport: ReviewerTransport,
): string | undefined {
  if (reviewer.sdk === "droid" && transport === "sdk") {
    return (
      stringValue(reviewer.sdkOptions?.executable) ?? stringValue(reviewer.cliOptions?.executable)
    );
  }
  if (reviewer.sdk === "copilot" && transport === "sdk") {
    return stringValue(reviewer.sdkOptions?.executable);
  }

  const cliExecutable = stringValue(reviewer.cliOptions?.executable);
  if (cliExecutable !== undefined) {
    return cliExecutable;
  }

  return undefined;
}

function uniqueActiveExecutables(executables: ActiveExecutable[]): ActiveExecutable[] {
  const unique = new Map<string, ActiveExecutable>();
  for (const executable of executables) {
    const key = activeExecutableKey(executable);
    const existing = unique.get(key);
    if (existing === undefined || existing.source === "adapter-default") {
      unique.set(key, executable);
    }
  }
  return [...unique.values()];
}

function activeExecutableKey(executable: ActiveExecutable): string {
  return executable.kind === "bundled-runtime"
    ? "bundled-runtime"
    : `executable:${executable.executable}`;
}

async function loadConfigForDoctor(options: {
  cwd: string;
  repoRoot?: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ activeReviewers?: ActiveReviewer[]; warning?: LiveDoctorRow }> {
  try {
    const loaded = await loadDiffwardenConfig({
      cwd: options.cwd,
      ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
      env: options.env,
    });
    return loaded === undefined
      ? {}
      : { activeReviewers: activeConfiguredReviewers(loaded.config) };
  } catch (error) {
    return {
      warning: {
        id: "config",
        kind: "config",
        status: "ignored invalid config",
        auth: errorMessage(error),
      },
    };
  }
}

function activeConfiguredReviewers(config: DiffwardenConfig): ActiveReviewer[] {
  const reviewers = config.reviewers ?? [];
  if (config.defaultReviewerSet === undefined) {
    return reviewers.filter(isConfiguredReviewerEnabled);
  }

  const specs = config.reviewerSets?.[config.defaultReviewerSet];
  if (specs === undefined) {
    throw new Error(`Unknown reviewer set: ${config.defaultReviewerSet}`);
  }
  if (specs.length === 0) {
    throw new Error(`Reviewer set is empty: ${config.defaultReviewerSet}`);
  }

  return specs.flatMap((spec) => {
    const resolved = configuredReviewerBySpec(reviewers, spec, config.defaultReviewerSet);
    if (!resolved.valid) {
      throw new Error(resolved.error);
    }
    return resolved.reviewer === undefined ? [] : [resolved.reviewer];
  });
}

function configuredReviewerBySpec(
  reviewers: ConfiguredReviewer[],
  spec: string,
  reviewerSet?: string,
): { valid: true; reviewer?: ActiveReviewer } | { valid: false; error: string } {
  if (spec.length === 0) {
    return { valid: false, error: "Reviewer spec cannot be empty" };
  }

  const parts = spec.split(":");
  if (parts.length > 2) {
    return { valid: false, error: `Invalid reviewer spec: ${spec}` };
  }

  const [sdk, profile] = parts;
  if (parts.length <= 2 && isReviewerSdk(sdk)) {
    if (profile === undefined) {
      return { valid: true, reviewer: builtInReviewer(spec, sdk) };
    }
    if (!isValidProfileName(profile)) {
      return { valid: false, error: `Invalid reviewer profile in spec: ${spec}` };
    }
    const reviewer = reviewers.find(
      (candidate) => candidate.sdk === sdk && candidate.profile === profile,
    );
    if (reviewer === undefined) {
      return { valid: false, error: `Unknown reviewer profile: ${spec}` };
    }
    if (!isConfiguredReviewerEnabled(reviewer)) {
      return { valid: false, error: disabledReviewerError(reviewer, reviewerSet) };
    }
    return { valid: true, reviewer };
  }

  const reviewer = reviewers.find((candidate) => candidate.id === spec);
  if (reviewer === undefined) {
    return { valid: false, error: `Unknown configured reviewer: ${spec}` };
  }
  if (!isConfiguredReviewerEnabled(reviewer)) {
    return { valid: false, error: disabledReviewerError(reviewer, reviewerSet) };
  }
  return { valid: true, reviewer };
}

function builtInReviewer(id: string, sdk: ReviewerSdk): ActiveReviewer {
  return { id, sdk };
}

function isConfiguredReviewerEnabled(reviewer: ConfiguredReviewer): boolean {
  return reviewer.enabled !== false;
}

function disabledReviewerError(reviewer: ConfiguredReviewer, reviewerSet?: string): string {
  return `Reviewer is disabled: ${reviewer.id}${
    reviewerSet === undefined ? "" : ` in reviewer set: ${reviewerSet}`
  }`;
}

function isValidProfileName(profile: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile);
}

function effectiveTransport(reviewer: {
  sdk: ReviewerSdk;
  transport?: ReviewerTransport | undefined;
}): ReviewerTransport {
  return reviewer.transport ?? defaultReviewerTransport(reviewer.sdk) ?? "sdk";
}

async function resolveExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): Promise<string | undefined> {
  if (executable.includes(path.sep)) {
    return await firstExecutableCandidate(executableCandidates(executable, env, platform));
  }

  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const resolved = await firstExecutableCandidate(
      executableCandidates(path.join(directory, executable), env, platform),
    );
    if (resolved !== undefined) {
      return resolved;
    }
  }

  return undefined;
}

async function firstExecutableCandidate(
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function executableCandidates(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): string[] {
  if (platform !== "win32" || path.extname(executable)) {
    return [executable];
  }
  return [executable, ...pathextSuffixes(env).map((suffix) => `${executable}${suffix}`)];
}

function pathextSuffixes(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      (env.PATHEXT ?? "")
        .split(";")
        .map((suffix) => suffix.trim())
        .filter(Boolean)
        .map((suffix) => (suffix.startsWith(".") ? suffix : `.${suffix}`)),
    ),
  ];
}

async function resolveCheckExecutable(
  check: CliCheck,
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  reviewRoots: readonly string[],
): Promise<string | undefined> {
  const isCopilotSdk = check.engine === "copilot" && check.kind === "sdk";
  const resolved =
    isCopilotSdk && isJavaScriptRuntime(executable)
      ? await resolveReadableFile(executable, env)
      : await resolveExecutable(executable, env, platform);
  if (isCopilotSdk && resolved !== undefined) {
    if (!isJavaScriptRuntime(resolved) && !isCopilotRuntimeExecutable(resolved)) {
      return undefined;
    }
    if (isCopilotSdkUnsupportedCommandShim(resolved)) {
      return undefined;
    }
    return (await pathIsInsideReviewWorkspace(reviewRoots, resolved)) ? undefined : resolved;
  }
  return resolved;
}

function isCopilotSdkUnsupportedCommandShim(executable: string): boolean {
  const extension = path.extname(executable).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

async function resolveReadableFile(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (isPathLike(executable)) {
    return (await isReadable(executable)) ? executable : undefined;
  }

  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, executable);
    if (await isReadable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isJavaScriptRuntime(executable: string): boolean {
  return path.extname(executable).toLowerCase() === ".js";
}

function isCopilotRuntimeExecutable(executable: string): boolean {
  return path.basename(executable).toLowerCase().includes("copilot");
}

function isPathLike(executable: string): boolean {
  return (
    executable.includes(path.sep) || (process.platform === "win32" && executable.includes("/"))
  );
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isReadable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathIsInsideReviewWorkspace(
  reviewRoots: readonly string[],
  candidatePath: string,
): Promise<boolean> {
  const candidate = await realpathOrResolve(candidatePath);
  for (const reviewRoot of reviewRoots) {
    if (isPathInside(await realpathOrResolve(reviewRoot), candidate)) {
      return true;
    }
  }
  return false;
}

async function realpathOrResolve(inputPath: string): Promise<string> {
  try {
    return await realpath(inputPath);
  } catch {
    const resolved = path.resolve(inputPath);
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      return resolved;
    }
    return path.join(await realpathOrResolve(parent), path.basename(resolved));
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function envName(id: string): string {
  return id.replace(/-cli$/, "").replace(/-sdk$/, "").replace("-", "_").toUpperCase();
}

function sourceLabel(row: LiveDoctorRow): string {
  if (row.executableSource === undefined) {
    return "source=n/a";
  }

  const detail = row.executableSourceDetail === undefined ? "" : ` ${row.executableSourceDetail}`;
  return `source=${row.executableSource}${detail}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
