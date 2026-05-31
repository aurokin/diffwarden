import {
  type ReviewerSdk,
  defaultReviewerModel,
  isReviewerSdk,
  reviewerCapabilityDefaults,
  reviewerSdkValues,
  reviewerTransportDefaults,
  validateReviewerCapabilityOverrides,
} from "../adapters/capabilities.js";
import type { ReviewReviewerConfig, ReviewReviewerValueSource } from "../adapters/types.js";
import type { DiffwardenConfig } from "./config.js";
import { invalidCli, invalidConfig } from "./errors.js";

const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ReviewEffort = (typeof effortValues)[number];

export type ParsedReviewerSpec = {
  sdk: ReviewerSdk;
  profile?: string;
};

export type ReviewerOverrideSource = Extract<ReviewReviewerValueSource, "env" | "requested">;

export type ResolveReviewerOptions = {
  spec: string;
  model?: string;
  modelSource?: ReviewerOverrideSource;
  effort?: string;
  effortSource?: ReviewerOverrideSource;
  timeoutSeconds?: number;
  config?: DiffwardenConfig;
};

export type ResolveReviewersOptions = {
  reviewers?: string[];
  reviewerSet?: string;
  model?: string;
  modelSource?: ReviewerOverrideSource;
  effort?: string;
  effortSource?: ReviewerOverrideSource;
  timeoutSeconds?: number;
  config?: DiffwardenConfig;
};

export function resolveReviewerConfigs(options: ResolveReviewersOptions): ReviewReviewerConfig[] {
  const specs = resolveReviewerSpecs(options);

  if (specs.length > 1 && options.model !== undefined) {
    throw invalidCli("--model can only be used with a single reviewer");
  }

  if (specs.length > 1 && options.effort !== undefined) {
    throw invalidCli("--effort can only be used with a single reviewer");
  }

  return specs.map((spec) =>
    resolveReviewerConfig({
      spec,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.effortSource !== undefined ? { effortSource: options.effortSource } : {}),
      ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
      ...(options.config !== undefined ? { config: options.config } : {}),
    }),
  );
}

export function resolveReviewerConfig(options: ResolveReviewerOptions): ReviewReviewerConfig {
  const parsed = parseReviewerSpecIfBuiltIn(options.spec);

  if (parsed === undefined) {
    const configured =
      options.config === undefined
        ? undefined
        : findConfiguredReviewerById(options.config, options.spec);
    if (configured !== undefined && options.config !== undefined) {
      return materializeConfiguredReviewer(options.config, configured, options);
    }
    if (options.config !== undefined) {
      throw invalidConfig(`Unknown configured reviewer: ${options.spec}`);
    }
    throw invalidCli(`Reviewer is not implemented yet: ${options.spec}`);
  }

  const profile = parsed.profile;
  if (profile !== undefined) {
    if (options.config !== undefined) {
      const configured = findConfiguredReviewerByProfile(
        options.config,
        { ...parsed, profile },
        options.spec,
      );
      return materializeConfiguredReviewer(options.config, configured, options);
    }
    throw invalidCli(`Reviewer profiles are not implemented yet: ${options.spec}`);
  }

  if (options.effort !== undefined) {
    parseReviewEffort(options.effort);
  }

  const timeoutSeconds = options.timeoutSeconds ?? options.config?.timeoutSeconds;
  const defaults = reviewerCapabilityDefaults(parsed.sdk, options.model);
  const modelSource =
    defaults.model === undefined
      ? undefined
      : options.model === undefined
        ? "adapter-default"
        : (options.modelSource ?? "requested");

  return validateReviewerCapabilityOverrides({
    id: parsed.sdk,
    sdk: parsed.sdk,
    ...defaults,
    ...(modelSource !== undefined ? { modelSource } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.effort !== undefined ? { effortSource: options.effortSource ?? "requested" } : {}),
    ...reviewerTimeout(timeoutSeconds),
    readonly: true,
  });
}

