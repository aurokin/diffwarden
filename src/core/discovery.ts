import { access, constants as fsConstants } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import {
  type ReviewerAuthSignal,
  type ReviewerSdk,
  type ReviewerTransport,
  defaultReviewerModel,
  defaultReviewerTransport,
  getReviewerAuthSignal,
  getReviewerCapability,
  getTransportCapability,
  reviewerSdkPackage,
  reviewerSdkValues,
} from "../adapters/capabilities.js";
import { resolveExecutable } from "../adapters/cli-process.js";
import { type HumanStyle, createStyle } from "./human-render.js";
import type { ReviewerPreflightReport } from "./runner.js";

/**
 * Host-aware reviewer discovery. Probes the current host for which reviewer engines
 * and transports are usable without spending model budget or running review prompts,
 * classifies each candidate, and recommends config entries for available engines.
 */

export type ReviewerCandidateStatus =
  | "available"
  | "missing_executable"
  | "missing_auth"
  | "requires_env"
  | "unsupported_host"
  | "preflight_failed";

export type ReviewerCandidateAuthState = "verified" | "unverified" | "missing" | "not_required";

export type ReviewerCandidateRecommendation = {
  id: string;
  engine: ReviewerSdk;
  transport?: ReviewerTransport;
  model?: string;
};

export type ReviewerDiscoveryCandidate = {
  engine: ReviewerSdk;
  transport: ReviewerTransport;
  status: ReviewerCandidateStatus;
  authState: ReviewerCandidateAuthState;
  detail: string;
  executable?: { name: string; resolved: boolean; path?: string };
  sdkPackage?: { name: string; resolved: boolean };
  /**
   * The auth signals discovery probed for this engine: environment-variable names and the
   * canonical credential-file location. Names and paths only; never secret values.
   */
  authSignals?: {
    envVars?: string[];
    credentialFile?: { path: string; baseEnvVar?: string };
  };
  recommended?: ReviewerCandidateRecommendation;
};

export type ReviewerDiscoveryResult = {
  schema_version: 1;
  cwd: string;
  deep: boolean;
  candidates: ReviewerDiscoveryCandidate[];
  summary: {
    available: string[];
    needsAttention: string[];
    missing: string[];
  };
};

/** Token-free probes used by discovery. Injectable so unit tests stay host-independent. */
export type DiscoveryProbes = {
  /** Resolve an executable through PATH, returning its path or undefined when absent. */
  resolveExecutable: (
    name: string,
    env: NodeJS.ProcessEnv | undefined,
  ) => Promise<string | undefined>;
  /** Whether an npm package can be resolved (side-effect-free; does not execute it). */
  resolvePackage: (pkg: string) => boolean;
  /** Whether a credential file is readable. */
  fileReadable: (filePath: string) => Promise<boolean>;
};

/** A specific (engine, transport) candidate to deep-preflight. */
export type ReviewerDeepPreflightTarget = { engine: ReviewerSdk; transport: ReviewerTransport };

export type DeepPreflight = (
  targets: ReviewerDeepPreflightTarget[],
) => Promise<ReviewerPreflightReport>;

export type DiscoverReviewersOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  deep?: boolean;
  probes?: Partial<DiscoveryProbes>;
  /** Runs adapter preflight for `--deep`; injected so the spawn path is reusable and testable. */
  deepPreflight?: DeepPreflight;
};

const moduleRequire = createRequire(import.meta.url);

