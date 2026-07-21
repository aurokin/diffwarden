import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  type ReviewerSdk,
  defaultReviewerTransport,
  getTransportCapability,
  isReviewerSdk,
  reviewerLimitCapabilityErrors,
  validateReviewerCapabilityOverrides,
} from "../adapters/capabilities.js";
import { invalidConfig } from "./errors.js";
import { reviewerSdkSchema } from "./schema.js";

const configFileName = "diffwarden.config.json";
const localConfigFileName = "diffwarden.config.local.json";
const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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
    fallbackModel: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
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

      for (const limitError of reviewerLimitCapabilityErrors(reviewer)) {
        ctx.addIssue({
          code: "custom",
          message: `Reviewer ${reviewer.id}: ${limitError}`,
          path: ["reviewers", index],
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

/** Which keys the host-local overlay contributed to the effective config, recorded during merge. */
export type ConfigOverlayProvenance = {
  /** Top-level keys the local file set (overridden or added). */
  topLevelOverrides: string[];
  /** Per-reviewer id → entry-level fields the local file set on a base reviewer. */
  reviewerOverrides: Record<string, string[]>;
  /** Reviewer ids defined only in the local file (appended after base entries). */
  appendedReviewerIds: string[];
};

export type LoadedConfigOverlay = ConfigOverlayProvenance & {
  path: string;
  sha256: string;
};

export type LoadedDiffwardenConfig = {
  path: string;
  sha256: string;
  config: DiffwardenConfig;
  /** Present only when a host-local overlay was merged over the user config. */
  overlay?: LoadedConfigOverlay;
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

  // The host-local overlay applies only when the USER config was selected — a project config wins
  // wholesale, and the overlay solves a user-config sync problem, not a repo one.
  const env = options.env ?? process.env;
  const localPath = userLocalConfigPath(env, options.homeDir);
  const localRaw =
    path.resolve(configPath) === path.resolve(userConfigPath(env, options.homeDir))
      ? await readFileIfExists(localPath)
      : undefined;

  // No overlay: byte-identical behavior to the single-file path, including error messages.
  if (localRaw === undefined) {
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

  const { config, provenance } = validateConfigLayers(raw, localRaw, configPath, localPath);

  return {
    path: configPath,
    sha256: sha256(raw),
    config,
    overlay: { path: localPath, sha256: sha256(localRaw), ...provenance },
  };
}

/**
 * Run the LOAD path's full base+local validation on raw file contents without touching disk:
 * parse both layers, check the overlay shape, merge, check appended-reviewer completeness, and
 * schema-validate the merged view. Throws exactly what loadDiffwardenConfig would, so callers
 * (init's orphan-overlay advisory) cannot drift from the real loader.
 */
export function validateConfigLayers(
  baseContent: string,
  localContent: string,
  basePath: string,
  localPath: string,
): { config: DiffwardenConfig; provenance: ConfigOverlayProvenance } {
  const baseObject = parseRawConfigObject(baseContent, basePath);
  const localObject = parseRawConfigObject(localContent, localPath);
  assertLocalOverlayShape(localObject, localPath);

  const { merged, provenance } = mergeConfigOverlay(baseObject, localObject);
  assertAppendedReviewersComplete(merged, provenance, localPath);

  const parsed = diffwardenConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw invalidConfig(
      `Invalid merged config (base ${basePath} + local ${localPath}): ${z.prettifyError(parsed.error)}`,
    );
  }
  return { config: parsed.data, provenance };
}

/**
 * Deep-merge the host-local overlay's raw JSON over the base config's raw JSON, before any schema
 * validation (partial local reviewer entries are completed by the merge, so nothing partial ever
 * reaches zod). Rules: objects deep-merge key-wise; scalars/arrays/type-mismatches take the local
 * value wholesale (null is a value, not a deletion marker); top-level `reviewers` merges by id —
 * a matching id overlays that entry, a new id appends after the base entries. `reviewerSets` falls
 * out of the object rule: the map merges per set name, each member array replaces wholesale.
 *
 * All produced objects have null prototypes (mirroring the reviewerSets defenses elsewhere in this
 * file) so keys like "__proto__" — legal set names today — merge as data instead of polluting.
 */
export function mergeConfigOverlay(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
): { merged: Record<string, unknown>; provenance: ConfigOverlayProvenance } {
  const provenance: ConfigOverlayProvenance = {
    topLevelOverrides: [],
    reviewerOverrides: Object.create(null) as Record<string, string[]>,
    appendedReviewerIds: [],
  };

  const merged = nullPrototypeCopy(base);
  for (const key of Object.keys(local)) {
    if (key === "reviewers") {
      continue;
    }
    provenance.topLevelOverrides.push(key);
    defineMergedKey(merged, key, deepMergeValue(base[key], local[key]));
  }

  if (local.reviewers !== undefined) {
    const baseReviewers = Array.isArray(base.reviewers) ? base.reviewers : [];
    const localReviewers = Array.isArray(local.reviewers) ? local.reviewers : [];
    const mergedReviewers: unknown[] = baseReviewers.map((reviewer) =>
      isRecord(reviewer) ? nullPrototypeCopy(reviewer) : reviewer,
    );
    for (const localReviewer of localReviewers) {
      if (!isRecord(localReviewer) || typeof localReviewer.id !== "string") {
        // Structurally invalid rows are rejected by assertLocalOverlayShape before merge; keep the
        // merge total anyway so the pure function never throws on odd input.
        mergedReviewers.push(localReviewer);
        continue;
      }
      const index = findReviewerIndexById(mergedReviewers, localReviewer.id);
      if (index >= 0) {
        const baseEntry = mergedReviewers[index];
        mergedReviewers[index] = deepMergeValue(baseEntry, localReviewer);
        provenance.reviewerOverrides[localReviewer.id] = Object.keys(localReviewer).filter(
          (key) => key !== "id",
        );
      } else {
        mergedReviewers.push(nullPrototypeCopy(localReviewer));
        provenance.appendedReviewerIds.push(localReviewer.id);
      }
    }
    defineMergedKey(merged, "reviewers", mergedReviewers);
  }

  return { merged, provenance };
}

/** Objects deep-merge; anything else — scalars, arrays, null, type mismatches — takes local wholesale. */
function deepMergeValue(base: unknown, local: unknown): unknown {
  if (!isRecord(base) || !isRecord(local)) {
    return isRecord(local) ? nullPrototypeCopy(local) : local;
  }
  const merged = nullPrototypeCopy(base);
  for (const key of Object.keys(local)) {
    defineMergedKey(merged, key, deepMergeValue(base[key], local[key]));
  }
  return merged;
}

/** Deep null-prototype copy: records survive keys like "__proto__" as data at every level. */
function nullPrototypeCopy(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    const child = value[key];
    defineMergedKey(copy, key, isRecord(child) ? nullPrototypeCopy(child) : child);
  }
  return copy;
}

/** defineProperty, not assignment: mirrors the reviewerSets "__proto__" defense at the write sites. */
function defineMergedKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Structural checks on the local overlay file only — it is never schema-validated standalone
 * (partial entries are legal there). Rejects non-array `reviewers`, rows without a string id,
 * and duplicate ids WITHIN the local file (later rows would silently fold into earlier ones).
 */
function assertLocalOverlayShape(localRaw: Record<string, unknown>, localPath: string): void {
  if (localRaw.reviewers === undefined) {
    return;
  }
  if (!Array.isArray(localRaw.reviewers)) {
    throw invalidConfig(`Local overlay at ${localPath}: "reviewers" must be an array`);
  }
  const ids = new Set<string>();
  for (const [index, reviewer] of localRaw.reviewers.entries()) {
    if (!isRecord(reviewer) || typeof reviewer.id !== "string" || reviewer.id.length === 0) {
      throw invalidConfig(
        `Local overlay at ${localPath}: reviewers[${index}] must be an object with a string "id"`,
      );
    }
    if (ids.has(reviewer.id)) {
      throw invalidConfig(`Local overlay at ${localPath}: duplicate reviewer id "${reviewer.id}"`);
    }
    ids.add(reviewer.id);
  }
}

/**
 * A local reviewer id with no base counterpart is an APPEND and must be a complete entry. Catch the
 * missing-engine case before zod so the error names the fix (and the orphan-after-base-removal case
 * reads as what it is) instead of a raw strict-schema failure.
 */
function assertAppendedReviewersComplete(
  merged: Record<string, unknown>,
  provenance: ConfigOverlayProvenance,
  localPath: string,
): void {
  const reviewers = Array.isArray(merged.reviewers) ? merged.reviewers : [];
  for (const id of provenance.appendedReviewerIds) {
    const index = findReviewerIndexById(reviewers, id);
    const entry = index >= 0 ? reviewers[index] : undefined;
    if (!isRecord(entry) || typeof entry.engine !== "string") {
      throw invalidConfig(
        `local overlay reviewer "${id}" has no base entry to overlay; give it an engine or remove it from ${localPath}`,
      );
    }
  }
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
  assertMergedWritableConfig(
    rawConfig,
    configPath,
    await readOverlayForValidation(options.env ?? process.env, options.homeDir),
  );

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

export type AddReviewersToUserConfigOptions = {
  entries: PublicReviewerEntry[];
  reviewerSet?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Optimistic-concurrency token: abort if the file changed since this hash was read. */
  expectedSha256?: string;
  /**
   * Optimistic-concurrency assertion for the "no config existed yet" case: abort if a config is
   * present at write time. Set this when the caller decided (e.g. seeded reserved ids in a picker)
   * from an *absent* config, so a config created during a long prompt window trips the guard instead
   * of silently merging stale entries into it. Mutually exclusive with expectedSha256.
   */
  expectAbsent?: boolean;
};

export type AddReviewersToUserConfigResult = {
  path: string;
  created: boolean;
  actions: ("added" | "updated")[];
  sha256: string;
};

/**
 * Merge several reviewer entries into the user config in ONE atomic read–merge–write, so an
 * interactive multi-select add persists every chosen reviewer or none — never a partial batch on a
 * mid-loop error. Mirrors addReviewerToUserConfig's create-or-merge and compare-and-swap; the whole
 * batch is merged and schema-validated before the single write. `actions` is per-entry, in order.
 */
export async function addReviewersToUserConfig(
  options: AddReviewersToUserConfigOptions,
): Promise<AddReviewersToUserConfigResult> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  const existingRaw = await readFileIfExists(configPath);

  // The caller seeded its reserved ids from an absent config; a config that appeared during the
  // prompt window makes that reasoning stale, so refuse rather than merge into the new file.
  if (options.expectAbsent === true && existingRaw !== undefined) {
    throw invalidConfig(`Config changed on disk since it was read: ${configPath}`);
  }
  // A supplied token means the caller read a config with this hash, so it must still exist AND match.
  // A deletion during the prompt window (existingRaw undefined) is a change too — without the
  // existingRaw check it would fall through to a fresh create that drops the deleted file's other
  // reviewers, reviewer sets, and top-level fields.
  if (
    options.expectedSha256 !== undefined &&
    (existingRaw === undefined || sha256(existingRaw) !== options.expectedSha256)
  ) {
    throw invalidConfig(`Config changed on disk since it was read: ${configPath}`);
  }

  const rawConfig = existingRaw === undefined ? {} : parseRawConfigObject(existingRaw, configPath);
  const created = existingRaw === undefined;

  const reviewers = Array.isArray(rawConfig.reviewers) ? [...rawConfig.reviewers] : [];
  const actions: ("added" | "updated")[] = [];
  for (const entry of options.entries) {
    actions.push(mergeReviewerById(reviewers, entry, configPath));
    if (options.reviewerSet !== undefined) {
      appendToReviewerSet(rawConfig, options.reviewerSet, entry.id);
    }
  }
  rawConfig.reviewers = reviewers;

  assertWritableConfig(rawConfig, configPath);
  assertMergedWritableConfig(
    rawConfig,
    configPath,
    await readOverlayForValidation(options.env ?? process.env, options.homeDir),
  );

  const serialized = `${JSON.stringify(rawConfig, null, 2)}\n`;
  // Compare-and-swap on every write so a concurrent setup cannot clobber the batch.
  await atomicWrite(
    configPath,
    serialized,
    existingRaw === undefined ? { expectAbsent: true } : { expectedSha256: sha256(existingRaw) },
  );

  return { path: configPath, created, actions, sha256: sha256(serialized) };
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
  overlayOverride?: OverlayForValidation,
): Promise<{ path: string; sha256: string; result: T }> {
  const env = options.env ?? process.env;
  const configPath = userConfigPath(env, options.homeDir);
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
  // Callers that are ALSO about to rewrite the overlay (base remove's auto-prune) pass the
  // overlay state they will write, so validation sees the pair of files that will actually exist.
  assertMergedWritableConfig(
    rawConfig,
    configPath,
    overlayOverride ?? (await readOverlayForValidation(env, options.homeDir)),
  );
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
  /** Present when a host-local overlay exists: what happened to its entry for the removed id. */
  local?: {
    path: string;
    /** True when the overlay had an entry for the id and it was pruned. */
    pruned: boolean;
    /** Set when the prune failed — an orphan overlay entry remains and the next load fails loudly. */
    pruneError?: string;
    /** Local reviewer sets that still reference the removed id (dangling members, warn material). */
    localSetsReferencing: string[];
  };
};

/**
 * Delete a configured reviewer by id and prune it from every reviewer set. Refuses (unless
 * `force`) when this would leave `defaultReviewerSet` empty. Errors if the id is not configured
 * in the base — a local-only id gets a pointer at `remove <id> --local` instead.
 *
 * When a host-local overlay has an entry for the id, it is auto-pruned in a SECOND atomic write
 * after the base write (non-transactional by design: base validation runs against the overlay
 * state we are about to write, and a failed prune is reported — the next load then fails loudly
 * with a targeted fix message rather than silently misbehaving).
 */
export async function removeReviewerFromUserConfig(
  options: RemoveReviewerFromUserConfigOptions,
): Promise<RemoveReviewerFromUserConfigResult> {
  const env = options.env ?? process.env;
  const localPath = userLocalConfigPath(env, options.homeDir);
  const localContent = await readFileIfExists(localPath);

  // Compute the pruned overlay up front so the base write validates against the overlay state
  // that will exist AFTER the prune — otherwise removing an overlaid reviewer would always be
  // refused for the orphan entry the prune is about to delete.
  let prunedLocalRaw: Record<string, unknown> | undefined;
  let overlayForValidation: OverlayForValidation | undefined;
  let localSetsReferencing: string[] = [];
  let localHadEntry = false;
  if (localContent !== undefined) {
    try {
      const localRaw = parseRawConfigObject(localContent, localPath);
      assertLocalOverlayShape(localRaw, localPath);
      const reviewers = Array.isArray(localRaw.reviewers) ? [...localRaw.reviewers] : [];
      const index = findReviewerIndexById(reviewers, options.id);
      if (index >= 0) {
        localHadEntry = true;
        reviewers.splice(index, 1);
        prunedLocalRaw = { ...localRaw, reviewers };
      }
      if (isRecord(localRaw.reviewerSets)) {
        localSetsReferencing = Object.entries(localRaw.reviewerSets)
          .filter(([, members]) => Array.isArray(members) && members.includes(options.id))
          .map(([name]) => name);
      }
      overlayForValidation = { localRaw: prunedLocalRaw ?? localRaw, localPath };
    } catch {
      // Broken overlay: skip prune and merged validation; load/doctor reports it.
      overlayForValidation = { localRaw: undefined, localPath };
    }
  }

  const {
    path,
    sha256: digest,
    result,
  } = await mutateUserConfig(
    options,
    (rawConfig, configPath) => {
      const reviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
      const index = findReviewerIndexById(reviewers, options.id);
      if (index < 0) {
        throw invalidConfig(
          localHadEntry
            ? `Reviewer "${options.id}" is defined only in the local overlay at ${localPath}. Remove it with "diffwarden reviewers remove ${options.id} --local".`
            : `No reviewer with id "${options.id}" in ${configPath}`,
        );
      }
      reviewers.splice(index, 1);
      rawConfig.reviewers = reviewers;
      const prunedFromSets = pruneReviewerFromSets(rawConfig, options.id);
      guardDefaultReviewerSet(rawConfig, configPath, options.force === true);
      return { prunedFromSets };
    },
    overlayForValidation,
  );

  let local: RemoveReviewerFromUserConfigResult["local"];
  if (localContent !== undefined) {
    local = { path: localPath, pruned: false, localSetsReferencing };
    if (prunedLocalRaw !== undefined) {
      try {
        await atomicWrite(localPath, `${JSON.stringify(prunedLocalRaw, null, 2)}\n`, {
          expectedSha256: sha256(localContent),
        });
        local.pruned = true;
      } catch (error) {
        local.pruneError = errorMessage(error);
      }
    }
  }

  return {
    path,
    prunedFromSets: result.prunedFromSets,
    sha256: digest,
    ...(local !== undefined ? { local } : {}),
  };
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

    assertMergedReviewerCapabilities(merged, options.id, configPath);

    reviewers[index] = merged;
    rawConfig.reviewers = reviewers;
    return { reviewer: merged };
  });
  return { path, reviewer: result.reviewer, sha256: digest };
}

