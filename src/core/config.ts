import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  type ReviewerSdk,
  defaultReviewerTransport,
  getTransportCapability,
  isReviewerSdk,
  validateReviewerCapabilityOverrides,
} from "../adapters/capabilities.js";
import { invalidConfig } from "./errors.js";
import { reviewerSdkSchema } from "./schema.js";

const configFileName = "diffwarden.config.json";
const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const effortSchema = z.enum(effortValues);
const transportSchema = z.enum(["sdk", "cli", "app-server"]);
const reportingScopeSchema = z.enum(["global", "repo"]);
const reportingModeSchema = z.enum(["full", "metadata"]);
const reviewPlanConfigSchema = z
  .object({
    includeOverview: z.boolean().optional(),
  })
  .strict();
const configuredReviewerEngineSchema = reviewerSdkSchema.exclude(["fake"]);
const codexAppServerModeSchema = z.enum(["auto", "attach", "launch", "stdio-isolated"]);
const codexWebSearchSchema = z.enum(["enabled", "disabled", "inherit"]);
const codexAppServerReviewModeSchema = z.enum(["structured", "native"]);
const appServerOptionsSchema = z
  .object({
    mode: codexAppServerModeSchema.optional(),
    codexHome: z.string().min(1).optional(),
    webSearch: codexWebSearchSchema.optional(),
    reviewMode: codexAppServerReviewModeSchema.optional(),
  })
  .strict();

