import { invalidConfig } from "../core/errors.js";
import {
  type CaptureMode,
  type ReadonlyCapability,
  type ReviewerSdk,
  getTransportCapability,
} from "./capabilities.js";
import type { ReviewAdapterOutput, ReviewAdapterPreflightResult } from "./types.js";

export type ResolutionSource =
  | "adapter-default"
  | "adapter-selection"
  | "config"
  | "env"
  | "provider-init"
  | "provider-result"
  | "requested"
  | "unsupported";

type SdkMetadataDefaults = {
  transport: "sdk";
  readonlyCapability: ReadonlyCapability;
};

type SdkPreflightMetadataDefaults = SdkMetadataDefaults & {
  preferredCaptureMode: CaptureMode;
};

type SdkOutputMetadataDefaults = SdkMetadataDefaults & {
  captureMode: CaptureMode;
};

export function sdkPreflightMetadata(
  sdk: ReviewerSdk,
  extra: NonNullable<ReviewAdapterPreflightResult["metadata"]> = {},
): NonNullable<ReviewAdapterPreflightResult["metadata"]> & SdkPreflightMetadataDefaults {
  const capability = sdkCapability(sdk);
  return {
    readonlyCapability: capability.readonlyCapability,
    preferredCaptureMode: capability.captureMode,
    transport: "sdk",
    ...extra,
  };
}

export function sdkOutputMetadata(
  sdk: ReviewerSdk,
  extra: NonNullable<ReviewAdapterOutput["metadata"]> = {},
): NonNullable<ReviewAdapterOutput["metadata"]> & SdkOutputMetadataDefaults {
  const capability = sdkCapability(sdk);
  return {
    captureMode: capability.captureMode,
    readonlyCapability: capability.readonlyCapability,
    transport: "sdk",
    ...extra,
  };
}

export function modelResolutionMetadata(options: {
  requested?: string | undefined;
  resolved?: string | undefined;
  source: ResolutionSource;
}): Record<string, string> {
  return {
    ...(options.requested !== undefined ? { requestedModel: options.requested } : {}),
    ...(options.resolved !== undefined ? { resolvedModel: options.resolved } : {}),
    modelResolutionSource: options.source,
  };
}

export function effortResolutionMetadata(options: {
  requested?: string | undefined;
  resolved?: string | undefined;
  source: ResolutionSource;
}): Record<string, string> {
  return {
    ...(options.requested !== undefined ? { requestedEffort: options.requested } : {}),
    ...(options.resolved !== undefined ? { resolvedEffort: options.resolved } : {}),
    effortResolutionSource: options.source,
  };
}

function sdkCapability(sdk: ReviewerSdk) {
  const capability = getTransportCapability(sdk, "sdk");
  if (capability === undefined || !capability.supported) {
    throw invalidConfig(`${sdk} SDK transport is not supported`);
  }
  return capability;
}