function resolveReviewerSpecs(options: ResolveReviewersOptions): string[] {
  const explicitReviewers = options.reviewers ?? [];

  if (explicitReviewers.length > 0 && options.reviewerSet !== undefined) {
    throw invalidCli("Use either --reviewer or --reviewer-set, not both");
  }

  if (options.reviewerSet !== undefined) {
    return resolveConfiguredReviewerSet(options.config, options.reviewerSet);
  }

  if (explicitReviewers.length > 0) {
    return explicitReviewers;
  }

  const defaultReviewerSet = options.config?.defaultReviewerSet;
  if (defaultReviewerSet !== undefined) {
    return resolveConfiguredReviewerSet(options.config, defaultReviewerSet);
  }

  if (options.config !== undefined) {
    throw invalidConfig("Config must define defaultReviewerSet for implicit reviewer selection");
  }

  throw invalidConfig(
    "No reviewer selected and no diffwarden config defaultReviewerSet is available; pass --reviewer or run diffwarden init to create a config",
  );
}

function resolveConfiguredReviewerSet(
  config: DiffwardenConfig | undefined,
  name: string,
): string[] {
  const specs = config?.reviewerSets?.[name];
  if (specs === undefined) {
    throw invalidConfig(`Unknown reviewer set: ${name}`);
  }

  if (specs.length === 0) {
    throw invalidConfig(`Reviewer set is empty: ${name}`);
  }

  return specs;
}

export function parseReviewerSpec(spec: string): ParsedReviewerSpec {
  if (spec.length === 0) {
    throw invalidCli("Reviewer spec cannot be empty");
  }

  const parts = spec.split(":");
  if (parts.length > 2) {
    throw invalidCli(`Invalid reviewer spec: ${spec}`);
  }

  const [sdkValue, profile] = parts;
  if (!isReviewerSdk(sdkValue)) {
    throw invalidCli(`Reviewer is not implemented yet: ${sdkValue}`);
  }

  if (profile === undefined) {
    return { sdk: sdkValue };
  }

  if (!isValidProfileName(profile)) {
    throw invalidCli(`Invalid reviewer profile in spec: ${spec}`);
  }

  return {
    sdk: sdkValue,
    profile,
  };
}

export function parseReviewEffort(effort: string): ReviewEffort {
  if (isReviewEffort(effort)) {
    return effort;
  }

  throw invalidCli(`Invalid --effort value: ${effort}`);
}