/**
 * Validate a merged raw reviewer's transport/model/effort against the capability registry before
 * writing, so a bad override fails at edit time rather than at the next review/preflight. Guards an
 * unknown engine first: a hand-edited/legacy config could carry one, and capability helpers index
 * the registry by engine — an unknown key would throw a raw TypeError instead of a clean error.
 */
function assertMergedReviewerCapabilities(
  merged: Record<string, unknown>,
  id: string,
  configPath: string,
): void {
  const engineValue = merged.engine;
  if (typeof engineValue !== "string" || !isReviewerSdk(engineValue)) {
    throw invalidConfig(
      `Reviewer "${id}" in ${configPath} has an unknown engine and cannot be edited: ${String(engineValue)}`,
    );
  }
  const engine = engineValue;
  // Resolve the effective transport the way resolution does (an omitted transport falls back to the
  // engine default) so model/effort are validated against the transport that will actually run.
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
}

export type SetReviewerInUserConfigOptions = {
  id: string;
  entry: PublicReviewerEntry;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
};

/**
 * Replace the editor-managed fields (transport/provider/model/effort/enabled) of a reviewer with the
 * given entry, preserving keys the editor does not touch (sdkOptions, cliOptions, …). Unlike the
 * set-only patch in editReviewerInUserConfig, omitting a managed field here CLEARS it — so the
 * interactive editor's "blank = default" actually removes the override. Validates before writing.
 */