const defaultProbes: DiscoveryProbes = {
  async resolveExecutable(name, env) {
    try {
      return await resolveExecutable(name, env);
    } catch {
      return undefined;
    }
  },
  resolvePackage(pkg) {
    try {
      // import.meta.resolve handles ESM-only packages whose exports map omits a require condition.
      import.meta.resolve(pkg);
      return true;
    } catch {
      // Fall back for runtimes without import.meta.resolve.
    }
    try {
      moduleRequire.resolve(pkg);
      return true;
    } catch {
      return false;
    }
  },
  async fileReadable(filePath) {
    try {
      await access(filePath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export async function discoverReviewers(
  options: DiscoverReviewersOptions,
): Promise<ReviewerDiscoveryResult> {
  const env = options.env ?? process.env;
  const probes: DiscoveryProbes = { ...defaultProbes, ...options.probes };
  const home = resolveHome(env, options.homeDir);
  const deep = options.deep === true;

  let candidates: ReviewerDiscoveryCandidate[] = [];
  for (const engine of reviewerSdkValues) {
    if (engine === "fake") {
      continue;
    }
    const auth = getReviewerAuthSignal(engine);
    const authProbe = await probeAuth(auth, env, home, probes);
    const authSignals = describeAuthSignals(auth);
    for (const transport of supportedTransports(engine)) {
      const candidate = await probeCandidate({ engine, transport, auth, authProbe, env, probes });
      candidates.push(authSignals !== undefined ? { ...candidate, authSignals } : candidate);
    }
  }

  if (deep && options.deepPreflight !== undefined) {
    // Preflight each present transport, not one collapsed entry per engine: a non-default
    // transport (e.g. codex app-server, or a CLI when the SDK is the default) must be verified
    // on its own, otherwise it would keep a shallow verdict that deep was asked to confirm.
    const targets = candidates
      .filter((candidate) => candidate.status !== "missing_executable")
      .map((candidate) => ({ engine: candidate.engine, transport: candidate.transport }));
    if (targets.length > 0) {
      const report = await options.deepPreflight(targets);
      candidates = applyDeepPreflight(candidates, report);
    }
  }

  // Sort after deep refinement so the order reflects the final auth state / status of each candidate.
  candidates.sort(compareDiscoveryCandidates);

  return {
    schema_version: 1,
    cwd: options.cwd,
    deep,
    candidates,
    summary: summarize(candidates),
  };
}

function supportedTransports(engine: ReviewerSdk): ReviewerTransport[] {
  const transports = getReviewerCapability(engine).transports;
  return (Object.keys(transports) as ReviewerTransport[]).filter(
    (transport) => transports[transport]?.supported === true,
  );
}

type AuthProbe = { envPresent: boolean; credentialFilePresent: boolean };

async function probeAuth(
  auth: ReviewerAuthSignal | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
  probes: DiscoveryProbes,
): Promise<AuthProbe> {
  if (auth === undefined) {
    return { envPresent: false, credentialFilePresent: false };
  }
  const envPresent = (auth.envVars ?? []).some((name) => (env[name]?.trim() ?? "") !== "");
  const credentialFilePresent =
    auth.credentialFile !== undefined &&
    (await probes.fileReadable(resolveCredentialFile(auth.credentialFile, env, home)));
  return { envPresent, credentialFilePresent };
}

async function probeCandidate(input: {
  engine: ReviewerSdk;
  transport: ReviewerTransport;
  auth: ReviewerAuthSignal | undefined;
  authProbe: AuthProbe;
  env: NodeJS.ProcessEnv;
  probes: DiscoveryProbes;
}): Promise<ReviewerDiscoveryCandidate> {
  const { engine, transport, auth, authProbe, env, probes } = input;

  if (transport === "sdk") {
    const name = reviewerSdkPackage(engine);
    const resolved = name !== undefined && probes.resolvePackage(name);
    if (name === undefined || !resolved) {
      return {
        engine,
        transport,
        status: "missing_executable",
        authState: "missing",
        detail: `SDK package ${name ?? "(unknown)"} is not installed.`,
        ...(name !== undefined ? { sdkPackage: { name, resolved: false } } : {}),
      };
    }
    return finishPresentCandidate({
      engine,
      transport,
      auth,
      authProbe,
      sdkPackage: { name, resolved },
    });
  }

  const name = getTransportCapability(engine, transport)?.defaultExecutable;
  const resolvedPath = name === undefined ? undefined : await probes.resolveExecutable(name, env);
  if (name === undefined || resolvedPath === undefined) {
    return {
      engine,
      transport,
      status: "missing_executable",
      authState: "missing",
      detail: `Executable ${name ?? "(unknown)"} was not found on PATH.`,
      ...(name !== undefined ? { executable: { name, resolved: false } } : {}),
    };
  }
  return finishPresentCandidate({
    engine,
    transport,
    auth,
    authProbe,
    executable: { name, resolved: true, path: resolvedPath },
  });
}

function finishPresentCandidate(input: {
  engine: ReviewerSdk;
  transport: ReviewerTransport;
  auth: ReviewerAuthSignal | undefined;
  authProbe: AuthProbe;
  executable?: ReviewerDiscoveryCandidate["executable"];
  sdkPackage?: ReviewerDiscoveryCandidate["sdkPackage"];
}): ReviewerDiscoveryCandidate {
  const delegatedApplies = input.auth?.explicitAuthTransports?.includes(input.transport) !== true;
  const classification = classifyPresentCandidate(input.auth, input.authProbe, delegatedApplies);
  return {
    engine: input.engine,
    transport: input.transport,
    status: classification.status,
    authState: classification.authState,
    detail: classification.detail,
    ...(input.executable !== undefined ? { executable: input.executable } : {}),
    ...(input.sdkPackage !== undefined ? { sdkPackage: input.sdkPackage } : {}),
    ...(classification.status === "available"
      ? { recommended: recommendReviewerEntry(input.engine, input.transport) }
      : {}),
  };
}

/**
 * Classify an engine whose executable/SDK is present, from token-free auth signals only.
 * Pure: no host access. `unsupported_host` and `preflight_failed` come from `--deep` instead.
 */
export function classifyPresentCandidate(
  auth: ReviewerAuthSignal | undefined,
  probe: AuthProbe,
  delegatedApplies = true,
): { status: ReviewerCandidateStatus; authState: ReviewerCandidateAuthState; detail: string } {
  if (auth === undefined) {
    return { status: "available", authState: "not_required", detail: "Ready to use." };
  }
  // Delegated login only counts for transports that can actually use it (e.g. not the Cursor SDK).
  const loginDelegated = auth.loginDelegated === true && delegatedApplies;
  if (probe.envPresent) {
    return {
      status: "available",
      authState: "verified",
      detail: `Authenticated via ${formatEnvVars(auth.envVars)}.`,
    };
  }
  if (probe.credentialFilePresent && auth.credentialFile !== undefined) {
    return {
      status: "available",
      authState: "verified",
      detail: `Authenticated via ${credentialFileLabel(auth.credentialFile)}.`,
    };
  }
  if (auth.envVars !== undefined && auth.envVars.length > 0 && auth.envVarsOptional === true) {
    const loginNote = loginDelegated ? ", or sign in via the engine's own login" : "";
    return {
      status: "requires_env",
      authState: "unverified",
      detail: `Set ${formatEnvVars(auth.envVars)}${loginNote}.`,
    };
  }
  if (loginDelegated) {
    return {
      status: "available",
      authState: "unverified",
      detail: "Installed; auth is delegated to the engine's own login and was not verified.",
    };
  }
  return { status: "missing_auth", authState: "missing", detail: missingAuthDetail(auth) };
}

/** Refine candidates with adapter preflight results from `--deep`. Pure. */
export function applyDeepPreflight(
  candidates: ReviewerDiscoveryCandidate[],
  report: ReviewerPreflightReport,
): ReviewerDiscoveryCandidate[] {
  return candidates.map((candidate) => {
    // Match is exact per (engine, transport): candidates are unique per transport (one per
    // supportedTransports entry), the deep report carries one entry per transport each with its
    // own pinned transport, and publicTransportToInternal is injective. So transports of the same
    // engine never collapse onto one result — see the "preflights each present transport" test.
    const entry = report.reviewers.find(
      (reviewer) =>
        reviewer.engine === candidate.engine &&
        publicTransportToInternal(reviewer.transport) === candidate.transport,
    );
    if (entry === undefined) {
      return candidate;
    }

    if (entry.status === "passed") {
      // A pass confirms the executable/SDK and host support, but CLI/app-server preflight skips
      // auth (it is delegated to the executable). So a pass must not invent an auth verdict the
      // probe never made: keep a shallow missing_auth, and preserve the shallow authState rather
      // than claiming "verified" for delegated-login engines (e.g. opencode, grok).
      if (candidate.status === "missing_auth") {
        return candidate;
      }
      const authVerified = candidate.authState === "verified";
      return {
        ...candidate,
        status: "available",
        detail: authVerified
          ? "Adapter preflight passed."
          : "Adapter preflight passed; auth is delegated to the engine's own login and was not verified.",
        ...(candidate.recommended === undefined
          ? { recommended: recommendReviewerEntry(candidate.engine, candidate.transport) }
          : {}),
      };
    }

    const mapped = mapPreflightError(entry.error?.code, entry.error?.message);
    const { recommended: _dropped, ...withoutRecommendation } = candidate;
    return {
      ...withoutRecommendation,
      status: mapped.status,
      authState: mapped.authState,
      detail: entry.error?.message ?? mapped.detail,
    };
  });
}

function mapPreflightError(
  code: string | undefined,
  message: string | undefined,
): { status: ReviewerCandidateStatus; authState: ReviewerCandidateAuthState; detail: string } {
  switch (code) {
    case "missing_auth":
      return { status: "missing_auth", authState: "missing", detail: "Authentication required." };
    case "reviewer_environment_failed":
      return {
        status: "unsupported_host",
        authState: "unverified",
        detail: "Reviewer environment is unsupported on this host.",
      };
    case "missing_requirement":
      return (message ?? "").toLowerCase().includes("not found")
        ? {
            status: "missing_executable",
            authState: "missing",
            detail: "Required executable was not found.",
          }
        : {
            status: "preflight_failed",
            authState: "unverified",
            detail: "Adapter preflight failed.",
          };
    default:
      return {
        status: "preflight_failed",
        authState: "unverified",
        detail: "Adapter preflight failed.",
      };
  }
}

export function recommendReviewerEntry(
  engine: ReviewerSdk,
  transport: ReviewerTransport,
): ReviewerCandidateRecommendation {
  // An omitted transport resolves to defaultTransport, falling back to "sdk"; treat that
  // as the primary so its recommended entry stays minimal (no redundant transport field).
  const primaryTransport = defaultReviewerTransport(engine) ?? "sdk";
  const isPrimary = transport === primaryTransport;
  const model = defaultReviewerModel(engine);
  return {
    id: isPrimary ? engine : `${engine}-${transport}`,
    engine,
    ...(isPrimary ? {} : { transport }),
    ...(model !== undefined ? { model } : {}),
  };
}

function missingAuthDetail(auth: ReviewerAuthSignal): string {
  if (auth.envVars !== undefined && auth.envVars.length > 0) {
    return `Set ${formatEnvVars(auth.envVars)}.`;
  }
  if (auth.credentialFile !== undefined) {
    return `Authenticate to create ${credentialFileLabel(auth.credentialFile)}.`;
  }
  return "Authentication required.";
}

function formatEnvVars(envVars: readonly string[] | undefined): string {
  return (envVars ?? []).join(" or ");
}

function credentialFileLabel(file: NonNullable<ReviewerAuthSignal["credentialFile"]>): string {
  const homePath = `~/${file.homeSubdir}/${file.file}`;
  return file.baseEnvVar !== undefined ? `${homePath} (or $${file.baseEnvVar})` : homePath;
}

function resolveCredentialFile(
  file: NonNullable<ReviewerAuthSignal["credentialFile"]>,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const base =
    file.baseEnvVar !== undefined && (env[file.baseEnvVar]?.trim() ?? "") !== ""
      ? (env[file.baseEnvVar] as string).trim()
      : path.join(home, file.homeSubdir);
  return path.join(base, file.file);
}

function resolveHome(env: NodeJS.ProcessEnv, homeDir: string | undefined): string {
  return homeDir ?? (env.HOME?.trim() ? env.HOME.trim() : env.USERPROFILE?.trim() || homedir());
}

function publicTransportToInternal(
  transport: "native" | "cli" | "app-server" | undefined,
): ReviewerTransport | undefined {
  if (transport === undefined) {
    return undefined;
  }
  return transport === "native" ? "sdk" : transport;
}

function describeAuthSignals(
  auth: ReviewerAuthSignal | undefined,
): ReviewerDiscoveryCandidate["authSignals"] | undefined {
  if (auth === undefined) {
    return undefined;
  }
  const envVars =
    auth.envVars !== undefined && auth.envVars.length > 0 ? [...auth.envVars] : undefined;
  const credentialFile =
    auth.credentialFile !== undefined
      ? {
          path: `~/${auth.credentialFile.homeSubdir}/${auth.credentialFile.file}`,
          ...(auth.credentialFile.baseEnvVar !== undefined
            ? { baseEnvVar: auth.credentialFile.baseEnvVar }
            : {}),
        }
      : undefined;
  if (envVars === undefined && credentialFile === undefined) {
    return undefined;
  }
  return {
    ...(envVars !== undefined ? { envVars } : {}),
    ...(credentialFile !== undefined ? { credentialFile } : {}),
  };
}

function candidateKey(candidate: ReviewerDiscoveryCandidate): string {
  return `${candidate.engine}:${candidate.transport}`;
}

const needsAttentionStatuses = new Set<ReviewerCandidateStatus>([
  "missing_auth",
  "requires_env",
  "preflight_failed",
  "unsupported_host",
]);

// Stable display/JSON order. Status group is the primary key so the flat candidates array reads
// top-to-bottom in the same order as the grouped human output (Ready / Needs attention / Not
// installed); these ranks mirror the render's group filters exactly.
const statusGroupOrder: Record<ReviewerCandidateStatus, number> = {
  available: 0,
  missing_auth: 1,
  requires_env: 1,
  preflight_failed: 1,
  unsupported_host: 1,
  missing_executable: 2,
};

// Verified reviewers (auth we confirmed) sort ahead of delegated/unverified ones within a group.
const authStateOrder: Record<ReviewerCandidateAuthState, number> = {
  verified: 0,
  not_required: 1,
  unverified: 2,
  missing: 3,
};

const transportOrder: Record<ReviewerTransport, number> = {
  sdk: 0,
  cli: 1,
  "app-server": 2,
};

/** Sort within each status group: verified first, then engine A→Z, then native → cli → app-server. */
function compareDiscoveryCandidates(
  a: ReviewerDiscoveryCandidate,
  b: ReviewerDiscoveryCandidate,
): number {
  return (
    statusGroupOrder[a.status] - statusGroupOrder[b.status] ||
    authStateOrder[a.authState] - authStateOrder[b.authState] ||
    a.engine.localeCompare(b.engine) ||
    transportOrder[a.transport] - transportOrder[b.transport]
  );
}

function summarize(candidates: ReviewerDiscoveryCandidate[]): ReviewerDiscoveryResult["summary"] {
  return {
    available: candidates.filter((c) => c.status === "available").map(candidateKey),
    needsAttention: candidates
      .filter((c) => needsAttentionStatuses.has(c.status))
      .map(candidateKey),
    missing: candidates.filter((c) => c.status === "missing_executable").map(candidateKey),
  };
}

const publicTransportLabel: Record<ReviewerTransport, string> = {
  sdk: "native",
  cli: "cli",
  "app-server": "app-server",
};

export type ReviewerDiscoveryRenderOptions = {
  color?: boolean;
};

/**
 * Frameworkless human display for discovery: grouped status rows, no tables, no width
 * assumptions, plain-text when color is off (non-TTY/CI/NO_COLOR). Not a parsing contract.
 */
export function renderReviewerDiscoveryText(
  result: ReviewerDiscoveryResult,
  options: ReviewerDiscoveryRenderOptions = {},
): string {
  const style = createStyle({ color: options.color === true });
  const lines = [style.heading("Diffwarden reviewer discovery"), ""];

  const ready = result.candidates.filter((candidate) => candidate.status === "available");
  const attention = result.candidates.filter((candidate) =>
    needsAttentionStatuses.has(candidate.status),
  );
  const missing = result.candidates.filter(
    (candidate) => candidate.status === "missing_executable",
  );

  appendGroup(lines, style, "Ready to use", ready);
  appendGroup(lines, style, "Needs attention", attention);
  appendGroup(lines, style, "Not installed", missing);

  lines.push(
    "",
    style.muted(
      result.deep
        ? "Deep probe ran adapter preflight checks."
        : "Shallow probe only (no model spend). Re-run with --deep to verify auth and host support.",
    ),
  );
  if (ready.length > 0) {
    lines.push(style.muted("Add a reviewer to config: diffwarden reviewers add <engine>"));
  }

  return `${lines.join("\n")}\n`;
}

function appendGroup(
  lines: string[],
  style: HumanStyle,
  title: string,
  candidates: ReviewerDiscoveryCandidate[],
): void {
  lines.push(style.heading(`${title} (${candidates.length})`));
  if (candidates.length === 0) {
    lines.push(style.muted("  (none)"), "");
    return;
  }
  for (const candidate of candidates) {
    const glyph = statusGlyph(candidate.status, style);
    const label = `${candidate.engine} ${style.muted(`[${publicTransportLabel[candidate.transport]}]`)}`;
    lines.push(`  ${glyph} ${label} — ${candidate.detail}`);
  }
  lines.push("");
}

function statusGlyph(status: ReviewerCandidateStatus, style: HumanStyle): string {
  switch (status) {
    case "available":
      return style.success("✓");
    case "missing_executable":
      return style.danger("✗");
    default:
      return style.warning("→");
  }
}
