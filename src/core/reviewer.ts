import type { ReviewReviewerConfig } from "../adapters/types.js";
import { invalidCli } from "./errors.js";

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
};

export function resolveReviewerConfig(options: ResolveReviewerOptions): ReviewReviewerConfig {
  const parsed = parseReviewerSpec(options.spec);

  if (parsed.profile !== undefined) {
    throw invalidCli(`Reviewer profiles are not implemented yet: ${options.spec}`);
  }

  if (options.effort !== undefined) {
    parseReviewEffort(options.effort);
    throw invalidCli("Reviewer effort is not implemented yet");
  }

  return {
    id: parsed.sdk,
    sdk: parsed.sdk,
    ...defaultReviewerModel(parsed.sdk, options.model),
    readonly: true,
  };
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

function isReviewerSdk(value: string | undefined): value is ReviewerSdk {
  return reviewerSdkValues.some((sdk) => sdk === value);
}

function isReviewEffort(value: string): value is ReviewEffort {
  return effortValues.some((effort) => effort === value);
}

function isValidProfileName(profile: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile);
}
