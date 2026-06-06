import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliSpecs } from "../src/adapters/cli-specs.js";
import type { CliRunResult } from "../src/adapters/cli-types.js";
import {
  piCliAmbientDisableArgs,
  piCliReviewSurfaceArgs,
  piReadOnlyTools,
  piReviewOutputToolName,
  piSdkReviewTools,
} from "../src/adapters/pi-tool-policy.js";
import { createPiAdapter } from "../src/adapters/pi.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";
import { reviewResultJsonSchema } from "../src/core/schema.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("Pi SDK versus Pi CLI comparison", () => {
  it("defines the exact Pi review tool policy", () => {
    expect(piReadOnlyTools).toEqual(["read", "grep", "find", "ls"]);
    expect(piReviewOutputToolName).toBe("review_output");
    expect(piSdkReviewTools).toEqual(["read", "grep", "find", "ls", "review_output"]);
    expect(piCliAmbientDisableArgs).toEqual([
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ]);
    expect(piCliReviewSurfaceArgs).toEqual([
      "--no-session",
      "--tools",
      "read,grep,find,ls",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ]);
  });

  it("keeps the credential-free comparison surface explicit", async () => {
    const review = validReview();
    const reviewModel = { provider: "test", id: "test-model" };
    const { adapter, calls } = createMockPiAdapter([reviewModel], {
      async prompt({ prompt, tool }) {
        expect(prompt).toBe("Return a minimal review result.");
        await tool.execute("tool-call-1", review);
      },
    });

    const sdkOutput = await adapter.run(input({ reviewer: createReviewer({ transport: "sdk" }) }));

    expect(sdkOutput.structured).toEqual(review);
    expect(sdkOutput.metadata).toMatchObject({
      captureMode: "tool-call",
      readonlyCapability: "tool-restricted",
      model: "test/test-model",
      resolvedModel: "test/test-model",
      modelResolutionSource: "adapter-selection",
    });
    expect(calls.createAgentSession).toHaveLength(1);
    expect(calls.createAgentSession[0]?.tools).toEqual([...piSdkReviewTools]);
    expect(calls.createAgentSession[0]?.customTools).toHaveLength(1);
    expect(calls.createAgentSession[0]?.customTools.map((tool) => tool.name)).toEqual([
      piReviewOutputToolName,
    ]);
    expect(calls.createAgentSession[0]?.customTools[0]?.parameters).toBe(reviewResultJsonSchema);

    const cliReviewer = createReviewer({
      transport: "cli",
      provider: "openai-codex",
      model: "gpt-5.5",
      effort: "high",
    });
    const invocation = await cliSpecs.pi.buildInvocation(
      input({ reviewer: cliReviewer }),
      tempDir(),
    );

    expect(invocation).toMatchObject({
      executable: "pi",
      stdin: "Return a minimal review result.",
      captureMode: "text",
    });
    expect(invocation.args).toEqual([
      "--print",
      "--mode",
      "json",
      ...piCliReviewSurfaceArgs,
      "--model",
      "openai-codex/gpt-5.5",
      "--thinking",
      "high",
    ]);

    const cliOutput = await cliSpecs.pi.parseOutput(
      runResult({
        stdout: [
          JSON.stringify({
            type: "session",
            version: 3,
            cwd: "/tmp/probe",
          }),
          JSON.stringify({
            type: "message_start",
            message: {
              role: "assistant",
              content: [],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.5",
            },
          }),
          JSON.stringify({ type: "message", message: { role: "toolResult", content: "skip" } }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: "first" } }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: "second" } }),
        ].join("\n"),
      }),
      invocation,
    );

    expect(cliOutput).toMatchObject({
      text: "first\nsecond",
      metadata: {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        resolvedModel: "gpt-5.5",
        modelResolutionSource: "provider-result",
      },
    });
    expect(cliOutput.metadata).not.toHaveProperty("resolvedEffort");
  });
});

type MockPiPromptHandler = (input: {
  prompt: string;
  model: unknown;
  tool: {
    execute(toolCallId: string, params: unknown): Promise<unknown>;
  };
}) => Promise<void>;

type MockPiModel = {
  provider?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
  >;
};

type MockPiSettingsManager = {
  getRetrySettings(): {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
  };
  getProviderRetrySettings(): {
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs: number;
  };
  getCompactionSettings(): {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
  getHttpIdleTimeoutMs(): number;
};

function createMockPiAdapter(
  availableModels: MockPiModel[],
  options: { prompt?: MockPiPromptHandler } = {},
) {
  const authStorage = createMockPiAuthStorage();
  const modelRegistry = {
    getAvailable() {
      return availableModels;
    },
    registerProvider() {},
  };
  const settingsManager = createMockPiSettingsManager();
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
      settingsManager: unknown;
      authStorage: unknown;
      modelRegistry: unknown;
    }>;
  } = {
    createAgentSession: [],
  };

  const adapter = createPiAdapter({
    async loadSdk() {
      return {
        AuthStorage: {
          inMemory() {
            return authStorage;
          },
        },
        ModelRegistry: {
          inMemory() {
            return modelRegistry;
          },
        },
        SessionManager: {
          inMemory(cwd?: string) {
            return { cwd };
          },
        },
        SettingsManager: {
          inMemory() {
            return settingsManager;
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

  return { adapter, calls };
}

function createMockPiAuthStorage() {
  return {
    setRuntimeApiKey() {},
    getRuntimeApiKey() {
      return undefined;
    },
  };
}

function createMockPiSettingsManager(): MockPiSettingsManager {
  return {
    getRetrySettings() {
      return {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2000,
      };
    },
    getProviderRetrySettings() {
      return {
        maxRetryDelayMs: 60_000,
      };
    },
    getCompactionSettings() {
      return {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      };
    },
    getHttpIdleTimeoutMs() {
      return 300_000;
    },
  };
}

function createReviewer(overrides: Partial<ReviewReviewerConfig> = {}): ReviewReviewerConfig {
  return {
    id: "pi-comparison",
    sdk: "pi",
    readonly: true,
    ...overrides,
  };
}

function input(overrides: Partial<ReviewAdapterInput> = {}): ReviewAdapterInput {
  return {
    cwd: process.cwd(),
    reviewer: createReviewer(),
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

function runResult(overrides: Partial<CliRunResult> = {}): CliRunResult {
  return {
    executable: "pi",
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "diffwarden-pi-comparison-"));
  tempDirs.push(directory);
  return directory;
}

function validReview() {
  return {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "No findings.",
    overall_confidence_score: 0.9,
  };
}
