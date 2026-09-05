import type { ModelSelection, RunError } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
  cursorReviewAutoReview,
  cursorReviewMcpServers,
  cursorReviewMode,
  cursorReviewSandboxOptions,
  cursorReviewSettingSources,
} from "../src/adapters/cursor-policy.js";
import {
  createCursorAdapter,
  cursorAdapter,
  parseCursorCliModels,
} from "../src/adapters/cursor.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";
import { isIntegrationDisabled } from "./integration.js";
import {
  createLiveAdapterInput,
  createLiveFixture,
  expectFixtureReadOnly,
  expectLiveAdapterOutput,
} from "./live/helpers.js";

describe("cursorAdapter", () => {
  it("preflights auth before loading the SDK", async () => {
    await expect(
      cursorAdapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "cursor",
          sdk: "cursor",
          model: "composer-2.5",
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

  it("fails clearly when CURSOR_API_KEY is missing", async () => {
    await expect(cursorAdapter.run(input({ env: {} }))).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("preflights requested Cursor models through the SDK model list", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          models: [{ id: "composer-2.5", aliases: ["composer-latest"] }],
        });
      },
    });

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "cursor",
        sdk: "cursor",
        model: "composer-latest",
        readonly: true,
      },
      readonly: true,
      env: { CURSOR_API_KEY: "key" },
    });

    expect(preflight?.checks.find((check) => check.name === "model")).toMatchObject({
      status: "passed",
      detail: "Cursor model alias is available: composer-latest -> composer-2.5.",
    });
    expect(preflight?.metadata).toMatchObject({
      model: "composer-latest",
      canonicalModel: "composer-2.5",
      modelAlias: "composer-latest",
      requestedModel: "composer-latest",
      resolvedModel: "composer-2.5",
      modelResolutionSource: "adapter-selection",
    });
  });

  it("rejects unavailable Cursor models during preflight", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          models: [{ id: "composer-2.5", aliases: ["composer-latest"] }],
        });
      },
    });

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "cursor",
          sdk: "cursor",
          model: "missing-model",
          readonly: true,
        },
        readonly: true,
        env: { CURSOR_API_KEY: "key" },
      }),
    ).rejects.toMatchObject({
      code: "invalid_model",
      exitCode: 2,
      message: "Cursor model is not available: missing-model",
    });
  });

  it("maps Cursor model-list auth failures to missing auth", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          async listModels() {
            const error = new Error("invalid API key");
            error.name = "AuthenticationError";
            throw error;
          },
        });
      },
    });

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "cursor",
          sdk: "cursor",
          model: "composer-2.5",
          readonly: true,
        },
        readonly: true,
        env: { CURSOR_API_KEY: "bad-key" },
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
      message: "Cursor model preflight authentication failed: invalid API key",
    });
  });

  it("configures Cursor SDK local review controls", async () => {
    let createOptions: unknown;
    let storeRoot: string | undefined;
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          createStore(rootDir) {
            storeRoot = rootDir;
          },
          async createAgent(options) {
            createOptions = options;
            return {
              agentId: "agent-1",
              async send() {
                return {
                  id: "run-1",
                  async cancel() {},
                  async wait() {
                    return {
                      status: "finished",
                      result: "",
                      model: { id: "composer-2.5" },
                      durationMs: 12,
                    };
                  },
                };
              },
              async [Symbol.asyncDispose]() {},
            };
          },
        });
      },
    });

    const output = await adapter.run(input({ env: { CURSOR_API_KEY: "key" } }));

    expect(createOptions).toMatchObject({
      apiKey: "key",
      model: { id: "composer-2.5" },
      mode: cursorReviewMode,
      tools: ["read", "grep", "glob", "ls"],
      mcpServers: cursorReviewMcpServers,
      local: {
        cwd: process.cwd(),
        autoReview: cursorReviewAutoReview,
        sandboxOptions: cursorReviewSandboxOptions,
        settingSources: cursorReviewSettingSources,
      },
    });
    expect(createOptions).toHaveProperty("local.store");
    expect(storeRoot).toContain("diffwarden-cursor-sdk-");
    expect(output.metadata).toMatchObject({
      cursorMode: cursorReviewMode,
      cursorTools: ["read", "grep", "glob", "ls"],
      cursorAutoReview: cursorReviewAutoReview,
      cursorSandboxEnabled: cursorReviewSandboxOptions.enabled,
      cursorSettingSources: cursorReviewSettingSources,
      cursorMcpServers: [],
      cursorStore: "jsonl-ephemeral",
    });
  });

  it("classifies unsupported Cursor SDK sandboxing as an environment failure", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          async createAgent() {
            throw new Error(
              "Local SDK sandboxing was requested, but sandboxing is not supported in this environment.",
            );
          },
        });
      },
    });

    await expect(adapter.run(input({ env: { CURSOR_API_KEY: "key" } }))).rejects.toMatchObject({
      code: "reviewer_environment_failed",
      exitCode: 3,
      reason: "cursor_sdk_sandbox_unsupported",
      recovery: expect.arrayContaining([
        "Run the Cursor reviewer on a host where Cursor SDK local sandboxing is supported.",
      ]),
      message: expect.stringContaining("did not retry unsandboxed"),
    });
  });

  it("classifies Cursor ConfigurationError sandbox dependency failures", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          async createAgent() {
            const error = new Error("Sandbox missing dependency: bwrap");
            error.name = "ConfigurationError";
            throw error;
          },
        });
      },
    });

    await expect(adapter.run(input({ env: { CURSOR_API_KEY: "key" } }))).rejects.toMatchObject({
      code: "reviewer_environment_failed",
      reason: "cursor_sdk_sandbox_unsupported",
      message: expect.stringContaining("Sandbox missing dependency: bwrap"),
    });
  });

  it("cancels a Cursor run that appears after the signal aborts during send", async () => {
    const controller = new AbortController();
    const sendStarted = deferred<void>();
    const sendResult = deferred<MockCursorRun>();
    const calls = {
      cancel: 0,
      dispose: 0,
      wait: 0,
    };
    const run: MockCursorRun = {
      id: "run-1",
      async cancel() {
        calls.cancel += 1;
      },
      async wait() {
        calls.wait += 1;
        return {
          status: "finished",
          result: "",
        };
      },
    };
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          async createAgent() {
            return {
              agentId: "agent-1",
              async send() {
                sendStarted.resolve();
                return sendResult.promise;
              },
              async [Symbol.asyncDispose]() {
                calls.dispose += 1;
              },
            };
          },
        });
      },
    });

    const review = adapter.run(
      input({ env: { CURSOR_API_KEY: "key" }, signal: controller.signal }),
    );
    await sendStarted.promise;
    controller.abort(new Error("timed out"));
    sendResult.resolve(run);

    await expect(review).rejects.toThrow("timed out");
    expect(calls.cancel).toBe(1);
    expect(calls.dispose).toBeGreaterThanOrEqual(1);
    expect(calls.wait).toBe(0);
  });

  it("reports requested effort as ignored when Cursor SDK has no effort control", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          models: [{ id: "composer-2.5" }],
          async createAgent() {
            return {
              agentId: "agent-1",
              async send() {
                return {
                  id: "run-1",
                  async cancel() {},
                  async wait() {
                    return {
                      status: "finished",
                      result: "",
                      model: { id: "composer-2.5" },
                      durationMs: 12,
                    };
                  },
                };
              },
              async [Symbol.asyncDispose]() {},
            };
          },
        });
      },
    });
    const reviewer = {
      id: "cursor",
      sdk: "cursor" as const,
      model: "composer-2.5",
      effort: "high",
      readonly: true,
    };

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer,
      readonly: true,
      env: { CURSOR_API_KEY: "key" },
    });
    const output = await adapter.run(input({ reviewer, env: { CURSOR_API_KEY: "key" } }));

    expect(preflight?.metadata).toMatchObject({
      requestedEffort: "high",
      effortResolutionSource: "unsupported",
      effort: "ignored",
    });
    expect(output.metadata).toMatchObject({
      model: "composer-2.5",
      requestedModel: "composer-2.5",
      resolvedModel: "composer-2.5",
      modelResolutionSource: "provider-result",
      requestedEffort: "high",
      effortResolutionSource: "unsupported",
      effort: "ignored",
    });
  });

  it("preserves structured Cursor run failures", async () => {
    const adapter = adapterWithResult({
      status: "error",
      result: "",
      error: { message: "Model quota exhausted", code: "resource_exhausted" },
    });
    await expect(adapter.run(input({ env: { CURSOR_API_KEY: "key" } }))).rejects.toMatchObject({
      code: "reviewer_failed",
      message:
        "Cursor reviewer finished with status: error: Model quota exhausted (resource_exhausted)",
    });
  });

  it("extracts resolved model metadata from the SDK ModelSelection result", async () => {
    const adapter = adapterWithResult({
      status: "finished",
      result: "cursor ok",
      model: {
        id: "composer-2.5",
        params: [{ id: "thinking", value: "high" }],
      },
      durationMs: 12,
    });

    const output = await adapter.run(
      input({
        reviewer: {
          id: "cursor",
          sdk: "cursor",
          model: "composer-latest",
          readonly: true,
        },
        env: { CURSOR_API_KEY: "key" },
      }),
    );

    expect(output.metadata).toMatchObject({
      model: "composer-2.5",
      requestedModel: "composer-latest",
      resolvedModel: "composer-2.5",
      modelResolutionSource: "provider-result",
    });
  });

  it("falls back to the adapter default when the SDK result omits its model", async () => {
    const adapter = adapterWithResult({
      status: "finished",
      result: "cursor ok",
      durationMs: 12,
    });

    const output = await adapter.run(
      input({
        reviewer: {
          id: "cursor",
          sdk: "cursor",
          readonly: true,
        },
        env: { CURSOR_API_KEY: "key" },
      }),
    );

    expect(output.metadata).toMatchObject({
      model: "composer-2.5",
      resolvedModel: "composer-2.5",
      modelResolutionSource: "adapter-default",
    });
    expect(output.metadata).not.toHaveProperty("requestedModel");
  });

  describe("SDK debug output (onStep step summaries)", () => {
    const SENTINEL = "LEAK_ME";

    /**
     * Scripted ConversationSteps mirroring the live-captured shapes
     * (2026-07-15): thinking text, a read toolCall whose result embeds the
     * raw file body, an mcp toolCall, plus defensive user-flavored and
     * unknown step types. Synthetic fixtures only — no raw provider capture.
     */
    function scriptedCursorSteps(): unknown[] {
      return [
        {
          type: "thinkingMessage",
          message: { text: `${SENTINEL} reasoning`, thinkingDurationMs: 5 },
        },
        { type: "assistantMessage", message: { text: "checking the diff" } },
        {
          type: "toolCall",
          message: {
            type: "read",
            args: { path: "/repo/file.ts" },
            result: { status: "success", value: { content: SENTINEL, totalLines: 1 } },
          },
        },
        {
          type: "toolCall",
          message: { type: "mcp", args: { toolName: "search-docs", args: { query: SENTINEL } } },
        },
        { type: "userMessage", message: { text: "12345678" } },
        { type: "somethingNew", payload: SENTINEL },
        { type: "assistantMessage", message: { text: "cursor ok" } },
      ];
    }

    type RecordedSend = { prompt: string; options: MockCursorSendOptions | undefined };

    function createStepAdapter(
      sendCalls: RecordedSend[],
      resultOverrides: Partial<Awaited<ReturnType<MockCursorRun["wait"]>>> = {},
    ) {
      return createCursorAdapter({
        async loadSdk() {
          return mockCursorSdk({
            async createAgent() {
              return {
                agentId: "agent-1",
                async send(prompt, options) {
                  sendCalls.push({ prompt, options });
                  return {
                    id: "run-1",
                    async cancel() {},
                    async wait() {
                      // Steps fire while wait() is pending, from the SDK's own
                      // stream loop; the mock replays them before resolving.
                      for (const step of scriptedCursorSteps()) {
                        await options?.onStep?.({ step });
                      }
                      return {
                        status: "finished",
                        result: "cursor ok",
                        model: { id: "composer-2.5" },
                        durationMs: 12,
                        ...resultOverrides,
                      };
                    },
                  };
                },
                async [Symbol.asyncDispose]() {},
              };
            },
          });
        },
      });
    }

    it("streams cursor SDK step summaries into the debug callback", async () => {
      const adapter = createStepAdapter([]);
      const chunks: Array<{ stream: "stdout" | "stderr"; text: string }> = [];

      const output = await adapter.run({
        ...input({ env: { CURSOR_API_KEY: "key" } }),
        debugOutput: { onChunk: (stream, text) => chunks.push({ stream, text }) },
      });

      // Exact line sequence: assistant text verbatim, thinking steps never
      // render (universal reasoning drop), tool payloads reduce to bounded
      // name markers, user-flavored steps reduce to size markers, unknown
      // steps degrade to payload-free markers, and the adapter synthesizes a
      // terminal result marker after wait() resolves.
      expect(chunks).toEqual([
        { stream: "stdout", text: "checking the diff\n" },
        { stream: "stdout", text: "[tool_use read]\n" },
        { stream: "stdout", text: "[tool_use mcp:search-docs]\n" },
        { stream: "stdout", text: "[user message 8 chars]\n" },
        { stream: "stdout", text: "[somethingNew]\n" },
        { stream: "stdout", text: "cursor ok\n" },
        { stream: "stdout", text: "[result:finished duration_ms=12]\n" },
      ]);
      expect(JSON.stringify(chunks)).not.toContain(SENTINEL);
      expect(output.text).toBe("cursor ok");
      expect(output.metadata).toMatchObject({ debugOutputMode: "event-summary" });
    });

    it("produces an identical artifact with and without debug capture (non-authoritative debug invariant)", async () => {
      const adapter = createStepAdapter([]);

      const baseline = await adapter.run(input({ env: { CURSOR_API_KEY: "key" } }));
      const debugged = await adapter.run({
        ...input({ env: { CURSOR_API_KEY: "key" } }),
        debugOutput: { onChunk: () => {} },
      });

      expect(baseline.metadata).not.toHaveProperty("debugOutputMode");
      expect(debugged.metadata).toMatchObject({ debugOutputMode: "event-summary" });
      // Debug output is non-authoritative: removing its metadata key leaves
      // the artifacts deep-equal (debug_output itself is assembled by the
      // runner from the recorder, never by the adapter).
      expect(debugged).not.toHaveProperty("debug_output");
      const { debugOutputMode: _mode, ...debuggedMetadata } = debugged.metadata ?? {};
      expect({ ...debugged, metadata: debuggedMetadata }).toEqual(baseline);
    });

    it("keeps the artifact byte-identical without the debug opt-in", async () => {
      const adapter = createStepAdapter([]);

      const output = await adapter.run(input({ env: { CURSOR_API_KEY: "key" } }));

      // Full-artifact fixture: the flag-off run carries no debug traces at all.
      expect(output).toEqual({
        text: "cursor ok",
        metadata: {
          captureMode: "text",
          readonlyCapability: "tool-restricted",
          transport: "sdk",
          agentId: "agent-1",
          runId: "run-1",
          cursorMode: cursorReviewMode,
          cursorTools: ["read", "grep", "glob", "ls"],
          cursorAutoReview: cursorReviewAutoReview,
          cursorSandboxEnabled: cursorReviewSandboxOptions.enabled,
          cursorSettingSources: cursorReviewSettingSources,
          cursorMcpServers: [],
          cursorStore: "jsonl-ephemeral",
          model: "composer-2.5",
          requestedModel: "composer-2.5",
          resolvedModel: "composer-2.5",
          modelResolutionSource: "provider-result",
          durationMs: 12,
        },
      });
    });

    it("keeps the send invocation identical apart from the onStep observer", async () => {
      const sendCalls: RecordedSend[] = [];
      const adapter = createStepAdapter(sendCalls);

      await adapter.run(input({ env: { CURSOR_API_KEY: "key" } }));
      await adapter.run({
        ...input({ env: { CURSOR_API_KEY: "key" } }),
        debugOutput: { onChunk: () => {} },
      });

      // Flag-off keeps the exact `send(prompt)` invocation (no options
      // argument at all); the debug run adds only the onStep observer.
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls[0]?.options).toBeUndefined();
      expect(sendCalls[1]?.prompt).toBe(sendCalls[0]?.prompt);
      expect(Object.keys(sendCalls[1]?.options ?? {})).toEqual(["onStep"]);
    });

    it("does not fail the run when the debug callback throws", async () => {
      const adapter = createStepAdapter([]);

      const output = await adapter.run({
        ...input({ env: { CURSOR_API_KEY: "key" } }),
        debugOutput: {
          onChunk: () => {
            throw new Error("recorder failed");
          },
        },
      });

      expect(output.text).toBe("cursor ok");
      expect(output.metadata).toMatchObject({ debugOutputMode: "event-summary" });
    });

    it("still captures step summaries and the terminal marker when the run fails", async () => {
      const adapter = createStepAdapter([], { status: "error", result: "" });
      const chunks: Array<{ stream: "stdout" | "stderr"; text: string }> = [];

      await expect(
        adapter.run({
          ...input({ env: { CURSOR_API_KEY: "key" } }),
          debugOutput: { onChunk: (stream, text) => chunks.push({ stream, text }) },
        }),
      ).rejects.toMatchObject({
        code: "reviewer_failed",
        message: "Cursor reviewer finished with status: error",
      });

      // The throw path still flushed the captured steps and the synthesized
      // terminal marker (debug teardown lives in the adapter's finally).
      expect(chunks.map((chunk) => chunk.text)).toContain("[result:error duration_ms=12]\n");
      expect(chunks.map((chunk) => chunk.text)).toContain("checking the diff\n");
      expect(JSON.stringify(chunks)).not.toContain(SENTINEL);
    });
  });

  it("lists the model catalog through the SDK on the sdk transport", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          models: [
            { id: "composer-2.5", displayName: "Composer 2.5", description: "flagship" },
            { id: "sonnet-4.5" },
          ],
        });
      },
    });

    const models = await adapter.listModels?.({
      reviewer: { id: "cursor", sdk: "cursor", readonly: true },
      env: { CURSOR_API_KEY: "test-key" },
    });

    // No supportedEffortLevels and no default marking: effort lives in the model id and
    // neither listing surface exposes a default.
    expect(models).toEqual([
      { value: "composer-2.5", displayName: "Composer 2.5", description: "flagship" },
      { value: "sonnet-4.5" },
    ]);
  });

  it("classifies missing and rejected API keys into one actionable listModels sentence", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          async listModels() {
            const error = new Error("invalid API key");
            error.name = "AuthenticationError";
            throw error;
          },
        });
      },
    });

    await expect(
      adapter.listModels?.({
        reviewer: { id: "cursor", sdk: "cursor", readonly: true },
        env: {},
      }),
    ).rejects.toThrow("cursor is not authenticated — set CURSOR_API_KEY");

    await expect(
      adapter.listModels?.({
        reviewer: { id: "cursor", sdk: "cursor", readonly: true },
        env: { CURSOR_API_KEY: "bad-key" },
      }),
    ).rejects.toThrow("cursor is not authenticated — set CURSOR_API_KEY");
  });

  it("honors the abort signal while listing SDK models", async () => {
    const adapter = createCursorAdapter({
      async loadSdk() {
        return mockCursorSdk({
          listModels: () => new Promise(() => {}),
        });
      },
    });

    const controller = new AbortController();
    const listing = adapter.listModels?.({
      reviewer: { id: "cursor", sdk: "cursor", readonly: true },
      env: { CURSOR_API_KEY: "test-key" },
      signal: controller.signal,
    });
    controller.abort();
    // Either the race's message or the signal's own AbortError reason surfaces, depending on
    // where the abort lands; both reject promptly instead of waiting on the hung SDK call.
    await expect(listing).rejects.toThrow(/aborted/i);

    await expect(
      adapter.listModels?.({
        reviewer: { id: "cursor", sdk: "cursor", readonly: true },
        env: { CURSOR_API_KEY: "test-key" },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });

  it("parses cursor-agent models output into catalog entries", () => {
    const stdout = [
      "Available models:",
      "",
      "composer-2.5 - Composer 2.5",
      "gpt-5.6-sol - GPT-5.6 Sol",
      "not a model line",
    ].join("\n");
    expect(parseCursorCliModels(stdout)).toEqual([
      { value: "composer-2.5", displayName: "Composer 2.5" },
      { value: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    ]);
    expect(parseCursorCliModels("cursor-agent: not signed in")).toEqual([]);
  });

  it.skipIf(isIntegrationDisabled("cursor") || !process.env.CURSOR_API_KEY)(
    "runs a live Cursor local review smoke test",
    async () => {
      const fixture = createLiveFixture("diffwarden-live-cursor-sdk-");
      const reviewer = {
        id: "cursor",
        sdk: "cursor" as const,
        model: process.env.CURSOR_SMOKE_MODEL ?? "composer-2.5",
        readonly: true,
      };
      try {
        const preflight = await cursorAdapter.preflight?.({
          cwd: fixture.repo,
          reviewer,
          readonly: true,
          env: process.env,
        });
        const output = await cursorAdapter.run(
          await createLiveAdapterInput(fixture, reviewer, process.env),
        );

        expect(preflight?.metadata?.readonlyCapability).toBe("tool-restricted");
        expect(output.metadata?.captureMode).toBe("text");
        expect(output.metadata?.resolvedModel).toEqual(expect.any(String));
        expect(output.metadata?.modelResolutionSource).toBe("provider-result");
        expectLiveAdapterOutput(output);
        expectFixtureReadOnly(fixture.repo);
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );
});

type MockCursorRun = {
  id: string;
  cancel(): Promise<void>;
  wait(): Promise<{
    status: string;
    result: string;
    model?: ModelSelection;
    durationMs?: number;
    error?: RunError;
  }>;
};

type MockCursorSendOptions = {
  onStep?: (args: { step: unknown }) => void | Promise<void>;
};

type MockCursorAgent = {
  agentId: string;
  send(prompt: string, options?: MockCursorSendOptions): Promise<MockCursorRun>;
  [Symbol.asyncDispose](): Promise<void>;
};

function mockCursorSdk(options: {
  models?: Array<{ id: string; aliases?: string[]; displayName?: string; description?: string }>;
  listModels?: () => Promise<Array<{ id: string; aliases?: string[] }>>;
  createAgent?: (options: unknown) => Promise<MockCursorAgent>;
  createStore?: (rootDir: string) => void;
}) {
  return {
    Agent: {
      async create(createOptions: unknown) {
        if (options.createAgent === undefined) {
          throw new Error("Unexpected Cursor Agent.create call");
        }
        return options.createAgent(createOptions);
      },
    },
    JsonlLocalAgentStore: class MockCursorStore {
      rootDir: string;

      constructor(rootDir: string) {
        this.rootDir = rootDir;
        options.createStore?.(rootDir);
      }
    },
    Cursor: {
      models: {
        async list() {
          if (options.listModels !== undefined) {
            return options.listModels();
          }
          return options.models ?? [{ id: "composer-2.5" }];
        },
      },
    },
  };
}

function adapterWithResult(result: Awaited<ReturnType<MockCursorRun["wait"]>>) {
  return createCursorAdapter({
    async loadSdk() {
      return mockCursorSdk({
        async createAgent() {
          return {
            agentId: "agent-1",
            async send() {
              return {
                id: "run-1",
                async cancel() {},
                async wait() {
                  return result;
                },
              };
            },
            async [Symbol.asyncDispose]() {},
          };
        },
      });
    },
  });
}

function input(overrides: Partial<ReviewAdapterInput> = {}): ReviewAdapterInput {
  return {
    cwd: process.cwd(),
    reviewer: {
      id: "cursor",
      sdk: "cursor",
      model: "composer-2.5",
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
    env: process.env,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