export async function setReviewerInUserConfig(
  options: SetReviewerInUserConfigOptions,
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
    const existing = reviewers[index];
    const preserved = isRecord(existing) ? omitManagedReviewerKeys(existing) : {};
    const merged: Record<string, unknown> = {
      ...preserved,
      ...buildReviewerEntryObject(options.entry),
    };
    assertMergedReviewerCapabilities(merged, options.id, configPath);
    reviewers[index] = merged;
    rawConfig.reviewers = reviewers;
    return { reviewer: merged };
  });
  return { path, reviewer: result.reviewer, sha256: digest };
}

/** Drop the keys buildReviewerEntryObject re-emits, so a cleared override does not survive the merge. */
function omitManagedReviewerKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const managed = new Set([
    "id",
    "engine",
    "transport",
    "profile",
    "provider",
    "model",
    "effort",
    "enabled",
  ]);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!managed.has(key)) {
      rest[key] = value;
    }
  }
  return rest;
}

/**
 * Read the local overlay's raw JSON, apply `mutate`, run the structural checks, validate the RESULT
 * MERGED OVER THE CURRENT BASE (the local file is never schema-validated standalone), and write
 * atomically with the same CAS guards as the base mutators — against the LOCAL file's bytes. An
 * absent local file mutates from `{}` and is created by the write. Errors up front when no base
 * config exists: an overlay only overlays.
 *
 * Each write CASes only the file it targets; a base change between our read and write is tolerated
 * (worst case: a validation error on the next load, never corruption). No two-file locking.
 */