const reviewerConfigSchema = z
  .object({
    id: z.string().min(1),
    engine: configuredReviewerEngineSchema,
    transport: transportSchema.optional(),
    profile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
    modelCatalog: z.array(z.string().min(1)).optional(),
    effortCatalog: z.array(effortSchema).optional(),
    timeoutSeconds: z.number().positive().optional(),
    readonly: z.literal(true).optional(),
    cliOptions: z.record(z.string(), z.unknown()).optional(),
    appServerOptions: appServerOptionsSchema.optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    sdkOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .transform((reviewer) => {
    const { engine, transport, ...rest } = reviewer;
    return {
      ...rest,
      sdk: engine,
      ...(transport !== undefined ? { transport } : {}),
    };
  });

export const diffwardenConfigSchema = z
  .object({
    defaultReviewerSet: z.string().min(1).optional(),
    reviewerSets: z.record(z.string(), z.array(z.string().min(1))).optional(),
    reviewers: z.array(reviewerConfigSchema).optional(),
    readonly: z.literal(true).optional(),
    timeoutSeconds: z.number().positive().optional(),
    reviewPlan: reviewPlanConfigSchema.optional(),
    reporting: z
      .object({
        enabled: z.boolean().optional(),
        scope: reportingScopeSchema.optional(),
        dir: z.string().min(1).optional(),
        mode: reportingModeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    const profileKeys = new Set<string>();
    for (const [index, reviewer] of (config.reviewers ?? []).entries()) {
      if (ids.has(reviewer.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate reviewer id: ${reviewer.id}`,
          path: ["reviewers", index, "id"],
        });
      }
      ids.add(reviewer.id);

      if (reviewer.transport === "sdk" && isCliOnlyReviewerSdk(reviewer.sdk)) {
        ctx.addIssue({
          code: "custom",
          message:
            reviewer.sdk === "codex"
              ? `Reviewer ${reviewer.id} must use CLI transport or app-server transport for engine: ${reviewer.sdk}`
              : `Reviewer ${reviewer.id} must use CLI transport for engine: ${reviewer.sdk}`,
          path: ["reviewers", index, "transport"],
        });
      }

      if (
        reviewer.transport !== undefined &&
        getTransportCapability(reviewer.sdk, reviewer.transport)?.supported !== true
      ) {
        ctx.addIssue({
          code: "custom",
          message: `Reviewer ${reviewer.id} does not support ${reviewer.transport} transport for engine: ${reviewer.sdk}`,
          path: ["reviewers", index, "transport"],
        });
      }

      if (reviewer.profile !== undefined) {
        const profileKey = `${reviewer.sdk}:${reviewer.profile}`;
        if (profileKeys.has(profileKey)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate reviewer profile: ${profileKey}`,
            path: ["reviewers", index, "profile"],
          });
        }
        profileKeys.add(profileKey);
      }
    }
  });

export type DiffwardenConfig = z.infer<typeof diffwardenConfigSchema>;

export type LoadedDiffwardenConfig = {
  path: string;
  sha256: string;
  config: DiffwardenConfig;
};

export type LoadDiffwardenConfigOptions = {
  cwd: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type InitDiffwardenConfigOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export async function loadDiffwardenConfig(
  options: LoadDiffwardenConfigOptions,
): Promise<LoadedDiffwardenConfig | undefined> {
  const configPath = findDiffwardenConfigPath(options);
  if (configPath === undefined) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw invalidConfig(`Unable to read config at ${configPath}: ${errorMessage(error)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw invalidConfig(`Invalid JSON in config at ${configPath}: ${errorMessage(error)}`);
  }

  const parsed = diffwardenConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw invalidConfig(`Invalid config at ${configPath}: ${z.prettifyError(parsed.error)}`);
  }

  return {
    path: configPath,
    sha256: sha256(raw),
    config: parsed.data,
  };
}

export async function initDiffwardenConfig(
  options: InitDiffwardenConfigOptions = {},
): Promise<string> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  await createConfigFileExclusive(configPath, starterConfigJson());
  return configPath;
}

/** A reviewer entry in its public, on-disk shape (uses `engine`, not the internal `sdk`). */
export type PublicReviewerEntry = {
  id: string;
  engine: ReviewerSdk;
  transport?: "sdk" | "cli" | "app-server";
  profile?: string;
  provider?: string;
  enabled?: boolean;
  model?: string;
  effort?: string;
};

export type AddReviewerToUserConfigOptions = {
  entry: PublicReviewerEntry;
  reviewerSet?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Optimistic-concurrency token: abort if the file changed since this hash was read. */
  expectedSha256?: string;
};

export type AddReviewerToUserConfigResult = {
  path: string;
  created: boolean;
  action: "added" | "updated";
  sha256: string;
};

/**
 * Merge a reviewer entry into the user config, creating the file if absent. The entry is
 * merged by `id` into the raw JSON (preserving `engine` and every untouched key), validated
 * against the schema before persisting, then written atomically. `defaultReviewerSet` is
 * never changed; an explicit `reviewerSet` only appends the id to that set.
 */
export async function addReviewerToUserConfig(
  options: AddReviewerToUserConfigOptions,
): Promise<AddReviewerToUserConfigResult> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  const existingRaw = await readFileIfExists(configPath);

  if (
    existingRaw !== undefined &&
    options.expectedSha256 !== undefined &&
    sha256(existingRaw) !== options.expectedSha256
  ) {
    throw invalidConfig(`Config changed on disk since it was read: ${configPath}`);
  }

  const rawConfig = existingRaw === undefined ? {} : parseRawConfigObject(existingRaw, configPath);
  const created = existingRaw === undefined;

  const reviewers = Array.isArray(rawConfig.reviewers) ? [...rawConfig.reviewers] : [];
  const action = mergeReviewerById(reviewers, options.entry, configPath);
  rawConfig.reviewers = reviewers;

  if (options.reviewerSet !== undefined) {
    appendToReviewerSet(rawConfig, options.reviewerSet, options.entry.id);
  }

  assertWritableConfig(rawConfig, configPath);

  const serialized = `${JSON.stringify(rawConfig, null, 2)}\n`;
  // Compare-and-swap on every write, not only when a caller passes a token: abort if another
  // process changed the file between our read and our write so concurrent setups cannot clobber.
  await atomicWrite(
    configPath,
    serialized,
    existingRaw === undefined ? { expectAbsent: true } : { expectedSha256: sha256(existingRaw) },
  );

  return { path: configPath, created, action, sha256: sha256(serialized) };
}

export type CreateDiscoveredUserConfigOptions = {
  reviewers: PublicReviewerEntry[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

/**
 * Scaffold a fresh user config from discovered reviewers: one reviewer set listing them all,
 * `defaultReviewerSet` pointing at it, and read-only enabled. Create-only (never clobbers).
 */
export async function createDiscoveredUserConfig(
  options: CreateDiscoveredUserConfigOptions,
): Promise<string> {
  if (options.reviewers.length === 0) {
    throw invalidConfig("No reviewers to write");
  }
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  const rawConfig: Record<string, unknown> = {
    defaultReviewerSet: "1",
    reviewerSets: { "1": options.reviewers.map((reviewer) => reviewer.id) },
    reviewers: options.reviewers.map(buildReviewerEntryObject),
    readonly: true,
  };
  assertWritableConfig(rawConfig, configPath);
  await createConfigFileExclusive(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`);
  return configPath;
}

/**
 * Read the env-located user config, apply `mutate` to its raw JSON, schema-validate, and write
 * atomically with a compare-and-swap on the bytes we read. Errors if no user config exists yet.
 * Shared by remove / edit / set so every mutation keeps the same atomic, validated write contract.
 */
async function mutateUserConfig<T>(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string; expectedSha256?: string },
  mutate: (rawConfig: Record<string, unknown>, configPath: string) => T,
): Promise<{ path: string; sha256: string; result: T }> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  const existingRaw = await readFileIfExists(configPath);
  if (existingRaw === undefined) {
    throw invalidConfig(
      `No diffwarden user config at ${configPath}. Run diffwarden init or diffwarden reviewers add <engine> first.`,
    );
  }
  if (options.expectedSha256 !== undefined && sha256(existingRaw) !== options.expectedSha256) {
    throw invalidConfig(`Config changed on disk since it was read: ${configPath}`);
  }

  const rawConfig = parseRawConfigObject(existingRaw, configPath);
  const result = mutate(rawConfig, configPath);
  assertWritableConfig(rawConfig, configPath);
  const serialized = `${JSON.stringify(rawConfig, null, 2)}\n`;
  await atomicWrite(configPath, serialized, { expectedSha256: sha256(existingRaw) });
  return { path: configPath, sha256: sha256(serialized), result };
}

function findReviewerIndexById(reviewers: unknown[], id: string): number {
  return reviewers.findIndex((reviewer) => isRecord(reviewer) && reviewer.id === id);
}

/** Remove `reviewerId` from every reviewer set, returning the names of sets it was pruned from. */
function pruneReviewerFromSets(rawConfig: Record<string, unknown>, reviewerId: string): string[] {
  if (!isRecord(rawConfig.reviewerSets)) {
    return [];
  }
  const sets = rawConfig.reviewerSets;
  const pruned: string[] = [];
  for (const [name, members] of Object.entries(sets)) {
    if (Array.isArray(members) && members.includes(reviewerId)) {
      sets[name] = members.filter((member) => member !== reviewerId);
      pruned.push(name);
    }
  }
  return pruned;
}

/** Refuse to leave `defaultReviewerSet` pointing at an empty/missing set unless `force` is set. */
function guardDefaultReviewerSet(
  rawConfig: Record<string, unknown>,
  configPath: string,
  force: boolean,
): void {
  if (force || typeof rawConfig.defaultReviewerSet !== "string") {
    return;
  }
  const setName = rawConfig.defaultReviewerSet;
  const sets = isRecord(rawConfig.reviewerSets) ? rawConfig.reviewerSets : {};
  const members = sets[setName];
  if (Array.isArray(members) && members.length > 0) {
    return;
  }
  throw invalidConfig(
    `This leaves the default reviewer set "${setName}" empty in ${configPath}. Re-run with --force to proceed, or repoint defaultReviewerSet first.`,
  );
}

export type RemoveReviewerFromUserConfigOptions = {
  id: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
};

export type RemoveReviewerFromUserConfigResult = {
  path: string;
  prunedFromSets: string[];
  sha256: string;
};

/**
 * Delete a configured reviewer by id and prune it from every reviewer set. Refuses (unless
 * `force`) when this would leave `defaultReviewerSet` empty. Errors if the id is not configured.
 */
export async function removeReviewerFromUserConfig(
  options: RemoveReviewerFromUserConfigOptions,
): Promise<RemoveReviewerFromUserConfigResult> {
  const {
    path,
    sha256: digest,
    result,
  } = await mutateUserConfig(options, (rawConfig, configPath) => {
    const reviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
    const index = findReviewerIndexById(reviewers, options.id);
    if (index < 0) {
      throw invalidConfig(`No reviewer with id "${options.id}" in ${configPath}`);
    }
    reviewers.splice(index, 1);
    rawConfig.reviewers = reviewers;
    const prunedFromSets = pruneReviewerFromSets(rawConfig, options.id);
    guardDefaultReviewerSet(rawConfig, configPath, options.force === true);
    return { prunedFromSets };
  });
  return { path, prunedFromSets: result.prunedFromSets, sha256: digest };
}

/** Fields `reviewers edit` can patch; only provided keys change, the rest of the entry survives. */
export type EditReviewerPatch = {
  transport?: "sdk" | "cli" | "app-server";
  provider?: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
};

export type EditReviewerInUserConfigOptions = {
  id: string;
  patch: EditReviewerPatch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
};

export type EditReviewerInUserConfigResult = {
  path: string;
  reviewer: Record<string, unknown>;
  sha256: string;
};

/**
 * Patch individual fields on an existing reviewer, preserving untouched keys (sdkOptions, profile,
 * etc.). `enabled: true` clears the disabled placeholder; `false` sets it. Validates the resulting
 * transport/model/effort against the capability registry before writing. Errors if id is absent.
 */
export async function editReviewerInUserConfig(
  options: EditReviewerInUserConfigOptions,
): Promise<EditReviewerInUserConfigResult> {
  const {
    path,
    sha256: digest,
    result,
  } = await mutateUserConfig(options, (rawConfig, configPath) => {
    const reviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
    const index = findReviewerIndexById(reviewers, options.id);
    if (index < 0) {
      throw invalidConfig(`No reviewer with id "${options.id}" in ${configPath}`);
    }
    const existing = reviewers[index] as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    const { patch } = options;
    if (patch.transport !== undefined) {
      merged.transport = patch.transport;
    }
    if (patch.provider !== undefined) {
      merged.provider = patch.provider;
    }
    if (patch.model !== undefined) {
      merged.model = patch.model;
    }
    if (patch.effort !== undefined) {
      merged.effort = patch.effort;
    }
    if (patch.enabled === false) {
      merged.enabled = false;
    } else if (patch.enabled === true) {
      // Clearing the disabled placeholder: undefined is dropped by JSON.stringify, so the
      // reviewer reads as active (we omit `enabled` for enabled reviewers).
      merged.enabled = undefined;
    }

    // Guard the engine before any capability lookup: a hand-edited/legacy config could carry an
    // unknown engine, and capability helpers index the registry by engine — an unknown key would
    // throw an uncaught TypeError instead of a clean, write-nothing config error.
    const engineValue = existing.engine;
    if (typeof engineValue !== "string" || !isReviewerSdk(engineValue)) {
      throw invalidConfig(
        `Reviewer "${options.id}" in ${configPath} has an unknown engine and cannot be edited: ${String(engineValue)}`,
      );
    }

    // Reject overrides the resulting transport cannot honor before writing, so the failure is at
    // edit time rather than at the next review/preflight. Resolve the effective transport the way
    // resolution does (an omitted transport falls back to the engine default) so model/effort are
    // validated against the transport that will actually run, not a phantom "sdk".
    const engine = engineValue;
    const effectiveTransport =
      (typeof merged.transport === "string"
        ? (merged.transport as "sdk" | "cli" | "app-server")
        : undefined) ??
      defaultReviewerTransport(engine) ??
      "sdk";
    validateReviewerCapabilityOverrides({
      id: String(merged.id),
      sdk: engine,
      transport: effectiveTransport,
      ...(typeof merged.model === "string" ? { model: merged.model } : {}),
      ...(typeof merged.effort === "string"
        ? { effort: merged.effort as EditReviewerPatch["effort"] }
        : {}),
      readonly: true,
    } as Parameters<typeof validateReviewerCapabilityOverrides>[0]);

    reviewers[index] = merged;
    rawConfig.reviewers = reviewers;
    return { reviewer: merged };
  });
  return { path, reviewer: result.reviewer, sha256: digest };
}

/** A configured reviewer in summary form for interactive pickers (id + engine + enabled state). */
export type ConfiguredReviewerSummary = {
  id: string;
  engine: string;
  enabled: boolean;
};

/**
 * Read the configured reviewers from the user config so the no-id `reviewers remove` / `edit`
 * interactive paths can present a picker. Read-only; throws the same missing-config error as the
 * mutators when no user config exists. Entries without a string id are skipped because they cannot
 * be targeted by id anyway.
 */
export async function listUserConfigReviewers(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<{ path: string; reviewers: ConfiguredReviewerSummary[] }> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  const existingRaw = await readFileIfExists(configPath);
  if (existingRaw === undefined) {
    throw invalidConfig(
      `No diffwarden user config at ${configPath}. Run diffwarden init or diffwarden reviewers add <engine> first.`,
    );
  }
  const rawConfig = parseRawConfigObject(existingRaw, configPath);
  const rawReviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
  const reviewers: ConfiguredReviewerSummary[] = [];
  for (const reviewer of rawReviewers) {
    if (!isRecord(reviewer) || typeof reviewer.id !== "string") {
      continue;
    }
    reviewers.push({
      id: reviewer.id,
      engine: typeof reviewer.engine === "string" ? reviewer.engine : "unknown",
      enabled: reviewer.enabled !== false,
    });
  }
  return { path: configPath, reviewers };
}

export type ReviewerSetMembershipOptions = {
  setName: string;
  reviewerId: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
};

export type ReviewerSetMembershipResult = {
  path: string;
  set: string;
  members: string[];
  sha256: string;
};

/** Add a configured reviewer id to a reviewer set (creating the set if needed). */
export async function addReviewerToSetInUserConfig(
  options: ReviewerSetMembershipOptions,
): Promise<ReviewerSetMembershipResult> {
  const {
    path,
    sha256: digest,
    result,
  } = await mutateUserConfig(options, (rawConfig, configPath) => {
    const reviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
    if (findReviewerIndexById(reviewers, options.reviewerId) < 0) {
      throw invalidConfig(
        `No reviewer with id "${options.reviewerId}" in ${configPath}; add it before adding it to a set`,
      );
    }
    appendToReviewerSet(rawConfig, options.setName, options.reviewerId);
    const sets = rawConfig.reviewerSets as Record<string, unknown>;
    return { members: (sets[options.setName] as string[]).slice() };
  });
  return { path, set: options.setName, members: result.members, sha256: digest };
}

/** Remove a reviewer id from a reviewer set. Refuses (unless force) if it empties the default set. */
export async function removeReviewerFromSetInUserConfig(
  options: ReviewerSetMembershipOptions,
): Promise<ReviewerSetMembershipResult> {
  const {
    path,
    sha256: digest,
    result,
  } = await mutateUserConfig(options, (rawConfig, configPath) => {
    const sets = isRecord(rawConfig.reviewerSets) ? rawConfig.reviewerSets : {};
    const members = sets[options.setName];
    if (!Array.isArray(members) || !members.includes(options.reviewerId)) {
      throw invalidConfig(
        `Reviewer set "${options.setName}" does not contain "${options.reviewerId}" in ${configPath}`,
      );
    }
    const remaining = members.filter((member) => member !== options.reviewerId);
    sets[options.setName] = remaining;
    rawConfig.reviewerSets = sets;
    guardDefaultReviewerSet(rawConfig, configPath, options.force === true);
    return { members: remaining.slice() };
  });
  return { path, set: options.setName, members: result.members, sha256: digest };
}

async function createConfigFileExclusive(configPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  try {
    await writeFile(configPath, content, { flag: "wx" });
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw invalidConfig(`Config already exists: ${configPath}`);
    }
    throw invalidConfig(`Unable to create config at ${configPath}: ${errorMessage(error)}`);
  }
}

