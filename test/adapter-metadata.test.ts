import { describe, expect, it } from "vitest";
import { reviewerSdkValues } from "../src/adapters/capabilities.js";
import {
  effortResolutionMetadata,
  mergeEffortResolutionMetadata,
  mergeModelResolutionMetadata,
  mergeResolutionMetadataRecords,
  modelResolutionMetadata,
  sdkOutputMetadata,
  sdkPreflightMetadata,
} from "../src/adapters/metadata.js";

describe("SDK adapter metadata", () => {
  it("derives preflight metadata defaults from SDK capability facts", () => {
    expect(sdkPreflightMetadata("cursor", { model: "composer-2.5" })).toMatchObject({
      transport: "sdk",
      readonlyCapability: "prompt-only",
      preferredCaptureMode: "text",
      model: "composer-2.5",
    });
    expect(sdkPreflightMetadata("claude")).toMatchObject({
      transport: "sdk",
      readonlyCapability: "tool-restricted",
      preferredCaptureMode: "native-structured",
    });
    expect(sdkPreflightMetadata("pi")).toMatchObject({
      transport: "sdk",
      readonlyCapability: "tool-restricted",
      preferredCaptureMode: "tool-call",
    });
    expect(sdkPreflightMetadata("droid")).toMatchObject({
      transport: "sdk",
      readonlyCapability: "enforced",
      preferredCaptureMode: "native-structured",
    });
  });

  it("derives output metadata defaults while preserving adapter-specific fields", () => {
    expect(sdkOutputMetadata("cursor", { runId: "run-1" })).toMatchObject({
      transport: "sdk",
      captureMode: "text",
      readonlyCapability: "prompt-only",
      runId: "run-1",
    });
    expect(
      sdkOutputMetadata("claude", { captureMode: "text", fallbackReason: "retry_limit" }),
    ).toMatchObject({
      transport: "sdk",
      captureMode: "text",
      readonlyCapability: "tool-restricted",
      fallbackReason: "retry_limit",
    });
  });

  it("normalizes requested and resolved model and effort metadata", () => {
    expect(
      modelResolutionMetadata({
        requested: "alias",
        resolved: "canonical",
        source: "adapter-selection",
      }),
    ).toEqual({
      requestedModel: "alias",
      resolvedModel: "canonical",
      modelResolutionSource: "adapter-selection",
    });

    expect(
      effortResolutionMetadata({
        requested: "xhigh",
        resolved: "max",
        source: "config",
      }),
    ).toEqual({
      requestedEffort: "xhigh",
      resolvedEffort: "max",
      effortResolutionSource: "config",
    });
  });

  it("merges model evidence by provenance while preserving request intent", () => {
    expect(
      mergeResolutionMetadataRecords(
        {
          requestedModel: "configured-model",
          resolvedModel: "configured-model",
          modelResolutionSource: "config",
        },
        {
          resolvedModel: "runtime-model",
          modelResolutionSource: "provider-result",
        },
      ),
    ).toMatchObject({
      requestedModel: "configured-model",
      resolvedModel: "runtime-model",
      modelResolutionSource: "provider-result",
    });

    expect(
      mergeResolutionMetadataRecords(
        {
          requestedModel: "configured-model",
          resolvedModel: "configured-model",
          modelResolutionSource: "config",
        },
        {
          resolvedModel: "session-model",
          modelResolutionSource: "provider-local",
        },
      ),
    ).toMatchObject({
      requestedModel: "configured-model",
      resolvedModel: "configured-model",
      modelResolutionSource: "config",
    });
  });

  it("uses provider-local evidence as a fallback ahead of adapter defaults", () => {
    expect(
      mergeModelResolutionMetadata({
        evidence: [
          { value: "adapter-default-model", source: "adapter-default" },
          { value: "provider-settings-model", source: "provider-local" },
        ],
      }),
    ).toEqual({
      resolvedModel: "provider-settings-model",
      modelResolutionSource: "provider-local",
    });
  });

  it("uses valued fallback evidence ahead of valueless selected effort", () => {
    expect(
      mergeResolutionMetadataRecords(
        {
          requestedEffort: "off",
          effortResolutionSource: "adapter-selection",
        },
        {
          resolvedEffort: "high",
          effortResolutionSource: "provider-local",
        },
      ),
    ).toMatchObject({
      requestedEffort: "off",
      resolvedEffort: "high",
      effortResolutionSource: "provider-local",
    });
  });

  it("represents unsupported values without inventing a resolved value", () => {
    expect(
      mergeEffortResolutionMetadata({
        requested: "high",
        evidence: [{ source: "unsupported" }],
      }),
    ).toEqual({
      requestedEffort: "high",
      effortResolutionSource: "unsupported",
    });
  });

  it("rejects reviewer SDKs that do not support the SDK transport", () => {
    for (const sdk of reviewerSdkValues) {
      if (["cursor", "claude", "pi", "droid"].includes(sdk)) {
        continue;
      }
      expect(() => sdkPreflightMetadata(sdk)).toThrow(`${sdk} SDK transport is not supported`);
      expect(() => sdkOutputMetadata(sdk)).toThrow(`${sdk} SDK transport is not supported`);
    }
  });
});
