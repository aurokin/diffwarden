import { describe, expect, it } from "vitest";
import {
  defaultReviewerModel,
  defaultReviewerTransport,
  getTransportCapability,
  reviewerCapabilities,
  reviewerSdkValues,
} from "../src/adapters/capabilities.js";
import { resolveReviewerConfig } from "../src/core/reviewer.js";

const expectedReviewerSdks = [
  "fake",
  "cursor",
  "claude",
  "pi",
  "droid",
  "codex",
  "gemini",
  "opencode",
  "grok",
  "antigravity",
] as const;

describe("reviewerCapabilities", () => {
  it("covers every built-in reviewer sdk", () => {
    expect(reviewerSdkValues).toEqual(expectedReviewerSdks);
    expect(Object.keys(reviewerCapabilities).sort()).toEqual([...expectedReviewerSdks].sort());
  });

  it("owns default reviewer models and transports", () => {
    expect(defaultReviewerModel("cursor")).toBe("composer-2.5");
    expect(defaultReviewerModel("claude")).toBe("sonnet");
    expect(defaultReviewerModel("pi")).toBeUndefined();
    expect(defaultReviewerModel("droid")).toBeUndefined();

    expect(defaultReviewerTransport("codex")).toBe("cli");
    expect(defaultReviewerTransport("gemini")).toBe("cli");
    expect(defaultReviewerTransport("opencode")).toBe("cli");
    expect(defaultReviewerTransport("grok")).toBe("cli");
    expect(defaultReviewerTransport("antigravity")).toBe("cli");
    expect(defaultReviewerTransport("claude")).toBeUndefined();
  });

  it("matches reviewer resolution defaults", () => {
    for (const sdk of expectedReviewerSdks) {
      const resolved = resolveReviewerConfig({ spec: sdk });
      expect(resolved.model).toBe(defaultReviewerModel(sdk));
      expect(resolved.transport).toBe(defaultReviewerTransport(sdk));
    }
  });

  it("declares CLI override support used by reviewer validation", () => {
    for (const sdk of expectedReviewerSdks) {
      if (sdk === "fake") {
        continue;
      }
      const capability = getTransportCapability(sdk, "cli");
      const config = {
        reviewers: [
          {
            id: `${sdk}-cli`,
            sdk,
            transport: "cli" as const,
          },
        ],
      };
      if (capability?.supportsModel === false) {
        expect(() =>
          resolveReviewerConfig({ spec: `${sdk}-cli`, model: "test-model", config }),
        ).toThrow(`${sdk} CLI transport does not support per-run model overrides`);
      }
      if (capability?.supportsEffort === false) {
        expect(() => resolveReviewerConfig({ spec: `${sdk}-cli`, effort: "high", config })).toThrow(
          `${sdk} CLI transport does not support per-run effort overrides`,
        );
      }
    }
  });

  it("keeps documented CLI capability facts in one registry", () => {
    expect(getTransportCapability("codex", "cli")).toMatchObject({
      defaultExecutable: "codex",
      supportsModel: true,
      supportsEffort: true,
      captureMode: "native-structured",
      readonlyCapability: "enforced",
    });
    expect(getTransportCapability("codex", "app-server")).toMatchObject({
      defaultExecutable: "codex",
      supportsModel: true,
      supportsEffort: true,
      captureMode: "native-structured",
      readonlyCapability: "enforced",
    });
    expect(getTransportCapability("claude", "sdk")).toMatchObject({
      defaultExecutable: "claude",
      captureMode: "native-structured",
      readonlyCapability: "tool-restricted",
    });
    expect(getTransportCapability("claude", "cli")).toMatchObject({
      defaultExecutable: "claude",
      captureMode: "native-structured",
      readonlyCapability: "tool-restricted",
    });
    expect(getTransportCapability("cursor", "cli")).toMatchObject({
      defaultExecutable: "cursor-agent",
      supportsEffort: false,
      captureMode: "text",
      readonlyCapability: "prompt-only",
    });
    expect(getTransportCapability("antigravity", "cli")).toMatchObject({
      defaultExecutable: "agy",
      supportsModel: false,
      supportsEffort: false,
      captureMode: "text",
      readonlyCapability: "tool-restricted",
    });
  });
});
