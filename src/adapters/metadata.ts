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
  | "provider-local"
  | "provider-result"
  | "requested"
  | "unsupported";

export type ResolutionEvidence = {
  value?: string | undefined;
  source: ResolutionSource;
  promote?: boolean | undefined;
};

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
  return mergeModelResolutionMetadata({
    requested: options.requested,
    evidence: [{ value: options.resolved, source: options.source }],
  });
}

export function effortResolutionMetadata(options: {
  requested?: string | undefined;
  resolved?: string | undefined;
  source: ResolutionSource;
}): Record<string, string> {
  return mergeEffortResolutionMetadata({
    requested: options.requested,
    evidence: [{ value: options.resolved, source: options.source }],
  });
}

export function mergeModelResolutionMetadata(options: {
  requested?: string | undefined;
  evidence?: ResolutionEvidence[] | undefined;
}): Record<string, string> {
  return valueResolutionMetadata(modelResolutionFields, options);
}

export function mergeEffortResolutionMetadata(options: {
  requested?: string | undefined;
  evidence?: ResolutionEvidence[] | undefined;
}): Record<string, string> {
  return valueResolutionMetadata(effortResolutionFields, options);
}

export function mergeResolutionMetadataRecords(
  ...records: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const concreteRecords = records.filter(isRecord);
  const merged = Object.assign({}, ...concreteRecords);

  return {
    ...merged,
    ...resolutionMetadataFromRecords(modelResolutionFields, concreteRecords),
    ...resolutionMetadataFromRecords(effortResolutionFields, concreteRecords),
  };
}

function sdkCapability(sdk: ReviewerSdk) {
  const capability = getTransportCapability(sdk, "sdk");
  if (capability === undefined || !capability.supported) {
    throw invalidConfig(`${sdk} SDK transport is not supported`);
  }
  return capability;
}

const resolutionSources = [
  "adapter-default",
  "adapter-selection",
  "config",
  "env",
  "provider-init",
  "provider-local",
  "provider-result",
  "requested",
  "unsupported",
] as const satisfies ResolutionSource[];

const resolutionSourceRanks: Record<ResolutionSource, number> = {
  unsupported: 0,
  "adapter-default": 10,
  "provider-local": 20,
  "adapter-selection": 30,
  config: 40,
  env: 40,
  requested: 40,
  "provider-init": 50,
  "provider-result": 60,
};

const modelResolutionFields = {
  requested: "requestedModel",
  resolved: "resolvedModel",
  source: "modelResolutionSource",
} as const;

const effortResolutionFields = {
  requested: "requestedEffort",
  resolved: "resolvedEffort",
  source: "effortResolutionSource",
} as const;

type ResolutionFields = typeof modelResolutionFields | typeof effortResolutionFields;

function resolutionMetadataFromRecords(
  fields: ResolutionFields,
  records: Array<Record<string, unknown>>,
): Record<string, string> {
  const requested = lastStringField(records, fields.requested);
  const evidence = records.flatMap((record) => evidenceFromRecord(record, fields));
  return valueResolutionMetadata(fields, { requested, evidence });
}

function evidenceFromRecord(
  record: Record<string, unknown>,
  fields: ResolutionFields,
): ResolutionEvidence[] {
  const source = resolutionSourceValue(record[fields.source]);
  if (source === undefined) {
    return [];
  }

  return [{ value: stringValue(record[fields.resolved]), source }];
}

function valueResolutionMetadata(
  fields: ResolutionFields,
  options: {
    requested?: string | undefined;
    evidence?: ResolutionEvidence[] | undefined;
  },
): Record<string, string> {
  const requested = stringValue(options.requested);
  const evidence = strongestEvidence(options.evidence ?? []);

  return {
    ...(requested !== undefined ? { [fields.requested]: requested } : {}),
    ...(evidence?.value !== undefined ? { [fields.resolved]: evidence.value } : {}),
    ...(evidence !== undefined ? { [fields.source]: evidence.source } : {}),
  };
}

function strongestEvidence(evidence: ResolutionEvidence[]): ResolutionEvidence | undefined {
  const promoted = evidence.filter((item) => item.promote !== false);
  const valued = promoted.filter((item) => stringValue(item.value) !== undefined);
  const candidates = valued.length > 0 ? valued : promoted;
  let strongest: ResolutionEvidence | undefined;

  for (const candidate of candidates) {
    const normalized = {
      ...candidate,
      value: stringValue(candidate.value),
    };
    if (
      strongest === undefined ||
      resolutionSourceRanks[normalized.source] >= resolutionSourceRanks[strongest.source]
    ) {
      strongest = normalized;
    }
  }

  return strongest;
}

function lastStringField(records: Array<Record<string, unknown>>, key: string): string | undefined {
  let value: string | undefined;
  for (const record of records) {
    value = stringValue(record[key]) ?? value;
  }
  return value;
}

function resolutionSourceValue(value: unknown): ResolutionSource | undefined {
  return typeof value === "string" && isResolutionSource(value) ? value : undefined;
}

function isResolutionSource(value: string): value is ResolutionSource {
  return resolutionSources.some((source) => source === value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
