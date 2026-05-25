import type { DroidResultMessage } from "@factory/droid-sdk";
import { describe, expect, it } from "vitest";
import { createDroidAdapter, droidAdapter } from "../src/adapters/droid.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";
import { missingRequirement } from "../src/core/errors.js";
import { isIntegrationDisabled } from "./integration.js";
import {
  createLiveAdapterInput,
  createLiveFixture,
  expectFixtureReadOnly,
  expectLiveAdapterOutput,
} from "./live/helpers.js";

describe("droidAdapter", () => {
  it("preflights the SDK, executable, auth, model, and effort", async () => {
    const calls: unknown[] = [];
    const adapter = createDroidAdapter({
      loadSdk: async () => mockDroidSdk(calls),
      checkExecutable: async (executable, env) => {
        calls.push({ executable, env });
        return executable;
      },
    });
    const reviewer = createReviewer({
      cliOptions: { executable: "/opt/droid" },
      sdkOptions: { machineId: "machine-123" },
      model: "claude-test",
      effort: "minimal",
    });

    const preflight = await adapter.preflight?.({
      cwd: "/repo",
      reviewer,
      readonly: true,
      env: { FACTORY_API_KEY: "factory-key" },
    });

    expect(preflight?.checks.map((check) => [check.name, check.status])).toEqual([
      ["sdk", "passed"],
      ["executable", "passed"],
      ["auth", "passed"],
      ["readonly", "passed"],
      ["model", "passed"],
      ["effort", "passed"],
      ["machine", "passed"],
    ]);
    expect(preflight?.metadata).toMatchObject({
      readonlyCapability: "enforced",
      transport: "sdk",
      executable: "/opt/droid",
      model: "claude-test",
      effort: "low",
      machineId: "machine-123",
      sdkVersion: "0.3.0-test",
    });
    expect(calls).toContainEqual(
      expect.objectContaining({
        executable: "/opt/droid",
        env: expect.objectContaining({ FACTORY_API_KEY: "factory-key" }),
      }),
    );
  });

  it("preflights auth against the supplied environment", async () => {
    const adapter = createDroidAdapter({
      loadSdk: async () => mockDroidSdk([]),
      checkExecutable: async (executable) => executable,
    });
    const originalKey = process.env.FACTORY_API_KEY;
    process.env.FACTORY_API_KEY = "ambient-key";

    try {
      const preflight = await adapter.preflight?.({
        cwd: "/repo",
        reviewer: createReviewer(),
        readonly: true,
        env: {},
      });

      expect(preflight?.checks.find((check) => check.name === "auth")).toMatchObject({
        status: "warning",
      });
    } finally {
      if (originalKey === undefined) {
        process.env.FACTORY_API_KEY = undefined;
      } else {
        process.env.FACTORY_API_KEY = originalKey;
      }
    }
  });

  it("preserves PATH when checking Droid with a partial supplied environment", async () => {
    const calls: unknown[] = [];
    const adapter = createDroidAdapter({
      loadSdk: async () => mockDroidSdk([]),
      checkExecutable: async (executable, env) => {
        calls.push({ executable, env });
        return executable;
      },
    });
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/local/bin";

    try {
      await adapter.preflight?.({
        cwd: "/repo",
        reviewer: createReviewer(),
        readonly: true,
        env: { FACTORY_API_KEY: "factory-key" },
      });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(calls).toContainEqual({
      executable: "droid",
      env: { PATH: "/usr/local/bin", FACTORY_API_KEY: "factory-key" },
    });
  });

  it("returns structured output from Droid structuredOutput", async () => {
    const calls: unknown[] = [];
    const adapter = createDroidAdapter({
      loadSdk: async () => mockDroidSdk(calls),
      checkExecutable: async (executable) => executable,
    });
    const reviewer = createReviewer({ model: "claude-test", effort: "xhigh" });

    const output = await adapter.run(createInput(reviewer));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "droid ok",
    });
    expect(output.usage).toEqual({ inputTokens: 10 });
    expect(output.metadata).toMatchObject({
      captureMode: "native-structured",
      readonlyCapability: "enforced",
      transport: "sdk",
      executable: "droid",
      model: "claude-test",
      requestedModel: "claude-test",
      resolvedModel: "claude-test",
      modelResolutionSource: "provider-init",
      effort: "xhigh",
      requestedEffort: "xhigh",
      resolvedEffort: "xhigh",
      effortResolutionSource: "provider-init",
      sessionId: "session-1",
      durationMs: 123,
      turnCount: 1,
    });
    expect(calls).toContainEqual({
      createSessionOptions: expect.objectContaining({
        cwd: "/repo",
        execPath: "droid",
        specModeModelId: "claude-test",
        specModeReasoningEffort: "xhigh",
        interactionMode: "spec",
        autonomyLevel: "off",
        tags: [
          {
            name: "diffwarden",
            metadata: {
              reviewer: "droid",
              target: "custom",
              transport: "sdk",
            },
          },
        ],
      }),
    });
    expect(calls).toContainEqual({
      streamPrompt: "review prompt",
      options: expect.objectContaining({
        outputFormat: expect.objectContaining({ type: "json_schema" }),
      }),
    });
    expect(calls).toContainEqual({ close: "session-1" });
  });

  it("passes configured Droid machine IDs to SDK runs", async () => {
    const calls: unknown[] = [];
    const adapter = createDroidAdapter({
      loadSdk: async () => mockDroidSdk(calls),
      checkExecutable: async (executable) => executable,
    });
    const reviewer = createReviewer({ sdkOptions: { machineId: "machine-456" } });

    const output = await adapter.run(createInput(reviewer));

    expect(output.metadata).toMatchObject({ machineId: "machine-456" });
    expect(calls).toContainEqual({
      createSessionOptions: expect.objectContaining({
        machineId: "machine-456",
      }),
    });
  });

  it("falls back to text when structured output is invalid", async () => {
    const adapter = createDroidAdapter({
      loadSdk: async () =>
        mockDroidSdk([], {
          structuredOutput: { nope: true },
          text: "plain review text",
        }),
      checkExecutable: async (executable) => executable,
    });

    const output = await adapter.run(createInput(createReviewer()));

    expect(output.text).toBe("plain review text");
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      fallbackReason: "invalid_structured_output",
    });
  });

  it("maps missing SDK and auth failures to Diffwarden errors", async () => {
    const missingAdapter = createDroidAdapter({
      loadSdk: async () => {
        throw missingRequirement("Failed to load @factory/droid-sdk: missing");
      },
      checkExecutable: async (executable) => executable,
    });

    await expect(missingAdapter.run(createInput(createReviewer()))).rejects.toMatchObject({
      code: "missing_requirement",
    });

    const authAdapter = createDroidAdapter({
      loadSdk: async () =>
        mockDroidSdk([], undefined, () => {
          throw new Error("FACTORY_API_KEY unauthorized");
        }),
      checkExecutable: async (executable) => executable,
    });

    await expect(authAdapter.run(createInput(createReviewer()))).rejects.toMatchObject({
      code: "missing_auth",
      message: expect.stringContaining("Droid authentication failed"),
    });
  });

  it("maps unsuccessful Droid results to reviewer failures", async () => {
    const adapter = createDroidAdapter({
      loadSdk: async () =>
        mockDroidSdk([], {
          success: false,
          error: { message: "model failed" } as DroidResultMessage["error"],
        }),
      checkExecutable: async (executable) => executable,
    });

    await expect(adapter.run(createInput(createReviewer()))).rejects.toMatchObject({
      code: "reviewer_failed",
      message: "Droid reviewer failed: model failed",
    });
  });

  it("does not classify non-executable not-found errors as missing requirements", async () => {
    const adapter = createDroidAdapter({
      loadSdk: async () =>
        mockDroidSdk([], undefined, () => {
          throw new Error("model not found: claude-test");
        }),
      checkExecutable: async (executable) => executable,
    });

    await expect(adapter.run(createInput(createReviewer()))).rejects.toMatchObject({
      code: "reviewer_failed",
      message: "Droid reviewer failed: model not found: claude-test",
    });
  });

  it.skipIf(isIntegrationDisabled("droid"))(
    "runs a live Droid SDK review without modifying the fixture",
    async () => {
      const fixture = createLiveFixture("diffwarden-live-droid-sdk-");
      const reviewer = createReviewer({
        ...optionalString("model", process.env.DIFFWARDEN_LIVE_DROID_MODEL),
        ...optionalString("effort", process.env.DIFFWARDEN_LIVE_DROID_EFFORT),
        ...cliOptions(process.env.DIFFWARDEN_LIVE_DROID_EXECUTABLE),
        ...sdkOptions(process.env.DIFFWARDEN_LIVE_DROID_MACHINE_ID),
      });

      try {
        const preflight = await droidAdapter.preflight?.({
          cwd: fixture.repo,
          reviewer,
          readonly: true,
          env: process.env,
        });
        const output = await droidAdapter.run(await createLiveAdapterInput(fixture, reviewer));

        expect(preflight?.metadata?.transport).toBe("sdk");
        expectLiveAdapterOutput(output);
        expectFixtureReadOnly(fixture.repo);
      } finally {
        fixture.cleanup();
      }
    },
    180_000,
  );
});

