import { describe, expect, it } from "vitest";
import { createPiAdapter } from "../src/adapters/pi.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";
import { missingRequirement } from "../src/core/errors.js";
import { reviewResultJsonSchema } from "../src/core/schema.js";

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
    expect(calls.createAgentSession[0]).toMatchObject({
      model: requestedModel,
      scopedModels: [{ model: fallbackModel }, { model: requestedModel }],
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
});

type MockPiPromptHandler = (input: {
  prompt: string;
  model: unknown;
  tool: {
    execute(toolCallId: string, params: unknown): Promise<unknown>;
  };
  apiKey(provider: string): string | undefined;
}) => Promise<void>;

type MockPiModelRegistry = {
  getAvailable(): Array<{ provider?: unknown; id?: unknown }>;
  getProviderAuthStatus?(provider: string): { source?: string; label?: string };
};

type MockPiAuthStorage = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
  getRuntimeApiKey(provider: string): string | undefined;
};

function createMockPiAdapter(
  availableModels: Array<{ provider?: unknown; id?: unknown }>,
  options: { prompt?: MockPiPromptHandler } = {},
) {
  const calls: {
    createAgentSession: Array<{
      cwd: string;
      model: unknown;
      scopedModels: Array<{ model: unknown }>;
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
    disposed: number;
    authStorage: MockPiAuthStorage;
    modelRegistry: MockPiModelRegistry;
  } = {
    createAgentSession: [],
    disposed: 0,
    authStorage: createMockPiAuthStorage(),
    modelRegistry: {
      getAvailable() {
        return availableModels;
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