async function mutateLocalConfig<T>(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string; expectedSha256?: string },
  mutate: (localRaw: Record<string, unknown>, localPath: string) => T,
): Promise<{ path: string; sha256: string; created: boolean; result: T }> {
  const env = options.env ?? process.env;
  const basePath = userConfigPath(env, options.homeDir);
  const baseContent = await readFileIfExists(basePath);
  if (baseContent === undefined) {
    throw invalidConfig(
      `No diffwarden user config at ${basePath}; the local overlay only overlays a base config. Run diffwarden init, or wait for your synced base config to land, then retry.`,
    );
  }

  const localPath = userLocalConfigPath(env, options.homeDir);
  const existingRaw = await readFileIfExists(localPath);
  if (
    options.expectedSha256 !== undefined &&
    (existingRaw === undefined || sha256(existingRaw) !== options.expectedSha256)
  ) {
    throw invalidConfig(`Config changed on disk since it was read: ${localPath}`);
  }

  const localRaw = existingRaw === undefined ? {} : parseRawConfigObject(existingRaw, localPath);
  const result = mutate(localRaw, localPath);
  assertLocalOverlayShape(localRaw, localPath);

  const baseRaw = parseRawConfigObject(baseContent, basePath);
  const { merged, provenance } = mergeConfigOverlay(baseRaw, localRaw);
  assertAppendedReviewersComplete(merged, provenance, localPath);
  const parsed = diffwardenConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw invalidConfig(
      `Refusing to write invalid local overlay to ${localPath} (merged with ${basePath}): ${z.prettifyError(parsed.error)}`,
    );
  }

  const serialized = `${JSON.stringify(localRaw, null, 2)}\n`;
  await atomicWrite(
    localPath,
    serialized,
    existingRaw === undefined ? { expectAbsent: true } : { expectedSha256: sha256(existingRaw) },
  );
  return {
    path: localPath,
    sha256: sha256(serialized),
    created: existingRaw === undefined,
    result,
  };
}

/**
 * Merge reviewer entries into the HOST-LOCAL overlay by id (creating the file on demand), one
 * atomic write for the whole batch — the `reviewers add --local` path. The merged view is
 * validated before writing, so an entry the base cannot support fails here, not at load.
 */
