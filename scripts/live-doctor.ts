import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultReviewerTransport, isReviewerSdk } from "../src/adapters/capabilities.js";
import type { ReviewerSdk, ReviewerTransport } from "../src/adapters/capabilities.js";
import type { ReviewReviewerConfig } from "../src/adapters/types.js";
import { loadDiffwardenConfig } from "../src/core/config.js";
import type { DiffwardenConfig } from "../src/core/config.js";

type Check = {
  id: string;
  kind: "sdk" | "cli";
  engine?: ReviewerSdk;
  configTransports?: ReviewerTransport[];
  executable?: string;
  executableEnvNames?: string[];
  auth: string | ((env: NodeJS.ProcessEnv) => string);
};

type CliCheck = Check & {
  kind: "cli" | "sdk";
  engine: ReviewerSdk;
  executable: string;
};

type ConfiguredReviewer = NonNullable<DiffwardenConfig["reviewers"]>[number];

type ConfiguredExecutable = {
  executable: string;
  reviewerId: string;
};

type ExecutableSelection =
  | {
      kind: "single";
      executable: string;
      source: LiveDoctorSelectionSource;
      detail?: string;
    }
  | {
      kind: "multiple-config";
      executables: ConfiguredExecutable[];
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
    executableEnvNames: [
      "DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE",
      "DIFFWARDEN_LIVE_DROID_EXECUTABLE",
    ],
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
  repoRoot?: string;
}): Promise<LiveDoctorRow[]> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configResult = await loadConfigForDoctor({
    cwd,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
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
      if (selection.kind === "multiple-config") {
        return await multipleConfiguredExecutableRow(check, selection.executables, env, auth);
      }

      const resolved = await resolveExecutable(selection.executable, env);
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
  activeReviewers: ConfiguredReviewer[] | undefined,
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

  const configured = configuredExecutables(activeReviewers, check.engine, check.configTransports);
  if (configured !== undefined) {
    return configured;
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

function configuredExecutables(
  activeReviewers: ConfiguredReviewer[] | undefined,
  engine: ReviewerSdk,
  configTransports: ReviewerTransport[] | undefined,
): ExecutableSelection | undefined {
  if (activeReviewers === undefined) {
    return undefined;
  }

  const executables: ConfiguredExecutable[] = [];
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
    if (executable !== undefined) {
      executables.push({ executable, reviewerId: reviewer.id });
    }
  }

  const distinctExecutables = uniqueConfiguredExecutables(executables);
  if (distinctExecutables.length === 0) {
    return undefined;
  }
  if (distinctExecutables.length === 1) {
    const configured = distinctExecutables[0];
    if (configured === undefined) {
      return undefined;
    }
    return {
      kind: "single",
      executable: configured.executable,
      source: "config",
      detail: `reviewer ${configured.reviewerId}`,
    };
  }

  return { kind: "multiple-config", executables: distinctExecutables };
}

function isExecutableBackedTransport(engine: ReviewerSdk, transport: ReviewerTransport): boolean {
  return (
    transport === "cli" ||
    (engine === "codex" && transport === "app-server") ||
    (engine === "droid" && transport === "sdk")
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

async function multipleConfiguredExecutableRow(
  check: CliCheck,
  executables: ConfiguredExecutable[],
  env: NodeJS.ProcessEnv,
  auth: string,
): Promise<LiveDoctorRow> {
  const resolved = await Promise.all(
    executables.map(async (entry) => ({
      ...entry,
      resolved: await resolveExecutable(entry.executable, env),
    })),
  );
  const missing = resolved.find((entry) => entry.resolved === undefined);

  return {
    id: check.id,
    kind: check.kind,
    auth,
    executableSource: "config",
    executableSourceDetail: `multiple active reviewers: ${executables
      .map((entry) => entry.reviewerId)
      .join(", ")}`,
    status:
      missing === undefined
        ? "found multiple configured executables"
        : `missing configured executable: ${missing.executable}`,
  };
}

function checkAuth(check: Check, env: NodeJS.ProcessEnv): string {
  return typeof check.auth === "function" ? check.auth(env) : check.auth;
}

function configuredReviewerExecutable(
  reviewer: ConfiguredReviewer,
  transport: ReviewerTransport,
): string | undefined {
  const cliExecutable = stringValue(reviewer.cliOptions?.executable);
  if (cliExecutable !== undefined) {
    return cliExecutable;
  }
  return reviewer.sdk === "droid" && transport === "sdk"
    ? stringValue(reviewer.sdkOptions?.executable)
    : undefined;
}

function uniqueConfiguredExecutables(executables: ConfiguredExecutable[]): ConfiguredExecutable[] {
  const unique = new Map<string, ConfiguredExecutable>();
  for (const executable of executables) {
    if (!unique.has(executable.executable)) {
      unique.set(executable.executable, executable);
    }
  }
  return [...unique.values()];
}

async function loadConfigForDoctor(options: {
  cwd: string;
  repoRoot?: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ activeReviewers?: ConfiguredReviewer[]; warning?: LiveDoctorRow }> {
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

function activeConfiguredReviewers(config: DiffwardenConfig): ConfiguredReviewer[] {
  const reviewers = config.reviewers ?? [];
  if (config.defaultReviewerSet === undefined) {
    return reviewers;
  }

  const specs = config.reviewerSets?.[config.defaultReviewerSet];
  if (specs === undefined) {
    throw new Error(`Unknown reviewer set: ${config.defaultReviewerSet}`);
  }
  if (specs.length === 0) {
    throw new Error(`Reviewer set is empty: ${config.defaultReviewerSet}`);
  }

  return specs.flatMap((spec) => {
    const resolved = configuredReviewerBySpec(reviewers, spec);
    if (!resolved.valid) {
      throw new Error(resolved.error);
    }
    return resolved.reviewer === undefined ? [] : [resolved.reviewer];
  });
}

function configuredReviewerBySpec(
  reviewers: ConfiguredReviewer[],
  spec: string,
): { valid: true; reviewer?: ConfiguredReviewer } | { valid: false; error: string } {
  const parts = spec.split(":");
  const [sdk, profile] = parts;
  if (parts.length <= 2 && isReviewerSdk(sdk)) {
    if (profile === undefined) {
      return { valid: true };
    }
    const reviewer = reviewers.find(
      (candidate) => candidate.sdk === sdk && candidate.profile === profile,
    );
    return reviewer === undefined
      ? { valid: false, error: `Unknown reviewer profile: ${spec}` }
      : { valid: true, reviewer };
  }

  const reviewer = reviewers.find((candidate) => candidate.id === spec);
  return reviewer === undefined
    ? { valid: false, error: `Unknown configured reviewer: ${spec}` }
    : { valid: true, reviewer };
}

function effectiveTransport(
  reviewer: Pick<ReviewReviewerConfig, "sdk" | "transport">,
): ReviewerTransport {
  return reviewer.transport ?? defaultReviewerTransport(reviewer.sdk) ?? "sdk";
}

async function resolveExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (executable.includes(path.sep)) {
    return (await isExecutable(executable)) ? executable : undefined;
  }

  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, executable);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
