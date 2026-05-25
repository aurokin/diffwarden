import { describe, expect, it } from "vitest";
import { createPiAdapter, piAdapter } from "../src/adapters/pi.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";
import { missingRequirement } from "../src/core/errors.js";
import { reviewResultJsonSchema } from "../src/core/schema.js";
import { isIntegrationDisabled } from "./integration.js";
import {
  createLiveAdapterInput,
  createLiveFixture,
  expectFixtureReadOnly,
  expectLiveAdapterOutput,
} from "./live/helpers.js";

const defaultPiSmokeModel = "anthropic/claude-sonnet-4-5";

describe("piAdapter", () => {
  it("fails preflight clearly when no Pi models are authenticated", async () => {
    const { adapter } = createMockPiAdapter([]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("preflights available Pi models without requiring live credentials in tests", async () => {
    const { adapter } = createMockPiAdapter([{ provider: "test", id: "test-model" }]);

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "pi",
        sdk: "pi",
        readonly: true,
      },
      readonly: true,
      env: {},
    });

    expect(preflight?.checks.map((check) => check.name)).toEqual([
      "sdk",
      "auth",
      "model",
      "readonly",
    ]);
    expect(preflight?.metadata).toMatchObject({
      readonlyCapability: "tool-restricted",
      preferredCaptureMode: "tool-call",
      availableModelCount: 1,
      model: "test/test-model",
      resolvedModel: "test/test-model",
      modelResolutionSource: "adapter-selection",
    });
  });

  it("fails clearly when the Pi SDK package is not installed", async () => {
    const adapter = createPiAdapter({
      async loadSdk() {
        throw missingRequirement("Failed to load @earendil-works/pi-coding-agent: missing");
      },
    });

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      exitCode: 3,
    });
  });

  it("isolates Pi model availability to the supplied env", async () => {
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    const adapter = createEnvSensitiveMockPiAdapter();

    try {
      await expect(
        adapter.preflight?.({
          cwd: process.cwd(),
          reviewer: {
            id: "pi",
            sdk: "pi",
            readonly: true,
          },
          readonly: true,
          env: {},
        }),
      ).rejects.toMatchObject({
        code: "missing_auth",
        exitCode: 3,
      });

      const preflight = await adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
        },
        readonly: true,
        env: {
          ANTHROPIC_API_KEY: "scoped-key",
        },
      });

      expect(preflight?.metadata?.availableModelCount).toBe(1);
    } finally {
      if (originalAnthropicKey === undefined) {
        Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      }
    }
  });

  it("maps Pi runtime context failures to reviewer errors", async () => {
    const adapter = createPiAdapter({
      async loadSdk() {
        return {
          AuthStorage: {
            inMemory() {
              throw new Error("auth storage failed");
            },
          },
          ModelRegistry: {
            inMemory() {
              throw new Error("unexpected model registry call");
            },
          },
          SessionManager: {
            inMemory(cwd?: string) {
              return { cwd };
            },
          },
          async createAgentSession() {
            throw new Error("unexpected session call");
          },
        };
      },
    });

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      exitCode: 3,
      message: "Pi reviewer setup failed: auth storage failed",
    });
  });

  it("returns structured output captured by the terminating review_output tool", async () => {
    const review = validReview();
    const reviewModel = { provider: "test", id: "test-model" };
    const { adapter, calls } = createMockPiAdapter([reviewModel], {
      async prompt({ prompt, tool }) {
        expect(prompt).toBe("Return a minimal review result.");
        await tool.execute("tool-call-1", review);
      },
    });

    const output = await adapter.run(input());

    expect(output.structured).toEqual(review);
    expect(output.metadata).toMatchObject({
      captureMode: "tool-call",
      readonlyCapability: "tool-restricted",
      availableModelCount: 1,
      model: "test/test-model",
      resolvedModel: "test/test-model",
      modelResolutionSource: "adapter-selection",
    });
    expect(calls.createAgentSession).toHaveLength(1);
    expect(calls.createAgentSession[0]).toMatchObject({
      cwd: process.cwd(),
      model: reviewModel,
      scopedModels: [{ model: reviewModel }],
      tools: ["read", "grep", "find", "ls", "review_output"],
      authStorage: calls.authStorage,
      modelRegistry: calls.modelRegistry,
    });
    expect(calls.createAgentSession[0]?.customTools[0]?.name).toBe("review_output");
    expect(calls.createAgentSession[0]?.customTools[0]?.parameters).toBe(reviewResultJsonSchema);
    const resourceLoader = calls.createAgentSession[0]?.resourceLoader as
      | {
          getExtensions(): unknown;
          getSkills(): unknown;
          getPrompts(): unknown;
          getThemes(): unknown;
          getAgentsFiles(): unknown;
          getSystemPrompt(): unknown;
          getAppendSystemPrompt(): unknown;
        }
      | undefined;
    expect(resourceLoader).toMatchObject({
      getExtensions: expect.any(Function),
      getSkills: expect.any(Function),
      getPrompts: expect.any(Function),
      getThemes: expect.any(Function),
      getAgentsFiles: expect.any(Function),
      getSystemPrompt: expect.any(Function),
      getAppendSystemPrompt: expect.any(Function),
    });
    expect(resourceLoader?.getExtensions()).toEqual({
      extensions: [],
      errors: [],
      runtime: expect.objectContaining({
        flagValues: expect.any(Map),
        pendingProviderRegistrations: [],
      }),
    });
    expect(resourceLoader?.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(resourceLoader?.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(resourceLoader?.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(resourceLoader?.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(resourceLoader?.getSystemPrompt()).toBeUndefined();
    expect(resourceLoader?.getAppendSystemPrompt()).toEqual([]);
    expect(calls.disposed).toBe(1);
  });

  it("does not prompt after setup completes if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timed out"));
    let prompted = false;
    const { adapter, calls } = createMockPiAdapter([{ provider: "test", id: "test-model" }], {
      async prompt() {
        prompted = true;
      },
    });

    await expect(adapter.run(input({ signal: controller.signal }))).rejects.toThrow("timed out");

    expect(prompted).toBe(false);
    expect(calls.aborted).toBe(1);
    expect(calls.disposed).toBe(1);
  });

  it("materializes scoped environment auth for Pi prompt execution", async () => {
    const adapter = createEnvSensitiveMockPiAdapter({
      async prompt({ tool, apiKey, model }) {
        expect(model).toMatchObject({ provider: "anthropic", id: "claude-test" });
        expect(apiKey("anthropic")).toBe("scoped-key");
        await tool.execute("tool-call-1", validReview());
      },
    });

    const output = await adapter.run(
      input({
        env: {
          ANTHROPIC_API_KEY: "scoped-key",
        },
      }),
    );

    expect(output.structured).toEqual(validReview());
  });

  it("uses a requested Pi model when it is available", async () => {
    const requestedModel = { provider: "anthropic", id: "claude-test" };
    const fallbackModel = { provider: "openai", id: "gpt-test" };
    const { adapter, calls } = createMockPiAdapter([fallbackModel, requestedModel], {
      async prompt({ tool }) {
        await tool.execute("tool-call-1", validReview());
      },
    });

    const output = await adapter.run(
      input({
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
          model: "anthropic/claude-test",
        },
      }),
    );

    expect(output.structured).toEqual(validReview());
    expect(output.metadata).toMatchObject({
      model: "anthropic/claude-test",
      requestedModel: "anthropic/claude-test",
      resolvedModel: "anthropic/claude-test",
      modelResolutionSource: "requested",
    });
    expect(calls.createAgentSession[0]).toMatchObject({
      model: requestedModel,
      scopedModels: [{ model: fallbackModel }, { model: requestedModel }],
    });
  });

  it("materializes configured provider auth before Pi model discovery", async () => {
    const openrouterModel = {
      provider: "openrouter",
      id: "anthropic/claude-test",
    };
    const fallbackModel = { provider: "anthropic", id: "claude-test" };
    const { adapter, calls } = createMockPiAdapter((authStorage) =>
      authStorage.getRuntimeApiKey("openrouter") === "openrouter-key"
        ? [fallbackModel, openrouterModel]
        : [fallbackModel],
    );

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "pi-openrouter-high",
        sdk: "pi",
        profile: "openrouter-high",
        provider: "openrouter",
        model: "anthropic/claude-test",
        providerOptions: {
          apiKeyEnv: "OPENROUTER_API_KEY",
          baseUrlEnv: "OPENROUTER_BASE_URL",
        },
        sdkOptions: {
          providerProfile: "openrouter",
        },
        readonly: true,
      },
      readonly: true,
      env: {
        OPENROUTER_API_KEY: "openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.example/v1",
      },
    });

    expect(calls.authStorage.getRuntimeApiKey("openrouter")).toBe("openrouter-key");
    expect(calls.registerProvider).toEqual([
      {
        providerName: "openrouter",
        config: {
          apiKey: "openrouter-key",
          baseUrl: "https://openrouter.example/v1",
        },
      },
    ]);
    expect(preflight?.metadata).toMatchObject({
      model: "openrouter/anthropic/claude-test",
      provider: "openrouter",
      providerProfile: "openrouter",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseUrlEnv: "OPENROUTER_BASE_URL",
    });
  });

  it("runs Pi profiles against the requested provider when multiple providers are available", async () => {
    const openrouterModel = {
      provider: "openrouter",
      id: "anthropic/claude-test",
    };
    const fallbackModel = { provider: "anthropic", id: "claude-test" };
    const { adapter, calls } = createMockPiAdapter([fallbackModel, openrouterModel], {
      async prompt({ tool }) {
        await tool.execute("tool-call-1", validReview());
      },
    });

    const output = await adapter.run(
      input({
        reviewer: {
          id: "pi-openrouter-high",
          sdk: "pi",
          profile: "openrouter-high",
          provider: "openrouter",
          model: "anthropic/claude-test",
          readonly: true,
        },
      }),
    );

    expect(output.structured).toEqual(validReview());
    expect(output.metadata).toMatchObject({
      provider: "openrouter",
    });
    expect(calls.createAgentSession[0]).toMatchObject({
      model: openrouterModel,
      scopedModels: [{ model: openrouterModel }],
    });
  });

  it("rejects incoherent Pi provider profile options", async () => {
    const { adapter } = createMockPiAdapter([{ provider: "openrouter", id: "test-model" }]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi-openrouter-high",
          sdk: "pi",
          profile: "openrouter-high",
          provider: "openrouter",
          sdkOptions: { providerProfile: "anthropic" },
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
      message: "Pi providerProfile must match reviewer.provider for pi-openrouter-high: anthropic",
    });

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi-openrouter-high",
          sdk: "pi",
          profile: "openrouter-high",
          providerOptions: { apiKeyEnv: "OPENROUTER_API_KEY" },
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
      message: "Pi provider options require reviewer.provider",
    });
  });

  it("reports missing configured provider auth env clearly", async () => {
    const { adapter } = createMockPiAdapter([{ provider: "anthropic", id: "claude-test" }]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi-openrouter-high",
          sdk: "pi",
          profile: "openrouter-high",
          provider: "openrouter",
          providerOptions: {
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
      message: "Missing OPENROUTER_API_KEY for Pi provider openrouter",
    });
  });

  it("reports provider-scoped unavailable models as missing auth", async () => {
    const { adapter } = createMockPiAdapter([{ provider: "anthropic", id: "claude-test" }]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi-openrouter-high",
          sdk: "pi",
          profile: "openrouter-high",
          provider: "openrouter",
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
      message: "No authenticated Pi models are available for provider: openrouter",
    });
  });

  it("passes clamped Pi thinking levels for requested effort", async () => {
    const reasoningModel = {
      provider: "test",
      id: "reasoning-model",
      reasoning: true,
      thinkingLevelMap: { minimal: null, xhigh: "max" },
    };
    const { adapter, calls } = createMockPiAdapter([reasoningModel], {
      async prompt({ tool }) {
        await tool.execute("tool-call-1", validReview());
      },
    });

    const output = await adapter.run(
      input({
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
          effort: "minimal",
        },
      }),
    );

    expect(calls.createAgentSession[0]).toMatchObject({
      model: reasoningModel,
      thinkingLevel: "low",
      scopedModels: [{ model: reasoningModel, thinkingLevel: "low" }],
    });
    expect(output.metadata).toMatchObject({
      requestedEffort: "minimal",
      resolvedEffort: "low",
      effortResolutionSource: "adapter-selection",
      effectiveEffort: "low",
      effort: "low",
      supportedEfforts: ["off", "low", "medium", "high", "xhigh"],
    });
  });

  it("rejects unavailable requested Pi models", async () => {
    const { adapter } = createMockPiAdapter([{ provider: "openai", id: "gpt-test" }]);

    await expect(
      adapter.run(
        input({
          reviewer: {
            id: "pi",
            sdk: "pi",
            readonly: true,
            model: "anthropic/claude-test",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_model",
      exitCode: 2,
      message: "Requested Pi model is not available: anthropic/claude-test",
    });
  });

  it("reports invalid review_output arguments even when Pi converts tool errors", async () => {
    const { adapter, calls } = createMockPiAdapter([{ provider: "test", id: "test-model" }], {
      async prompt({ tool }) {
        await expect(
          tool.execute("tool-call-1", { findings: "not-an-array" }),
        ).rejects.toMatchObject({
          code: "reviewer_failed",
        });
      },
    });

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      exitCode: 3,
      message: "Pi reviewer called review_output with invalid arguments",
    });
    expect(calls.disposed).toBe(1);
  });

  it("fails execution clearly when Pi does not call review_output", async () => {
    const { adapter, calls } = createMockPiAdapter([{ provider: "test", id: "test-model" }], {
      async prompt() {},
    });

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      exitCode: 3,
    });
    expect(calls.disposed).toBe(1);
  });

  it("maps prompt failures to reviewer errors and disposes the Pi session", async () => {
    const { adapter, calls } = createMockPiAdapter([{ provider: "test", id: "test-model" }], {
      async prompt() {
        throw new Error("prompt failed");
      },
    });

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      exitCode: 3,
      message: "Pi reviewer failed: prompt failed",
    });
    expect(calls.disposed).toBe(1);
  });

  it.skipIf(isIntegrationDisabled("pi"))(
    "runs a live Pi structured review smoke test",
    async () => {
      const fixture = createLiveFixture("diffwarden-live-pi-sdk-");
      const smokeModel = process.env.PI_SMOKE_MODEL ?? defaultPiSmokeModel;
      const reviewer = {
        id: "pi",
        sdk: "pi" as const,
        readonly: true,
        model: smokeModel,
      };
      try {
        const preflight = await piAdapter.preflight?.({
          cwd: fixture.repo,
          reviewer,
          readonly: true,
          env: process.env,
        });
        const output = await piAdapter.run(
          await createLiveAdapterInput(fixture, reviewer, process.env),
        );

        expect(preflight?.metadata?.readonlyCapability).toBe("tool-restricted");
        expect(preflight?.metadata?.preferredCaptureMode).toBe("tool-call");
        expect(output.metadata?.captureMode).toBe("tool-call");
        expect(output.metadata?.readonlyCapability).toBe("tool-restricted");
        expectLiveAdapterOutput(output);
        expectFixtureReadOnly(fixture.repo);
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );
});

