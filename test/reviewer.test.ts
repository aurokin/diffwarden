import { describe, expect, it } from "vitest";
import {
  parseReviewEffort,
  parseReviewerSpec,
  resolveReviewerConfig,
  resolveReviewerConfigs,
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

  it("resolves sdk:profile specs from config", () => {
    expect(
      resolveReviewerConfig({
        spec: "pi:openrouter-high",
        config: {
          reviewers: [
            {
              id: "pi-openrouter-high",
              sdk: "pi",
              profile: "openrouter-high",
              provider: "openrouter",
              model: "anthropic/claude-sonnet",
              modelCatalog: ["anthropic/claude-sonnet"],
              providerOptions: { baseUrlEnv: "OPENROUTER_BASE_URL" },
              sdkOptions: { providerProfile: "openrouter" },
            },
          ],
        },
      }),
    ).toEqual({
      id: "pi-openrouter-high",
      sdk: "pi",
      profile: "openrouter-high",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      modelCatalog: ["anthropic/claude-sonnet"],
      readonly: true,
      providerOptions: { baseUrlEnv: "OPENROUTER_BASE_URL" },
      sdkOptions: { providerProfile: "openrouter" },
    });
  });

  it("resolves named reviewer ids from config", () => {
    expect(
      resolveReviewerConfig({
        spec: "claude-deep",
        config: {
          timeoutSeconds: 30,
          reviewers: [{ id: "claude-deep", sdk: "claude", model: "sonnet" }],
        },
      }),
    ).toMatchObject({
      id: "claude-deep",
      sdk: "claude",
      model: "sonnet",
      timeoutMs: 30000,
    });
  });

  it("lets timeout overrides take precedence over config timeouts", () => {
    expect(
      resolveReviewerConfig({
        spec: "claude-deep",
        timeoutSeconds: 5,
        config: {
          timeoutSeconds: 30,
          reviewers: [{ id: "claude-deep", sdk: "claude", model: "sonnet", timeoutSeconds: 20 }],
        },
      }),
    ).toMatchObject({
      id: "claude-deep",
      timeoutMs: 5000,
    });
  });

  it("applies top-level config timeouts to built-in reviewer specs", () => {
    expect(
      resolveReviewerConfig({
        spec: "claude",
        config: {
          timeoutSeconds: 30,
        },
      }),
    ).toMatchObject({
      id: "claude",
      timeoutMs: 30000,
    });
  });

  it("does not let configured ids shadow built-in reviewer specs", () => {
    expect(
      resolveReviewerConfig({
        spec: "claude",
        config: {
          reviewers: [{ id: "claude", sdk: "pi", model: "anthropic/claude-sonnet" }],
        },
      }),
    ).toMatchObject({
      id: "claude",
      sdk: "claude",
      model: "sonnet",
    });
  });

  it("rejects unknown and locally invalid configured profile selections", () => {
    expect(() =>
      resolveReviewerConfig({
        spec: "pi:missing",
        config: {
          reviewers: [{ id: "pi-openrouter-high", sdk: "pi", profile: "openrouter-high" }],
        },
      }),
    ).toThrow("Unknown reviewer profile: pi:missing");

    expect(() =>
      resolveReviewerConfig({
        spec: "claude-missing",
        config: {
          reviewers: [{ id: "claude-deep", sdk: "claude", model: "sonnet" }],
        },
      }),
    ).toThrow("Unknown configured reviewer: claude-missing");

    expect(() =>
      resolveReviewerConfig({
        spec: "claude-deep",
        model: "opus",
        config: {
          reviewers: [
            { id: "claude-deep", sdk: "claude", model: "sonnet", modelCatalog: ["sonnet"] },
          ],
        },
      }),
    ).toThrow("Model is not allowed for reviewer claude-deep: opus");
  });

  it("preserves validated effort in reviewer config", () => {
    expect(resolveReviewerConfig({ spec: "pi", effort: "high" })).toMatchObject({
      id: "pi",
      sdk: "pi",
      effort: "high",
    });
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
      model: "sonnet",
    });
    expect(resolveReviewerConfig({ spec: "pi" })).not.toHaveProperty("model");
  });
});

describe("resolveReviewerConfigs", () => {
  it("uses default reviewer sets from config when no reviewers are explicit", () => {
    expect(
      resolveReviewerConfigs({
        config: {
          defaultReviewerSet: "2",
          reviewerSets: {
            "2": ["pi", "claude"],
          },
        },
      }).map((reviewer) => reviewer.sdk),
    ).toEqual(["pi", "claude"]);
  });

  it("requires defaultReviewerSet for implicit configured runs", () => {
    expect(() =>
      resolveReviewerConfigs({
        config: {
          reviewerSets: {
            "1": ["pi"],
          },
        },
      }),
    ).toThrow("Config must define defaultReviewerSet for implicit reviewer selection");
  });

  it("requires an explicit reviewer or config default for implicit runs", () => {
    expect(() => resolveReviewerConfigs({})).toThrow(
      "No reviewer selected and no diffwarden config defaultReviewerSet is available",
    );
  });

  it("still allows fake when explicitly selected", () => {
    expect(resolveReviewerConfigs({ reviewers: ["fake"] }).map((reviewer) => reviewer.sdk)).toEqual(
      ["fake"],
    );
  });

  it("rejects ambiguous reviewer selection", () => {
    expect(() =>
      resolveReviewerConfigs({
        reviewers: ["pi"],
        reviewerSet: "2",
        config: {
          reviewerSets: { "2": ["pi", "claude"] },
        },
      }),
    ).toThrow("Use either --reviewer or --reviewer-set, not both");

    expect(() =>
      resolveReviewerConfigs({
        reviewers: ["pi", "claude"],
        model: "sonnet",
      }),
    ).toThrow("--model can only be used with a single reviewer");
  });

  it("rejects empty explicit reviewer specs", () => {
    expect(() => resolveReviewerConfigs({ reviewers: [""] })).toThrow(
      "Reviewer spec cannot be empty",
    );
  });

  it("rejects unknown reviewer sets", () => {
    expect(() => resolveReviewerConfigs({ reviewerSet: "missing", config: {} })).toThrow(
      "Unknown reviewer set: missing",
    );
  });
});
