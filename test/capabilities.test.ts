import { describe, expect, it } from "vitest";
import {
  defaultReviewerModel,
  defaultReviewerTransport,
  getReviewerAuthSignal,
  getTransportCapability,
  reviewerCapabilities,
  reviewerSdkPackage,
  reviewerSdkValues,
} from "../src/adapters/capabilities.js";
import { resolveReviewerConfig } from "../src/core/reviewer.js";

const expectedReviewerSdks = [
  "fake",
  "cursor",
  "claude",
  "pi",
  "droid",
  "copilot",
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
    expect(defaultReviewerModel("copilot")).toBeUndefined();

    expect(defaultReviewerTransport("copilot")).toBeUndefined();
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
    expect(getTransportCapability("copilot", "sdk")).toMatchObject({
      captureMode: "text",
      readonlyCapability: "tool-restricted",
    });
    expect(getTransportCapability("copilot", "cli")).toMatchObject({
      defaultExecutable: "copilot",
      supportsModel: true,
      supportsEffort: true,
      captureMode: "text",
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

  it("owns the SDK package name for every sdk-transport engine", () => {
    expect(reviewerSdkPackage("cursor")).toBe("@cursor/sdk");
    expect(reviewerSdkPackage("claude")).toBe("@anthropic-ai/claude-agent-sdk");
    expect(reviewerSdkPackage("pi")).toBe("@earendil-works/pi-coding-agent");
    expect(reviewerSdkPackage("droid")).toBe("@factory/droid-sdk");
    expect(reviewerSdkPackage("copilot")).toBe("@github/copilot-sdk");

    // CLI-only engines expose no sdk transport, so no SDK package.
    expect(reviewerSdkPackage("codex")).toBeUndefined();
    expect(reviewerSdkPackage("gemini")).toBeUndefined();
    expect(reviewerSdkPackage("opencode")).toBeUndefined();
    expect(reviewerSdkPackage("grok")).toBeUndefined();
    expect(reviewerSdkPackage("antigravity")).toBeUndefined();
    expect(reviewerSdkPackage("fake")).toBeUndefined();
  });

  it("declares only sdk-transport packages on the sdk capability", () => {
    for (const sdk of reviewerSdkValues) {
      expect(getTransportCapability(sdk, "cli")?.sdkPackage).toBeUndefined();
      expect(getTransportCapability(sdk, "app-server")?.sdkPackage).toBeUndefined();
      expect(getTransportCapability(sdk, "sdk")?.sdkPackage).toBe(reviewerSdkPackage(sdk));
    }
  });

  it("owns token-free auth signals for host-aware discovery", () => {
    expect(getReviewerAuthSignal("cursor")).toEqual({
      envVars: ["CURSOR_API_KEY"],
      loginDelegated: true,
      explicitAuthTransports: ["sdk"],
    });
    expect(getReviewerAuthSignal("claude")).toEqual({
      envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      loginDelegated: true,
    });
    expect(getReviewerAuthSignal("droid")).toEqual({
      envVars: ["FACTORY_API_KEY"],
      envVarsOptional: true,
      loginDelegated: true,
    });
    expect(getReviewerAuthSignal("codex")).toEqual({
      credentialFile: { baseEnvVar: "CODEX_HOME", homeSubdir: ".codex", file: "auth.json" },
    });
    expect(getReviewerAuthSignal("antigravity")).toEqual({
      credentialFile: { homeSubdir: ".gemini", file: "oauth_creds.json" },
      loginDelegated: true,
    });
    expect(getReviewerAuthSignal("gemini")).toEqual({
      credentialFile: { homeSubdir: ".gemini", file: "oauth_creds.json" },
      loginDelegated: true,
    });

    expect(getReviewerAuthSignal("opencode")).toEqual({
      credentialFile: { homeSubdir: ".local/share/opencode", file: "auth.json" },
      loginDelegated: true,
    });

    // Login-delegated engines with no token-free positive signal.
    expect(getReviewerAuthSignal("pi")).toEqual({ loginDelegated: true });
    expect(getReviewerAuthSignal("grok")).toEqual({ loginDelegated: true });

    // fake has no auth surface.
    expect(getReviewerAuthSignal("fake")).toBeUndefined();
  });

  it("keeps every declared auth env var a non-empty uppercase token", () => {
    for (const sdk of reviewerSdkValues) {
      for (const envVar of getReviewerAuthSignal(sdk)?.envVars ?? []) {
        expect(envVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});