function createReviewer(extra: Partial<ReviewReviewerConfig> = {}): ReviewReviewerConfig {
  return {
    id: "droid",
    sdk: "droid",
    readonly: true,
    ...extra,
  };
}

function createInput(reviewer: ReviewReviewerConfig) {
  return {
    cwd: "/repo",
    reviewer,
    target: {
      kind: "custom",
      repo_root: "/repo",
      diff_command: "test diff",
      changed_files: ["file.ts"],
    },
    diff: "diff --git a/file.ts b/file.ts\n",
    changedFiles: ["file.ts"],
    prompt: "review prompt",
    readonly: true,
    env: { FACTORY_API_KEY: "factory-key" },
  } satisfies ReviewAdapterInput;
}

function mockDroidSdk(
  calls: unknown[],
  overrides: Partial<MockDroidResult> = {},
  createSessionOverride?: () => never,
) {
  return {
    SDK_VERSION: "0.3.0-test",
    OutputFormatType: { JsonSchema: "json_schema" },
    DroidInteractionMode: { Spec: "spec" },
    AutonomyLevel: { Off: "off" },
    DroidMessageType: { Result: "result" },
    async createSession(options: unknown) {
      calls.push({ createSessionOptions: options });
      createSessionOverride?.();
      const sessionOptions = options as {
        specModeModelId?: string;
        specModeReasoningEffort?: string;
      };
      return {
        sessionId: "session-1",
        initResult: {
          settings: {
            modelId: "droid-default-model",
            reasoningEffort: "medium",
            ...(sessionOptions.specModeModelId !== undefined
              ? { specModeModelId: sessionOptions.specModeModelId }
              : {}),
            ...(sessionOptions.specModeReasoningEffort !== undefined
              ? { specModeReasoningEffort: sessionOptions.specModeReasoningEffort }
              : {}),
          },
        },
        async *stream(prompt: string, streamOptions: unknown) {
          calls.push({ streamPrompt: prompt, options: streamOptions });
          yield {
            type: "result",
            subtype: "success",
            isError: false,
            sessionId: "session-1",
            text: "droid ok",
            messages: [],
            tokenUsage: { inputTokens: 10 },
            durationMs: 123,
            turnCount: 1,
            error: null,
            structuredOutput: {
              findings: [],
              overall_correctness: "patch is correct",
              overall_explanation: "droid ok",
              overall_confidence_score: 1,
            },
            success: true,
            ...overrides,
          };
        },
        async close() {
          calls.push({ close: "session-1" });
        },
      };
    },
  } as typeof import("@factory/droid-sdk");
}

type MockDroidResult = DroidResultMessage;

function optionalString<K extends "model" | "effort">(
  key: K,
  value: string | undefined,
): Pick<ReviewReviewerConfig, K> | Record<string, never> {
  return value === undefined || value.trim() === ""
    ? {}
    : ({ [key]: value } as Pick<ReviewReviewerConfig, K>);
}

function cliOptions(executable: string | undefined): Pick<ReviewReviewerConfig, "cliOptions"> {
  return executable === undefined || executable.trim() === "" ? {} : { cliOptions: { executable } };
}

function sdkOptions(machineId: string | undefined): Pick<ReviewReviewerConfig, "sdkOptions"> {
  return machineId === undefined || machineId.trim() === "" ? {} : { sdkOptions: { machineId } };
}
