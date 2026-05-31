import { describe, expect, it } from "vitest";
import { reviewerSdkValues } from "../src/adapters/capabilities.js";
import {
  effortResolutionMetadata,
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
