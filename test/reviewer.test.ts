import { describe, expect, it } from "vitest";
import {
  parseReviewEffort,
  parseReviewerSpec,
  resolveReviewerConfig,
} from "../src/core/reviewer.js";

describe("parseReviewerSpec", () => {
  it("parses reviewer SDK names", () => {
    expect(parseReviewerSpec("pi")).toEqual({ sdk: "pi" });
    expect(parseReviewerSpec("claude")).toEqual({ sdk: "claude" });
    expect(parseReviewerSpec("cursor")).toEqual({ sdk: "cursor" });
  });

  it("parses sdk:profile reviewer specs", () => {
    expect(parseReviewerSpec("pi:openrouter-high")).toEqual({
      sdk: "pi",
      profile: "openrouter-high",
    });
  });

  it("rejects malformed reviewer specs", () => {
    expect(() => parseReviewerSpec("")).toThrow("Reviewer spec cannot be empty");
    expect(() => parseReviewerSpec("pi:")).toThrow("Invalid reviewer profile");
    expect(() => parseReviewerSpec("pi:bad/profile")).toThrow("Invalid reviewer profile");
    expect(() => parseReviewerSpec("pi:one:two")).toThrow("Invalid reviewer spec");
    expect(() => parseReviewerSpec("unknown")).toThrow("Reviewer is not implemented yet");
  });
});

describe("parseReviewEffort", () => {
  it("accepts public effort values", () => {
    expect(parseReviewEffort("off")).toBe("off");
    expect(parseReviewEffort("minimal")).toBe("minimal");
    expect(parseReviewEffort("low")).toBe("low");
    expect(parseReviewEffort("medium")).toBe("medium");
    expect(parseReviewEffort("high")).toBe("high");
    expect(parseReviewEffort("xhigh")).toBe("xhigh");
  });

  it("rejects unsupported effort values", () => {
    expect(() => parseReviewEffort("max")).toThrow("Invalid --effort value: max");
    expect(() => parseReviewEffort("")).toThrow("Invalid --effort value: ");
  });
});

describe("resolveReviewerConfig", () => {
  it("rejects profile specs until config-backed profile resolution exists", () => {
    expect(() =>
      resolveReviewerConfig({
        spec: "pi:openrouter-high",
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).toThrow("Reviewer profiles are not implemented yet: pi:openrouter-high");
  });

  it("rejects effort until adapters apply it", () => {
    expect(() => resolveReviewerConfig({ spec: "pi", effort: "high" })).toThrow(
      "Reviewer effort is not implemented yet",
    );
  });

  it("preserves model in reviewer config", () => {
    expect(
      resolveReviewerConfig({
        spec: "pi",
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).toEqual({
      id: "pi",
      sdk: "pi",
      model: "anthropic/claude-sonnet-4-5",
      readonly: true,
    });
  });

  it("keeps existing default models for SDKs with built-in defaults", () => {
    expect(resolveReviewerConfig({ spec: "cursor" })).toMatchObject({
      sdk: "cursor",
      model: "composer-2",
    });
    expect(resolveReviewerConfig({ spec: "claude" })).toMatchObject({
      sdk: "claude",
      model: "claude-sonnet-4-6",
    });
    expect(resolveReviewerConfig({ spec: "pi" })).not.toHaveProperty("model");
  });
});
