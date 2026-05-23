import { describe, expect, it } from "vitest";
import { createCursorAdapter, cursorAdapter } from "../src/adapters/cursor.js";
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
                      model: "composer-2.5",
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
      effort: "ignored",
    });
    expect(output.metadata).toMatchObject({
      requestedEffort: "high",
      effort: "ignored",
    });
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

        expect(preflight?.metadata?.readonlyCapability).toBe("prompt-only");
        expect(output.metadata?.captureMode).toBe("text");
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
  }>;
};

type MockCursorAgent = {
  agentId: string;
  send(prompt: string): Promise<MockCursorRun>;
  [Symbol.asyncDispose](): Promise<void>;
};

function mockCursorSdk(options: {
  models?: Array<{ id: string; aliases?: string[] }>;
  listModels?: () => Promise<Array<{ id: string; aliases?: string[] }>>;
  createAgent?: () => Promise<MockCursorAgent>;
}) {
  return {
    Agent: {
      async create() {
        if (options.createAgent === undefined) {
          throw new Error("Unexpected Cursor Agent.create call");
        }
        return options.createAgent();
      },
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