function materializeConfiguredReviewer(
  config: DiffwardenConfig,
  configured: NonNullable<DiffwardenConfig["reviewers"]>[number],
  options: ResolveReviewerOptions,
): ReviewReviewerConfig {
  const modelSelection = configuredModelSelection(configured, options.model, options.modelSource);
  const effortSelection = configuredEffortSelection(
    configured,
    options.effort,
    options.effortSource,
  );
  const model = modelSelection?.value;
  const effort = effortSelection?.value;

  validateConfiguredModel(configured, model);
  validateConfiguredEffort(configured, effort);

  if (effort !== undefined) {
    parseReviewEffort(effort);
  }

  const timeoutMs =
    options.timeoutSeconds !== undefined
      ? secondsToMilliseconds(options.timeoutSeconds)
      : configured.timeoutSeconds !== undefined
        ? Math.round(configured.timeoutSeconds * 1000)
        : config.timeoutSeconds !== undefined
          ? Math.round(config.timeoutSeconds * 1000)
          : undefined;

  return validateReviewerCapabilityOverrides({
    id: configured.id,
    sdk: configured.sdk,
    ...(configured.transport !== undefined
      ? { transport: configured.transport }
      : reviewerTransportDefaults(configured.sdk)),
    ...(configured.profile !== undefined ? { profile: configured.profile } : {}),
    ...(configured.provider !== undefined ? { provider: configured.provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelSelection !== undefined ? { modelSource: modelSelection.source } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(effortSelection !== undefined ? { effortSource: effortSelection.source } : {}),
    ...(configured.modelCatalog !== undefined ? { modelCatalog: configured.modelCatalog } : {}),
    ...(configured.effortCatalog !== undefined ? { effortCatalog: configured.effortCatalog } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    readonly: true,
    ...(configured.providerOptions !== undefined
      ? { providerOptions: configured.providerOptions }
      : {}),
    ...(configured.cliOptions !== undefined ? { cliOptions: configured.cliOptions } : {}),
    ...(configured.appServerOptions !== undefined
      ? { appServerOptions: configured.appServerOptions }
      : {}),
    ...(configured.sdkOptions !== undefined ? { sdkOptions: configured.sdkOptions } : {}),
  });
}

function configuredModelSelection(
  configured: NonNullable<DiffwardenConfig["reviewers"]>[number],
  override: string | undefined,
  overrideSource: ReviewerOverrideSource | undefined,
): { value: string; source: "adapter-default" | "config" | ReviewerOverrideSource } | undefined {
  if (override !== undefined) {
    return { value: override, source: overrideSource ?? "requested" };
  }
  if (configured.model !== undefined) {
    return { value: configured.model, source: "config" };
  }
  const defaultModel = defaultReviewerModel(configured.sdk);
  return defaultModel === undefined
    ? undefined
    : { value: defaultModel, source: "adapter-default" };
}

function configuredEffortSelection(
  configured: NonNullable<DiffwardenConfig["reviewers"]>[number],
  override: string | undefined,
  overrideSource: ReviewerOverrideSource | undefined,
): { value: string; source: "config" | ReviewerOverrideSource } | undefined {
  if (override !== undefined) {
    return { value: override, source: overrideSource ?? "requested" };
  }
  return configured.effort === undefined
    ? undefined
    : { value: configured.effort, source: "config" };
}

function findConfiguredReviewerById(
  config: DiffwardenConfig,
  spec: string,
): NonNullable<DiffwardenConfig["reviewers"]>[number] | undefined {
  return config.reviewers?.find((reviewer) => reviewer.id === spec);
}

function findConfiguredReviewerByProfile(
  config: DiffwardenConfig,
  parsed: ParsedReviewerSpec & { profile: string },
  spec: string,
): NonNullable<DiffwardenConfig["reviewers"]>[number] {
  const reviewer = config.reviewers?.find(
    (candidate) => candidate.sdk === parsed.sdk && candidate.profile === parsed.profile,
  );

  if (reviewer === undefined) {
    throw invalidConfig(`Unknown reviewer profile: ${spec}`);
  }

  return reviewer;
}

function validateConfiguredModel(
  reviewer: NonNullable<DiffwardenConfig["reviewers"]>[number],
  model: string | undefined,
): void {
  if (model === undefined || reviewer.modelCatalog === undefined) {
    return;
  }

  if (!reviewer.modelCatalog.includes(model)) {
    throw invalidConfig(`Model is not allowed for reviewer ${reviewer.id}: ${model}`);
  }
}

function validateConfiguredEffort(
  reviewer: NonNullable<DiffwardenConfig["reviewers"]>[number],
  effort: string | undefined,
): void {
  if (effort === undefined) {
    return;
  }

  if (
    reviewer.effortCatalog !== undefined &&
    !reviewer.effortCatalog.some((allowedEffort) => allowedEffort === effort)
  ) {
    throw invalidConfig(`Effort is not allowed for reviewer ${reviewer.id}: ${effort}`);
  }
}

function reviewerTimeout(
  timeoutSeconds: number | undefined,
): Pick<ReviewReviewerConfig, "timeoutMs"> {
  return timeoutSeconds === undefined ? {} : { timeoutMs: secondsToMilliseconds(timeoutSeconds) };
}

function secondsToMilliseconds(timeoutSeconds: number): number {
  return Math.round(timeoutSeconds * 1000);
}

function isReviewEffort(value: string): value is ReviewEffort {
  return effortValues.some((effort) => effort === value);
}

function isValidProfileName(profile: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile);
}

function parseReviewerSpecIfBuiltIn(spec: string): ParsedReviewerSpec | undefined {
  if (spec.length === 0) {
    throw invalidCli("Reviewer spec cannot be empty");
  }

  const parts = spec.split(":");
  if (parts.length > 2) {
    throw invalidCli(`Invalid reviewer spec: ${spec}`);
  }

  const [sdkValue, profile] = parts;
  if (!isReviewerSdk(sdkValue)) {
    return undefined;
  }

  if (profile === undefined) {
    return { sdk: sdkValue };
  }

  if (!isValidProfileName(profile)) {
    throw invalidCli(`Invalid reviewer profile in spec: ${spec}`);
  }

  return {
    sdk: sdkValue,
    profile,
  };
}
