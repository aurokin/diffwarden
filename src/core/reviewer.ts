import type { ReviewReviewerConfig } from "../adapters/types.js";
import type { DiffwardenConfig } from "./config.js";
import { invalidCli, invalidConfig } from "./errors.js";

const reviewerSdkValues = ["fake", "cursor", "claude", "pi"] as const;
const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ReviewerSdk = (typeof reviewerSdkValues)[number];

export type ReviewEffort = (typeof effortValues)[number];

export type ParsedReviewerSpec = {
  sdk: ReviewerSdk;
  profile?: string;
};

export type ResolveReviewerOptions = {
  spec: string;
  model?: string;
  effort?: string;
  timeoutSeconds?: number;
  config?: DiffwardenConfig;
};

export type ResolveReviewersOptions = {
  reviewers?: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
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
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
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
    throw invalidCli("Reviewer effort is not implemented yet");
  }

  const timeoutSeconds = options.timeoutSeconds ?? options.config?.timeoutSeconds;

  return {
    id: parsed.sdk,
    sdk: parsed.sdk,
    ...defaultReviewerModel(parsed.sdk, options.model),
    ...reviewerTimeout(timeoutSeconds),
    readonly: true,
  };
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

  return ["fake"];
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

function defaultReviewerModel(
  sdk: ReviewerSdk,
  model: string | undefined,
): Pick<ReviewReviewerConfig, "model"> {
  if (model !== undefined) {
    return { model };
  }

  if (sdk === "cursor") {
    return { model: "composer-2" };
  }

  if (sdk === "claude") {
    return { model: "claude-sonnet-4-6" };
  }

  return {};
}

function materializeConfiguredReviewer(
  config: DiffwardenConfig,
  configured: NonNullable<DiffwardenConfig["reviewers"]>[number],
  options: ResolveReviewerOptions,
): ReviewReviewerConfig {
  const model = options.model ?? configured.model;
  const effort = options.effort ?? configured.effort;

  validateConfiguredModel(configured, model);
  validateConfiguredEffort(configured, effort);

  if (effort !== undefined) {
    parseReviewEffort(effort);
    throw invalidCli("Reviewer effort is not implemented yet");
  }

  const timeoutMs =
    options.timeoutSeconds !== undefined
      ? secondsToMilliseconds(options.timeoutSeconds)
      : configured.timeoutSeconds !== undefined
        ? Math.round(configured.timeoutSeconds * 1000)
        : config.timeoutSeconds !== undefined
          ? Math.round(config.timeoutSeconds * 1000)
          : undefined;

  return {
    id: configured.id,
    sdk: configured.sdk,
    ...(configured.profile !== undefined ? { profile: configured.profile } : {}),
    ...(configured.provider !== undefined ? { provider: configured.provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(configured.modelCatalog !== undefined ? { modelCatalog: configured.modelCatalog } : {}),
    ...(configured.effortCatalog !== undefined ? { effortCatalog: configured.effortCatalog } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    readonly: true,
    ...(configured.providerOptions !== undefined
      ? { providerOptions: configured.providerOptions }
      : {}),
    ...(configured.sdkOptions !== undefined ? { sdkOptions: configured.sdkOptions } : {}),
  };
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

function isReviewerSdk(value: string | undefined): value is ReviewerSdk {
  return reviewerSdkValues.some((sdk) => sdk === value);
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