export async function addReviewersToLocalConfig(options: {
  entries: PublicReviewerEntry[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
}): Promise<AddReviewersToUserConfigResult> {
  const {
    path: localPath,
    sha256: digest,
    created,
    result,
  } = await mutateLocalConfig(options, (localRaw, configPath) => {
    const reviewers = Array.isArray(localRaw.reviewers) ? [...localRaw.reviewers] : [];
    const actions: ("added" | "updated")[] = [];
    for (const entry of options.entries) {
      actions.push(mergeReviewerById(reviewers, entry, configPath));
    }
    localRaw.reviewers = reviewers;
    return actions;
  });
  return { path: localPath, created, actions: result, sha256: digest };
}

/**
 * Patch a reviewer's fields IN THE HOST-LOCAL OVERLAY — the `reviewers edit <id> --local` path.
 * The id must exist in the merged view (base reviewers are overridable, local-appended reviewers
 * editable). Finds-or-creates the minimal local entry `{id}` and sets exactly the patched keys.
 *
 * Deliberate divergence from base semantics: `enabled: true` is written EXPLICITLY (in the base,
 * enabled-true is expressed by deleting the key; in the overlay, absence means "inherit base", so
 * the override must be explicit to beat a base `enabled: false`).
 */
export async function editReviewerInLocalConfig(options: {
  id: string;
  patch: EditReviewerPatch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
}): Promise<EditReviewerInUserConfigResult> {
  const env = options.env ?? process.env;
  const basePath = userConfigPath(env, options.homeDir);
  const baseContent = await readFileIfExists(basePath);
  const baseReviewers =
    baseContent === undefined
      ? []
      : (() => {
          const parsedBase = parseRawConfigObject(baseContent, basePath);
          return Array.isArray(parsedBase.reviewers) ? parsedBase.reviewers : [];
        })();

  const {
    path: localPath,
    sha256: digest,
    result,
  } = await mutateLocalConfig(options, (localRaw, configPath) => {
    const reviewers = Array.isArray(localRaw.reviewers) ? [...localRaw.reviewers] : [];
    const baseIndex = findReviewerIndexById(baseReviewers, options.id);
    const localIndex = findReviewerIndexById(reviewers, options.id);
    if (baseIndex < 0 && localIndex < 0) {
      throw invalidConfig(
        `No reviewer with id "${options.id}" in ${basePath} or ${configPath}. Add it first with "diffwarden reviewers add".`,
      );
    }

    const existingLocal = localIndex >= 0 ? (reviewers[localIndex] as Record<string, unknown>) : {};
    const localEntry: Record<string, unknown> = { id: options.id, ...existingLocal };
    const { patch } = options;
    if (patch.transport !== undefined) {
      localEntry.transport = patch.transport;
    }
    if (patch.provider !== undefined) {
      localEntry.provider = patch.provider;
    }
    if (patch.model !== undefined) {
      localEntry.model = patch.model;
    }
    if (patch.effort !== undefined) {
      localEntry.effort = patch.effort;
    }
    if (patch.enabled !== undefined) {
      localEntry.enabled = patch.enabled;
    }

    // Capability-check the FULL composite — base entry + existing local entry + patch — so an
    // existing local override (e.g. transport) participates in validating the new model/effort.
    const baseEntry = baseIndex >= 0 ? baseReviewers[baseIndex] : undefined;
    const composite = isRecord(baseEntry)
      ? (deepMergeValue(baseEntry, localEntry) as Record<string, unknown>)
      : localEntry;
    assertMergedReviewerCapabilities(composite, options.id, configPath);

    if (localIndex >= 0) {
      reviewers[localIndex] = localEntry;
    } else {
      reviewers.push(localEntry);
    }
    localRaw.reviewers = reviewers;
    return { reviewer: localEntry };
  });
  return { path: localPath, reviewer: result.reviewer, sha256: digest };
}

/**
 * Replace the editor-managed override fields (transport/provider/model/effort/enabled) of a local
 * overlay entry with exactly `patch`, preserving unmanaged keys (engine of an appended reviewer,
 * sdkOptions, …) — the interactive editor's "what you see is the delta" save. An empty patch with
 * no unmanaged keys left drops the entry entirely, so clearing every override cleans the file.
 */
export async function replaceReviewerLocalOverride(options: {
  id: string;
  patch: EditReviewerPatch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
}): Promise<EditReviewerInUserConfigResult> {
  const {
    path: localPath,
    sha256: digest,
    result,
  } = await mutateLocalConfig(options, (localRaw, _configPath) => {
    const reviewers = Array.isArray(localRaw.reviewers) ? [...localRaw.reviewers] : [];
    const index = findReviewerIndexById(reviewers, options.id);
    const existing = index >= 0 ? (reviewers[index] as Record<string, unknown>) : {};
    const preserved = omitLocalManagedReviewerKeys(existing);
    const entry: Record<string, unknown> = {
      id: options.id,
      ...preserved,
      ...(options.patch.transport !== undefined ? { transport: options.patch.transport } : {}),
      ...(options.patch.provider !== undefined ? { provider: options.patch.provider } : {}),
      ...(options.patch.model !== undefined ? { model: options.patch.model } : {}),
      ...(options.patch.effort !== undefined ? { effort: options.patch.effort } : {}),
      ...(options.patch.enabled !== undefined ? { enabled: options.patch.enabled } : {}),
    };

    const isBareId = Object.keys(entry).length === 1;
    if (index >= 0 && isBareId) {
      reviewers.splice(index, 1);
    } else if (index >= 0) {
      reviewers[index] = entry;
    } else if (!isBareId) {
      reviewers.push(entry);
    }
    localRaw.reviewers = reviewers;
    return { reviewer: entry };
  });
  return { path: localPath, reviewer: result.reviewer, sha256: digest };
}

/**
 * Local-override managed keys: like omitManagedReviewerKeys but WITHOUT engine/profile — those are
 * base-owned for overridden reviewers and identity for appended ones, so the editor never clears them.
 */
function omitLocalManagedReviewerKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const managed = new Set(["id", "transport", "provider", "model", "effort", "enabled"]);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!managed.has(key)) {
      rest[key] = value;
    }
  }
  return rest;
}

export type RemoveReviewerFromLocalConfigResult = {
  path: string;
  sha256: string;
  /**
   * EFFECTIVE reviewer sets (base merged with overlay-owned sets, local replacing per name) that
   * still reference a removed LOCAL-APPENDED reviewer (warn material).
   */
  setsReferencing: string[];
  /** True when the id was local-only (a removed reviewer), false when base still defines it (cleared overrides). */
  wasAppended: boolean;
};