type MockPiPromptHandler = (input: {
  prompt: string;
  model: unknown;
  tool: {
    execute(toolCallId: string, params: unknown): Promise<unknown>;
  };
  apiKey(provider: string): string | undefined;
}) => Promise<void>;

type MockPiModel = {
  provider?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
  >;
};

type MockPiModelRegistry = {
  getAvailable(): MockPiModel[];
  getProviderAuthStatus?(provider: string): { source?: string; label?: string };
  registerProvider(providerName: string, config: { baseUrl?: string; apiKey?: string }): void;
};

type MockPiAuthStorage = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
  getRuntimeApiKey(provider: string): string | undefined;
};

function createMockPiAdapter(
  availableModels: MockPiModel[] | ((authStorage: MockPiAuthStorage) => MockPiModel[]),
  options: { prompt?: MockPiPromptHandler } = {},
) {
  const calls: {
    createAgentSession: Array<{
      cwd: string;
      model: unknown;
      scopedModels: Array<{ model: unknown; thinkingLevel?: string }>;
      thinkingLevel?: string;
      tools: string[];
      customTools: Array<{
        name: string;
        parameters: unknown;
        execute(toolCallId: string, params: unknown): Promise<unknown>;
      }>;
      resourceLoader: unknown;
      sessionManager: unknown;
      authStorage: unknown;
      modelRegistry: unknown;
    }>;
    aborted: number;
    disposed: number;
    registerProvider: Array<{
      providerName: string;
      config: { baseUrl?: string; apiKey?: string };
    }>;
    authStorage: MockPiAuthStorage;
    modelRegistry: MockPiModelRegistry;
  } = {
    createAgentSession: [],
    aborted: 0,
    disposed: 0,
    registerProvider: [],
    authStorage: createMockPiAuthStorage(),
    modelRegistry: {
      getAvailable() {
        return typeof availableModels === "function"
          ? availableModels(calls.authStorage)
          : availableModels;
      },
      registerProvider(providerName, config) {
        calls.registerProvider.push({ providerName, config });
      },
    },
  };

  const adapter = createPiAdapter({
    async loadSdk() {
      return {
        AuthStorage: {
          inMemory() {
            return calls.authStorage;
          },
        },
        ModelRegistry: {
          inMemory() {
            return calls.modelRegistry;
          },
        },
        SessionManager: {
          inMemory(cwd?: string) {
            return { cwd };
          },
        },
        async createAgentSession(sessionOptions) {
          calls.createAgentSession.push(sessionOptions);
          const tool = sessionOptions.customTools[0];
          if (tool === undefined) {
            throw new Error("Missing review_output tool");
          }

          return {
            session: {
              async prompt(prompt: string) {
                await options.prompt?.({
                  prompt,
                  model: sessionOptions.model,
                  tool,
                  apiKey(provider) {
                    return calls.authStorage.getRuntimeApiKey(provider);
                  },
                });
              },
              async abort() {
                calls.aborted += 1;
              },
              dispose() {
                calls.disposed += 1;
              },
            },
          };
        },
      };
    },
  });

  return { adapter, calls };
}