type AtomicWriteGuard = { expectedSha256?: string; expectAbsent?: boolean };

async function atomicWrite(
  configPath: string,
  content: string,
  guard: AtomicWriteGuard = {},
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(tempPath, content, "utf8");
  try {
    // Re-check the target immediately before swapping so a concurrent write since our read is
    // detected instead of silently overwritten.
    const current = await readFileIfExists(configPath);
    const changed =
      guard.expectAbsent === true
        ? current !== undefined
        : guard.expectedSha256 !== undefined &&
          (current === undefined || sha256(current) !== guard.expectedSha256);
    if (changed) {
      throw invalidConfig(`Config changed on disk since it was read: ${configPath}`);
    }
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw invalidConfig(`Unable to read config at ${filePath}: ${errorMessage(error)}`);
  }
}

function parseRawConfigObject(raw: string, configPath: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw invalidConfig(`Invalid JSON in config at ${configPath}: ${errorMessage(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw invalidConfig(`Config at ${configPath} must be a JSON object`);
  }
  return data as Record<string, unknown>;
}

function buildReviewerEntryObject(entry: PublicReviewerEntry): Record<string, unknown> {
  return {
    id: entry.id,
    engine: entry.engine,
    ...(entry.transport !== undefined ? { transport: entry.transport } : {}),
    ...(entry.profile !== undefined ? { profile: entry.profile } : {}),
    ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
    // Omit `enabled` for active reviewers; only persist the disabled placeholder flag.
    ...(entry.enabled === false ? { enabled: false } : {}),
  };
}

function mergeReviewerById(
  reviewers: unknown[],
  entry: PublicReviewerEntry,
  configPath: string,
): "added" | "updated" {
  if (entry.profile !== undefined) {
    const collision = reviewers.find(
      (reviewer) =>
        isRecord(reviewer) &&
        reviewer.id !== entry.id &&
        reviewer.engine === entry.engine &&
        reviewer.profile === entry.profile,
    );
    if (collision !== undefined) {
      throw invalidConfig(
        `Config at ${configPath} already has a ${entry.engine}:${entry.profile} reviewer profile`,
      );
    }
  }

  const entryObject = buildReviewerEntryObject(entry);
  const index = reviewers.findIndex((reviewer) => isRecord(reviewer) && reviewer.id === entry.id);
  if (index >= 0) {
    // Merge over the existing entry so fields the add command does not express (sdkOptions,
    // cliOptions, effort, enabled:false, etc.) survive an update by id.
    const existing = reviewers[index];
    reviewers[index] = isRecord(existing) ? { ...existing, ...entryObject } : entryObject;
    return "updated";
  }
  reviewers.push(entryObject);
  return "added";
}

function appendToReviewerSet(
  rawConfig: Record<string, unknown>,
  setName: string,
  reviewerId: string,
): void {
  const sets = isRecord(rawConfig.reviewerSets) ? rawConfig.reviewerSets : {};
  const existing = Array.isArray(sets[setName]) ? (sets[setName] as unknown[]) : [];
  if (!existing.includes(reviewerId)) {
    existing.push(reviewerId);
  }
  sets[setName] = existing;
  rawConfig.reviewerSets = sets;
}

function assertWritableConfig(rawConfig: unknown, configPath: string): void {
  const parsed = diffwardenConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw invalidConfig(
      `Refusing to write invalid config to ${configPath}: ${z.prettifyError(parsed.error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findDiffwardenConfigPath(options: LoadDiffwardenConfigOptions): string | undefined {
  const projectPath = findProjectConfigPath(options.cwd, options.repoRoot);
  if (projectPath !== undefined) {
    return projectPath;
  }

  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  if (existsSync(configPath)) {
    return configPath;
  }

  return undefined;
}

export function userConfigPath(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  return path.join(
    env.XDG_CONFIG_HOME?.trim()
      ? env.XDG_CONFIG_HOME
      : path.join(env.HOME?.trim() ? env.HOME : homeDir, ".config"),
    "diffwarden",
    configFileName,
  );
}

function starterConfigJson(): string {
  return `${JSON.stringify(
    {
      defaultReviewerSet: "1",
      reviewerSets: {
        "1": ["pi-default"],
      },
      reviewers: [
        {
          id: "pi-default",
          engine: "pi",
        },
      ],
      readonly: true,
    },
    null,
    2,
  )}\n`;
}

function findProjectConfigPath(cwd: string, repoRoot: string | undefined): string | undefined {
  let current = path.resolve(cwd);
  const stopAt = repoRoot === undefined ? path.parse(current).root : path.resolve(repoRoot);

  while (true) {
    const candidate = path.join(current, configFileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (current === stopAt) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
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

function isCliOnlyReviewerSdk(sdk: string): boolean {
  return (
    sdk === "codex" ||
    sdk === "gemini" ||
    sdk === "opencode" ||
    sdk === "grok" ||
    sdk === "antigravity"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