/**
 * Delete a reviewer's local overlay entry — the "un-override everything for this reviewer" verb
 * (`reviewers remove <id> --local`). Errors if the overlay has no entry for the id. Removing a
 * local-APPENDED reviewer reports which effective reviewer sets (base or overlay-owned) still
 * reference it, so the caller can warn before review fails at runtime with an unknown-id error.
 */
export async function removeReviewerFromLocalConfig(options: {
  id: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
}): Promise<RemoveReviewerFromLocalConfigResult> {
  const env = options.env ?? process.env;
  const basePath = userConfigPath(env, options.homeDir);
  const baseContent = await readFileIfExists(basePath);
  const baseRaw = baseContent === undefined ? {} : parseRawConfigObject(baseContent, basePath);
  const baseReviewers = Array.isArray(baseRaw.reviewers) ? baseRaw.reviewers : [];

  const {
    path: localPath,
    sha256: digest,
    result,
  } = await mutateLocalConfig(options, (localRaw, configPath) => {
    const reviewers = Array.isArray(localRaw.reviewers) ? [...localRaw.reviewers] : [];
    const index = findReviewerIndexById(reviewers, options.id);
    if (index < 0) {
      throw invalidConfig(
        `No local overlay entry for reviewer "${options.id}" in ${configPath}. To remove the reviewer itself, run "diffwarden reviewers remove ${options.id}".`,
      );
    }
    reviewers.splice(index, 1);
    localRaw.reviewers = reviewers;

    const isAppended = findReviewerIndexById(baseReviewers, options.id) < 0;
    const setsReferencing: string[] = [];
    if (isAppended) {
      // Dangling members must be found in the EFFECTIVE sets: the overlay's own reviewerSets are
      // a supported merge case and replace a same-name base set wholesale.
      const effectiveSets: Record<string, unknown> = Object.create(null);
      if (isRecord(baseRaw.reviewerSets)) {
        for (const [name, members] of Object.entries(baseRaw.reviewerSets)) {
          defineMergedKey(effectiveSets, name, members);
        }
      }
      if (isRecord(localRaw.reviewerSets)) {
        for (const [name, members] of Object.entries(localRaw.reviewerSets)) {
          defineMergedKey(effectiveSets, name, members);
        }
      }
      for (const [name, members] of Object.entries(effectiveSets)) {
        if (Array.isArray(members) && members.includes(options.id)) {
          setsReferencing.push(name);
        }
      }
    }
    return { setsReferencing, wasAppended: isAppended };
  });
  return {
    path: localPath,
    sha256: digest,
    setsReferencing: result.setsReferencing,
    wasAppended: result.wasAppended,
  };
}

/**
 * Read the configured reviewers as full public entries (id/engine/transport/model/effort/…), so the
 * interactive `edit` picker can list them and seed the field editor from the chosen one. Read-only;
 * throws the same missing-config error as the mutators. Entries without a string id or a known engine
 * are skipped — they cannot be capability-edited anyway.
 */
export async function loadUserConfigReviewerEntries(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<{ path: string; entries: PublicReviewerEntry[]; sha256: string }> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  const existingRaw = await readFileIfExists(configPath);
  if (existingRaw === undefined) {
    throw invalidConfig(
      `No diffwarden user config at ${configPath}. Run diffwarden init or diffwarden reviewers add <engine> first.`,
    );
  }
  const rawConfig = parseRawConfigObject(existingRaw, configPath);
  const rawReviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
  const entries: PublicReviewerEntry[] = [];
  for (const reviewer of rawReviewers) {
    const entry = rawReviewerToPublicEntry(reviewer);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  // Return the read-time hash so a caller with a human-length edit window (the interactive editor)
  // can pass it back as expectedSha256 and trip the concurrency guard instead of clobbering a
  // change made while the prompt was open.
  return { path: configPath, entries, sha256: sha256(existingRaw) };
}

function rawReviewerToPublicEntry(raw: unknown): PublicReviewerEntry | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") {
    return undefined;
  }
  const engine = raw.engine;
  if (typeof engine !== "string" || !isReviewerSdk(engine)) {
    return undefined;
  }
  const { transport } = raw;
  return {
    id: raw.id,
    engine,
    ...(transport === "sdk" || transport === "cli" || transport === "app-server"
      ? { transport }
      : {}),
    ...(typeof raw.profile === "string" ? { profile: raw.profile } : {}),
    ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.effort === "string" ? { effort: raw.effort } : {}),
  };
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
}): Promise<{ path: string; reviewers: ConfiguredReviewerSummary[]; sha256: string }> {
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
  // Read-time hash so an interactive flow with a prompt window (the add picker) can pass it back as
  // expectedSha256 and abort instead of merging its stale entries over a concurrent change.
  return { path: configPath, reviewers, sha256: sha256(existingRaw) };
}

/** Reviewer ids present in the local overlay (empty when the overlay is absent or unreadable). */
async function readLocalReviewerIds(
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
): Promise<Set<string>> {
  const { localRaw } = await readOverlayForValidation(env, homeDir);
  const ids = new Set<string>();
  if (localRaw !== undefined && Array.isArray(localRaw.reviewers)) {
    for (const reviewer of localRaw.reviewers) {
      if (isRecord(reviewer) && typeof reviewer.id === "string") {
        ids.add(reviewer.id);
      }
    }
  }
  return ids;
}

/**
 * The user config's two layers plus the merged view, for interactive flows and diagnostics.
 * `localSha256` is undefined when no overlay file exists. `entries` / `summaries` reflect the
 * MERGED view; `baseEntries` the base file alone. Read-only; throws the same missing-config error
 * as the mutators when no base user config exists.
 */