function createEnvSensitiveMockPiAdapter(options: { prompt?: MockPiPromptHandler } = {}) {
  return createPiAdapter({
    async loadSdk() {
      const authStorage = createMockPiAuthStorage();

      return {
        AuthStorage: {
          inMemory() {
            return authStorage;
          },
        },
        ModelRegistry: {
          inMemory() {
            return {
              getAvailable() {
                return process.env.ANTHROPIC_API_KEY
                  ? [{ provider: "anthropic", id: "claude-test" }]
                  : [];
              },
              getProviderAuthStatus(provider: string) {
                if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
                  return { source: "environment", label: "ANTHROPIC_API_KEY" };
                }

                return {};
              },
            };
          },
        },
        SessionManager: {
          inMemory(cwd?: string) {
            return { cwd };
          },
        },
        async createAgentSession(sessionOptions) {
          const tool = sessionOptions.customTools[0];
          if (tool === undefined) {
            throw new Error("Missing review_output tool");
          }

          return {
            session: {
              async prompt(prompt: string) {
                await options.prompt?.({
                  prompt,
                  model: sessionOptions.model,
                  tool,
                  apiKey(provider) {
                    return authStorage.getRuntimeApiKey(provider);
                  },
                });
              },
              async abort() {},
              dispose() {},
            },
          };
        },
      };
    },
  });
}

function createMockPiAuthStorage(): MockPiAuthStorage {
  const runtimeApiKeys = new Map<string, string>();
  return {
    setRuntimeApiKey(provider, apiKey) {
      runtimeApiKeys.set(provider, apiKey);
    },
    getRuntimeApiKey(provider) {
      return runtimeApiKeys.get(provider);
    },
  };
}

function validReview() {
  return {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "No findings.",
    overall_confidence_score: 0.9,
  };
}

function input(overrides: Partial<ReviewAdapterInput> = {}): ReviewAdapterInput {
  return {
    cwd: process.cwd(),
    reviewer: {
      id: "pi",
      sdk: "pi",
      readonly: true,
    },
    target: {
      kind: "uncommitted",
      repo_root: process.cwd(),
      diff_command: "git diff",
      changed_files: [],
    },
    diff: "",
    changedFiles: [],
    prompt: "Return a minimal review result.",
    readonly: true,
    env: {},
    ...overrides,
  };
}