export type LayeredUserConfigView = {
  basePath: string;
  baseSha256: string;
  localPath: string;
  localSha256: string | undefined;
  /** Merged-view entries with a known engine (capability-editable). */
  entries: PublicReviewerEntry[];
  /** Base-file entries with a known engine. */
  baseEntries: PublicReviewerEntry[];
  /** Merged-view summaries keeping unknown-engine rows (targetable by id). */
  summaries: ConfiguredReviewerSummary[];
  reviewerOverrides: Record<string, string[]>;
  appendedReviewerIds: string[];
};

export async function loadLayeredUserConfigView(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<LayeredUserConfigView> {
  const env = options.env ?? process.env;
  const basePath = userConfigPath(env, options.homeDir);
  const baseContent = await readFileIfExists(basePath);
  if (baseContent === undefined) {
    throw invalidConfig(
      `No diffwarden user config at ${basePath}. Run diffwarden init or diffwarden reviewers add <engine> first.`,
    );
  }
  const baseRaw = parseRawConfigObject(baseContent, basePath);

  const localPath = userLocalConfigPath(env, options.homeDir);
  const localContent = await readFileIfExists(localPath);
  let mergedRaw = baseRaw;
  let provenance: ConfigOverlayProvenance = {
    topLevelOverrides: [],
    reviewerOverrides: Object.create(null) as Record<string, string[]>,
    appendedReviewerIds: [],
  };
  if (localContent !== undefined) {
    const localRaw = parseRawConfigObject(localContent, localPath);
    assertLocalOverlayShape(localRaw, localPath);
    const merged = mergeConfigOverlay(baseRaw, localRaw);
    mergedRaw = merged.merged;
    provenance = merged.provenance;
  }

  return {
    basePath,
    baseSha256: sha256(baseContent),
    localPath,
    localSha256: localContent !== undefined ? sha256(localContent) : undefined,
    entries: publicEntriesFromRaw(mergedRaw),
    baseEntries: publicEntriesFromRaw(baseRaw),
    summaries: summariesFromRaw(mergedRaw),
    reviewerOverrides: provenance.reviewerOverrides,
    appendedReviewerIds: provenance.appendedReviewerIds,
  };
}

function publicEntriesFromRaw(rawConfig: Record<string, unknown>): PublicReviewerEntry[] {
  const rawReviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
  const entries: PublicReviewerEntry[] = [];
  for (const reviewer of rawReviewers) {
    const entry = rawReviewerToPublicEntry(reviewer);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries;
}

function summariesFromRaw(rawConfig: Record<string, unknown>): ConfiguredReviewerSummary[] {
  const rawReviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
  const summaries: ConfiguredReviewerSummary[] = [];
  for (const reviewer of rawReviewers) {
    if (!isRecord(reviewer) || typeof reviewer.id !== "string") {
      continue;
    }
    summaries.push({
      id: reviewer.id,
      engine: typeof reviewer.engine === "string" ? reviewer.engine : "unknown",
      enabled: reviewer.enabled !== false,
    });
  }
  return summaries;
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

/**
 * Read the reviewer sets from the user config for the interactive set editor. Read-only;
 * throws the same missing-config error as the mutators when no user config exists.
 */
export async function listUserConfigReviewerSets(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<{
  path: string;
  sets: Record<string, string[]>;
  defaultReviewerSet: string | undefined;
  sha256: string;
}> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  const existingRaw = await readFileIfExists(configPath);
  if (existingRaw === undefined) {
    throw invalidConfig(
      `No diffwarden user config at ${configPath}. Run diffwarden init or diffwarden reviewers add <engine> first.`,
    );
  }
  const rawConfig = parseRawConfigObject(existingRaw, configPath);
  // Null prototype: set names are unrestricted, and copying a set named "__proto__" into a
  // plain object would hit the inherited setter and vanish from the returned map.
  const sets: Record<string, string[]> = Object.create(null);
  if (isRecord(rawConfig.reviewerSets)) {
    for (const [name, members] of Object.entries(rawConfig.reviewerSets)) {
      if (Array.isArray(members)) {
        sets[name] = members.filter((member): member is string => typeof member === "string");
      }
    }
  }
  return {
    path: configPath,
    sets,
    defaultReviewerSet:
      typeof rawConfig.defaultReviewerSet === "string" ? rawConfig.defaultReviewerSet : undefined,
    sha256: sha256(existingRaw),
  };
}

export type ReviewerSetReplaceOptions = {
  setName: string;
  /** Full replacement membership, order preserved (deduplicated). */
  members: string[];
  makeDefault?: boolean;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  expectedSha256?: string;
};

/**
 * Replace a reviewer set's membership wholesale (creating the set if needed) and optionally
 * make it the default set — one atomic write backing the interactive set editor, instead of
 * a fragile sequence of add/remove calls. Every member must be a configured reviewer id;
 * leaving the default set empty still requires `force`.
 */
export async function replaceReviewerSetInUserConfig(
  options: ReviewerSetReplaceOptions,
): Promise<ReviewerSetMembershipResult> {
  // Membership may reference local-appended reviewers: validate ids against the MERGED view.
  const localIds = await readLocalReviewerIds(options.env ?? process.env, options.homeDir);
  const {
    path,
    sha256: digest,
    result,
  } = await mutateUserConfig(options, (rawConfig, configPath) => {
    const reviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
    for (const member of options.members) {
      if (findReviewerIndexById(reviewers, member) < 0 && !localIds.has(member)) {
        throw invalidConfig(
          `No reviewer with id "${member}" in ${configPath}; add it before adding it to a set`,
        );
      }
    }
    const sets = isRecord(rawConfig.reviewerSets) ? rawConfig.reviewerSets : {};
    // defineProperty, not assignment: set names are unrestricted, and assigning a name like
    // "__proto__" would hit the inherited setter — reporting success while never persisting.
    Object.defineProperty(sets, options.setName, {
      value: [...new Set(options.members)],
      writable: true,
      enumerable: true,
      configurable: true,
    });
    rawConfig.reviewerSets = sets;
    if (options.makeDefault === true) {
      rawConfig.defaultReviewerSet = options.setName;
    }
    guardDefaultReviewerSet(rawConfig, configPath, options.force === true);
    return { members: (sets[options.setName] as string[]).slice() };
  });
  return { path, set: options.setName, members: result.members, sha256: digest };
}

/** Add a configured reviewer id to a reviewer set (creating the set if needed). */
export async function addReviewerToSetInUserConfig(
  options: ReviewerSetMembershipOptions,
): Promise<ReviewerSetMembershipResult> {
  // Membership may reference local-appended reviewers: validate ids against the MERGED view.
  const localIds = await readLocalReviewerIds(options.env ?? process.env, options.homeDir);
  const {
    path,
    sha256: digest,
    result,
  } = await mutateUserConfig(options, (rawConfig, configPath) => {
    const reviewers = Array.isArray(rawConfig.reviewers) ? rawConfig.reviewers : [];
    if (
      findReviewerIndexById(reviewers, options.reviewerId) < 0 &&
      !localIds.has(options.reviewerId)
    ) {
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
  // "wx" on a DANGLING symlink fails EEXIST, but a dotfiles link installed before its target is a
  // creation, not a conflict — resolve through the link and create its target instead.
  const targetPath = await resolveWriteTarget(configPath);
  try {
    await writeFile(targetPath, content, { flag: "wx" });
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw invalidConfig(
        `Config already exists: ${configPath}. Edit it directly, run "diffwarden reviewers add" or "diffwarden reviewers edit" to change reviewers, or delete the file and re-run "diffwarden init".`,
      );
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
  // Resolve symlinks BEFORE the rename swap: a user config symlinked from a dotfiles repo must be
  // updated through the link, not replaced by a regular file that silently orphans the host from
  // its synced source.
  const targetPath = await resolveWriteTarget(configPath);
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(tempPath, content, "utf8");
  try {
    // Re-check the target immediately before swapping so a concurrent write since our read is
    // detected instead of silently overwritten.
    const current = await readFileIfExists(targetPath);
    const changed =
      guard.expectAbsent === true
        ? current !== undefined
        : guard.expectedSha256 !== undefined &&
          (current === undefined || sha256(current) !== guard.expectedSha256);
    if (changed) {
      throw invalidConfig(`Config changed on disk since it was read: ${configPath}`);
    }
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/** Fully resolve `configPath` through symlinks; for a not-yet-existing file, resolve its directory. */
async function resolveWriteTarget(configPath: string, depth = 0): Promise<string> {
  try {
    return await realpath(configPath);
  } catch {
    // realpath fails for a DANGLING link too, not just an absent file. A dotfiles symlink is
    // often installed before its target exists; write THROUGH it (creating the target) instead
    // of letting the rename replace the link with a regular file. Depth-capped against cycles.
    if (depth < 32) {
      const linkTarget = await readlink(configPath).catch(() => undefined);
      if (linkTarget !== undefined) {
        return resolveWriteTarget(path.resolve(path.dirname(configPath), linkTarget), depth + 1);
      }
    }
    // File absent (fresh create): resolve the parent directory — just created by mkdir above —
    // and keep the basename.
    try {
      return path.join(await realpath(path.dirname(configPath)), path.basename(configPath));
    } catch {
      return configPath;
    }
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

type OverlayForValidation = {
  /** The local overlay raw JSON to validate against; undefined = no overlay applies. */
  localRaw: Record<string, unknown> | undefined;
  localPath: string;
};

/**
 * Read the local overlay for merged-view validation of a BASE write. A missing overlay returns
 * undefined localRaw (nothing to merge). An unparseable/misshapen overlay also returns undefined:
 * the load path already fails loudly on it, and refusing unrelated base writes until a broken
 * overlay is hand-fixed would only add a second blocker.
 */
async function readOverlayForValidation(
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
): Promise<OverlayForValidation> {
  const localPath = userLocalConfigPath(env, homeDir);
  const localContent = await readFileIfExists(localPath);
  if (localContent === undefined) {
    return { localRaw: undefined, localPath };
  }
  try {
    const localRaw = parseRawConfigObject(localContent, localPath);
    assertLocalOverlayShape(localRaw, localPath);
    return { localRaw, localPath };
  } catch {
    return { localRaw: undefined, localPath };
  }
}

/**
 * Refuse a base write whose result would be invalid once merged with the host-local overlay —
 * otherwise a successful `reviewers add/edit/...` can deterministically break every subsequent
 * load on this host. Named-both-files error so the user knows which side to fix.
 */
function assertMergedWritableConfig(
  baseRaw: Record<string, unknown>,
  basePath: string,
  overlay: OverlayForValidation,
): void {
  if (overlay.localRaw === undefined) {
    return;
  }
  const { merged, provenance } = mergeConfigOverlay(baseRaw, overlay.localRaw);
  try {
    assertAppendedReviewersComplete(merged, provenance, overlay.localPath);
  } catch (error) {
    throw invalidConfig(
      `Refusing to write ${basePath}: the result would be invalid once merged with the local overlay at ${overlay.localPath}: ${errorMessage(error)}`,
    );
  }
  const parsed = diffwardenConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw invalidConfig(
      `Refusing to write ${basePath}: the result would be invalid once merged with the local overlay at ${overlay.localPath}: ${z.prettifyError(parsed.error)}`,
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

/** The host-local overlay path: `diffwarden.config.local.json` beside the user config. */
export function userLocalConfigPath(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  return path.join(path.dirname(userConfigPath(env, homeDir)), localConfigFileName);
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

export function findProjectConfigPath(cwd: string, repoRoot?: string): string | undefined {
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
