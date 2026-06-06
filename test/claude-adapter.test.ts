import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeDisallowedTools,
  claudeReviewTools,
  claudeSdkReviewPolicyCliFlags,
} from "../src/adapters/claude-tool-policy.js";
import {
  claudeAdapter,
  createClaudeAdapter,
  resolveClaudeRuntime,
} from "../src/adapters/claude.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";
import { isIntegrationDisabled } from "./integration.js";
import {
  createLiveAdapterInput,
  createLiveFixture,
  expectFixtureReadOnly,
  expectLiveAdapterOutput,
} from "./live/helpers.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { force: true, recursive: true });
    tempDir = undefined;
  }
});

describe("claudeAdapter", () => {
  it("fails preflight clearly when API key and Claude Code executable are missing", async () => {
    await expect(
      claudeAdapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "sonnet",
          readonly: true,
        },
        readonly: true,
        env: { PATH: "" },
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("preflights API key auth without requiring a Claude Code executable", async () => {
    const preflight = await claudeAdapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "claude",
        sdk: "claude",
        model: "sonnet",
        readonly: true,
      },
      readonly: true,
      env: {
        ANTHROPIC_API_KEY: "test-key",
        PATH: "",
      },
    });

    expect(preflight?.metadata?.authMode).toBe("api-key");
  });

  it("rejects a Claude Code executable that is not authenticated", async () => {
    const fakeBin = createFakeClaudeExecutable({ loggedIn: false });

    await expect(
      claudeAdapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "sonnet",
          readonly: true,
        },
        readonly: true,
        env: {
          PATH: fakeBin,
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("preflights Claude Code auth without requiring an API key", async () => {
    const { adapter } = createMockClaudePreflightAdapter([{ value: "sonnet" }], {
      authMode: "claude-code",
      authPreference: "auto",
      executable: "claude",
      env: { PATH: "" },
    });

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "claude",
        sdk: "claude",
        model: "sonnet",
        readonly: true,
      },
      readonly: true,
      env: {
        PATH: "",
      },
    });

    expect(preflight?.metadata?.authMode).toBe("claude-code");
    expect(preflight?.metadata?.executable).toBe("claude");
  });

  it("prefers Claude Code subscription auth over ANTHROPIC_API_KEY in auto mode", async () => {
    const fakeBin = createEnvSensitiveFakeClaudeExecutable();
    const { adapter, calls } = createMockClaudePreflightAdapterWithRuntime([{ value: "sonnet" }]);

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "claude",
        sdk: "claude",
        model: "sonnet",
        readonly: true,
      },
      readonly: true,
      env: {
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_AUTH_TOKEN: "test-token",
        PATH: fakeBin,
      },
    });

    expect(preflight?.metadata).toMatchObject({
      authMode: "claude-code",
      authPreference: "auto",
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "max",
      executable: "claude",
    });
    expect(calls[0]?.options?.pathToClaudeCodeExecutable).toBe("claude");
    expect(calls[0]?.options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(calls[0]?.options?.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("falls back to API key auth in auto mode when Claude Code lacks policy flags", async () => {
    const fakeBin = createEnvSensitiveFakeClaudeExecutable({ policyFlags: false });
    const { adapter, calls } = createMockClaudePreflightAdapterWithRuntime([{ value: "sonnet" }]);

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "claude",
        sdk: "claude",
        model: "sonnet",
        readonly: true,
      },
      readonly: true,
      env: {
        ANTHROPIC_API_KEY: "test-key",
        PATH: fakeBin,
      },
    });

    expect(preflight?.metadata).toMatchObject({
      authMode: "api-key",
      authPreference: "auto",
    });
    expect(calls[0]?.options?.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("fails forced Claude Code auth when Claude Code lacks policy flags", async () => {
    const fakeBin = createEnvSensitiveFakeClaudeExecutable({ policyFlags: false });

    await expect(
      claudeAdapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "sonnet",
          readonly: true,
          sdkOptions: { authMode: "claude-code" },
        },
        readonly: true,
        env: {
          PATH: fakeBin,
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--allowedTools"),
    });
  });

  it("can force Claude API key auth when Claude Code auth is available", async () => {
    const fakeBin = createEnvSensitiveFakeClaudeExecutable();
    const { adapter, calls } = createMockClaudePreflightAdapterWithRuntime([{ value: "sonnet" }]);

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "claude-api-key",
        sdk: "claude",
        model: "sonnet",
        readonly: true,
        sdkOptions: { authMode: "api-key" },
      },
      readonly: true,
      env: {
        ANTHROPIC_API_KEY: "test-key",
        PATH: fakeBin,
      },
    });

    expect(preflight?.metadata).toMatchObject({
      authMode: "api-key",
      authPreference: "api-key",
    });
    expect(calls[0]?.options?.pathToClaudeCodeExecutable).toBeUndefined();
    expect(calls[0]?.options?.env).toMatchObject({ ANTHROPIC_API_KEY: "test-key" });
  });

  it("falls back to process env auth when adapter env is omitted", async () => {
    const fakeBin = createFakeClaudeExecutable({ loggedIn: false });
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "process-test-key";
    try {
      const runtime = await resolveClaudeRuntime(
        {
          reviewer: {
            id: "claude",
            sdk: "claude",
            model: "sonnet",
            readonly: true,
          },
        },
        path.join(fakeBin, "claude"),
      );

      expect(runtime).toMatchObject({
        authMode: "api-key",
        authPreference: "auto",
      });
    } finally {
      if (originalApiKey === undefined) {
        Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      } else {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
    }
  });

  it("preflights Claude model availability through the SDK model catalog", async () => {
    const { adapter, calls, closeCalls } = createMockClaudePreflightAdapter([
      {
        value: "sonnet",
        displayName: "Sonnet",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"],
      },
    ]);
    const abortController = new AbortController();

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "claude",
        sdk: "claude",
        model: "sonnet",
        effort: "xhigh",
        effortSource: "config",
        readonly: true,
      },
      readonly: true,
      signal: abortController.signal,
      env: { ANTHROPIC_API_KEY: "test-key" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      cwd: process.cwd(),
      tools: [...claudeReviewTools],
      allowedTools: [...claudeReviewTools],
      disallowedTools: [...claudeDisallowedTools],
      permissionMode: "dontAsk",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
    });
    expect(calls[0]?.options).not.toHaveProperty("maxTurns");
    expect(preflight?.checks.find((check) => check.name === "model")).toMatchObject({
      status: "passed",
      detail: "Claude model is available: sonnet.",
    });
    expect(preflight?.metadata).toMatchObject({
      model: "sonnet",
      requestedModel: "sonnet",
      resolvedModel: "sonnet",
      modelResolutionSource: "requested",
      modelDisplayName: "Sonnet",
      effort: "max",
      requestedEffort: "xhigh",
      resolvedEffort: "max",
      effortResolutionSource: "adapter-selection",
      supportedEffortLevels: ["low", "medium", "high", "max"],
    });
    expect(calls[0]?.options?.abortController).toBeInstanceOf(AbortController);
    expect(closeCalls()).toBe(1);
  });

  it("rejects unavailable Claude models during preflight", async () => {
    const { adapter, closeCalls } = createMockClaudePreflightAdapter([
      {
        value: "sonnet",
      },
    ]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "opus",
          readonly: true,
        },
        readonly: true,
        env: { ANTHROPIC_API_KEY: "test-key" },
      }),
    ).rejects.toMatchObject({
      code: "invalid_model",
      exitCode: 2,
    });
    expect(closeCalls()).toBe(1);
  });

  it("rejects Claude efforts that the selected model does not support", async () => {
    const { adapter, closeCalls } = createMockClaudePreflightAdapter([
      {
        value: "sonnet",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
    ]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "sonnet",
          effort: "xhigh",
          readonly: true,
        },
        readonly: true,
        env: { ANTHROPIC_API_KEY: "test-key" },
      }),
    ).rejects.toMatchObject({
      code: "invalid_effort",
      exitCode: 2,
    });
    expect(closeCalls()).toBe(1);
  });

  it("rejects Claude efforts when the selected model omits effort capability metadata", async () => {
    const { adapter, closeCalls } = createMockClaudePreflightAdapter([
      {
        value: "haiku",
      },
    ]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "haiku",
          effort: "high",
          readonly: true,
        },
        readonly: true,
        env: { ANTHROPIC_API_KEY: "test-key" },
      }),
    ).rejects.toMatchObject({
      code: "invalid_effort",
      exitCode: 2,
    });
    expect(closeCalls()).toBe(1);
  });

  it("fails clearly when no Claude auth path is available", async () => {
    await expect(claudeAdapter.run(input({ env: { PATH: "" } }))).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("runs Claude Code auth with API credentials removed from the SDK environment", async () => {
    const { adapter, calls } = createMockClaudeRuntimeAdapter(
      {
        authMode: "claude-code",
        authPreference: "auto",
        executable: "claude",
        env: { PATH: "/fake/bin" },
        subscriptionType: "max",
      },
      [
        {
          type: "result",
          subtype: "success",
          structured_output: validReview(),
          duration_ms: 12,
          session_id: "structured-session",
        },
      ],
    );

    const output = await adapter.run(
      input({
        env: {
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_AUTH_TOKEN: "test-token",
          PATH: "/fake/bin",
        },
      }),
    );

    expect(calls[0]?.options?.pathToClaudeCodeExecutable).toBe("claude");
    expect(calls[0]?.options?.env).toEqual({ PATH: "/fake/bin" });
    expect(output.metadata).toMatchObject({
      authMode: "claude-code",
      authPreference: "auto",
      subscriptionType: "max",
    });
  });

  it("falls back to text when native structured output fails local schema validation", async () => {
    const { adapter, calls } = createMockClaudeAdapter([
      {
        type: "result",
        subtype: "success",
        structured_output: {
          findings: [
            {
              title: "Bad range",
              body: "The native result is malformed.",
              confidence_score: 0.9,
              code_location: {
                absolute_file_path: "/tmp/file.ts",
                line_range: {
                  start: 5,
                  end: 1,
                },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "Malformed location.",
          overall_confidence_score: 0.8,
        },
        duration_ms: 12,
        total_cost_usd: 0.1,
        session_id: "structured-session",
      },
      {
        type: "result",
        subtype: "success",
        result: validReviewText(),
        duration_ms: 20,
        total_cost_usd: 0.2,
        session_id: "text-session",
      },
    ]);

    const output = await adapter.run(input({ env: { ANTHROPIC_API_KEY: "test-key" } }));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.outputFormat).toMatchObject({ type: "json_schema" });
    expect(calls[1]?.options?.outputFormat).toBeUndefined();
    expect(output.structured).toBeUndefined();
    expect(output.text).toBe(validReviewText());
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      fallbackReason: "invalid_structured_output",
      sessionId: "text-session",
      durationMs: 32,
      authMode: "api-key",
    });
    expect(output.metadata?.totalCostUsd).toBeCloseTo(0.3);
  });

  it("falls back to text when Claude reaches structured output retry limits", async () => {
    const { adapter, calls } = createMockClaudeAdapter([
      {
        type: "result",
        subtype: "error_max_structured_output_retries",
        duration_ms: 15,
        total_cost_usd: 0.15,
        session_id: "structured-session",
      },
      {
        type: "result",
        subtype: "success",
        result: validReviewText(),
        duration_ms: 25,
        total_cost_usd: 0.25,
        session_id: "text-session",
      },
    ]);

    const output = await adapter.run(input({ env: { ANTHROPIC_API_KEY: "test-key" } }));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.outputFormat).toMatchObject({ type: "json_schema" });
    expect(calls[1]?.options?.outputFormat).toBeUndefined();
    expect(output.text).toBe(validReviewText());
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      fallbackReason: "error_max_structured_output_retries",
      durationMs: 40,
    });
    expect(output.metadata?.totalCostUsd).toBeCloseTo(0.4);
  });

  it("maps public effort to Claude query options and metadata", async () => {
    const { adapter, calls } = createMockClaudeAdapter([
      {
        type: "result",
        subtype: "success",
        structured_output: validReview(),
        duration_ms: 12,
        total_cost_usd: 0.1,
        session_id: "structured-session",
      },
    ]);

    const output = await adapter.run(
      input({
        env: { ANTHROPIC_API_KEY: "test-key" },
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "sonnet",
          effort: "xhigh",
          readonly: true,
        },
      }),
    );

    expect(calls[0]?.options).toMatchObject({
      tools: [...claudeReviewTools],
      allowedTools: [...claudeReviewTools],
      disallowedTools: [...claudeDisallowedTools],
      permissionMode: "dontAsk",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      effort: "max",
    });
    expect(calls[0]?.options).not.toHaveProperty("maxTurns");
    expect(output.metadata).toMatchObject({
      effort: "max",
      requestedEffort: "xhigh",
      resolvedEffort: "max",
      effortResolutionSource: "adapter-selection",
      requestedModel: "sonnet",
      resolvedModel: "sonnet",
      modelResolutionSource: "requested",
    });
  });

  it.skipIf(isIntegrationDisabled("claude"))(
    "runs a live Claude local review smoke test",
    async () => {
      const fixture = createLiveFixture("diffwarden-live-claude-sdk-");
      const reviewer = {
        id: "claude",
        sdk: "claude" as const,
        model: process.env.CLAUDE_SMOKE_MODEL ?? "sonnet",
        readonly: true,
      };
      try {
        const preflight = await claudeAdapter.preflight?.({
          cwd: fixture.repo,
          reviewer,
          readonly: true,
          env: process.env,
        });
        const output = await claudeAdapter.run(
          await createLiveAdapterInput(fixture, reviewer, process.env),
        );

        expect(preflight?.metadata?.readonlyCapability).toBe("tool-restricted");
        expect(["api-key", "claude-code"]).toContain(preflight?.metadata?.authMode);
        expect(["native-structured", "text"]).toContain(output.metadata?.captureMode);
        expectLiveAdapterOutput(output);
        expectFixtureReadOnly(fixture.repo);
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );
});

type MockClaudeResult = {
  type: "result";
  subtype: string;
  result?: string;
  structured_output?: unknown;
  duration_ms?: number;
  total_cost_usd?: number;
  session_id?: string;
};

type MockClaudeQueryCall = {
  prompt: string | AsyncIterable<unknown>;
  options?: {
    outputFormat?: unknown;
    [key: string]: unknown;
  };
};

type MockClaudeModel = {
  value: string;
  displayName?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

function createMockClaudeAdapter(results: MockClaudeResult[]) {
  const pendingResults = [...results];
  const calls: MockClaudeQueryCall[] = [];
  const query = async function* (params: MockClaudeQueryCall) {
    calls.push(params);
    const result = pendingResults.shift();
    if (result !== undefined) {
      yield result;
    }
  };

  const adapter = createClaudeAdapter({
    async loadSdk() {
      return { query };
    },
    async resolveRuntime() {
      return { authMode: "api-key", authPreference: "auto" };
    },
  });

  return { adapter, calls };
}

function createMockClaudePreflightAdapter(
  models: MockClaudeModel[],
  runtime:
    | { authMode: "api-key"; authPreference: "auto" | "api-key" | "claude-code" }
    | {
        authMode: "claude-code";
        authPreference: "auto" | "api-key" | "claude-code";
        executable: string;
        env: NodeJS.ProcessEnv;
        subscriptionType?: string;
      } = {
    authMode: "api-key",
    authPreference: "auto",
  },
) {
  const calls: MockClaudeQueryCall[] = [];
  let closed = 0;
  const query = (params: MockClaudeQueryCall) => {
    calls.push(params);
    return {
      async *[Symbol.asyncIterator]() {},
      async supportedModels() {
        return models;
      },
      close() {
        closed += 1;
      },
    };
  };

  const adapter = createClaudeAdapter({
    async loadSdk() {
      return { query };
    },
    async resolveRuntime() {
      return runtime;
    },
  });

  return { adapter, calls, closeCalls: () => closed };
}

function createMockClaudePreflightAdapterWithRuntime(models: MockClaudeModel[]) {
  const calls: MockClaudeQueryCall[] = [];
  let closed = 0;
  const query = (params: MockClaudeQueryCall) => {
    calls.push(params);
    return {
      async *[Symbol.asyncIterator]() {},
      async supportedModels() {
        return models;
      },
      close() {
        closed += 1;
      },
    };
  };

  const adapter = createClaudeAdapter({
    async loadSdk() {
      return { query };
    },
    resolveRuntime: resolveClaudeRuntime,
  });

  return { adapter, calls, closeCalls: () => closed };
}

function createMockClaudeRuntimeAdapter(
  runtime:
    | { authMode: "api-key"; authPreference: "auto" | "api-key" | "claude-code" }
    | {
        authMode: "claude-code";
        authPreference: "auto" | "api-key" | "claude-code";
        executable: string;
        env: NodeJS.ProcessEnv;
        subscriptionType?: string;
      },
  results: MockClaudeResult[],
) {
  const pendingResults = [...results];
  const calls: MockClaudeQueryCall[] = [];
  const query = async function* (params: MockClaudeQueryCall) {
    calls.push(params);
    const result = pendingResults.shift();
    if (result !== undefined) {
      yield result;
    }
  };

  const adapter = createClaudeAdapter({
    async loadSdk() {
      return { query };
    },
    async resolveRuntime() {
      return runtime;
    },
  });

  return { adapter, calls };
}

function validReviewText(): string {
  return JSON.stringify({
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "No findings.",
    overall_confidence_score: 0.91,
  });
}

function validReview() {
  return {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "No findings.",
    overall_confidence_score: 0.91,
  };
}

function input(overrides: Partial<ReviewAdapterInput> = {}): ReviewAdapterInput {
  return {
    cwd: process.cwd(),
    reviewer: {
      id: "claude",
      sdk: "claude",
      model: "sonnet",
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
    env: overrides.env ?? process.env,
    ...overrides,
  };
}

function createFakeClaudeExecutable(options: { loggedIn: boolean }): string {
  tempDir = mkdtempSync(path.join(tmpdir(), "diffwarden-claude-"));
  const executable = path.join(tempDir, "claude");
  writeFileSync(
    executable,
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":${options.loggedIn ? "true" : "false"}}'
  exit 0
fi
if [ "$1" = "--help" ]; then
  echo '${claudeSdkReviewPolicyCliFlags.join(" ")}'
  exit 0
fi
echo '2.1.143 (Claude Code)'
`,
  );
  chmodSync(executable, 0o755);
  return tempDir;
}

function createEnvSensitiveFakeClaudeExecutable(options: { policyFlags?: boolean } = {}): string {
  tempDir = mkdtempSync(path.join(tmpdir(), "diffwarden-claude-"));
  const executable = path.join(tempDir, "claude");
  writeFileSync(
    executable,
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}'
  else
    echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'
  fi
  exit 0
fi
if [ "$1" = "--help" ]; then
  echo '${options.policyFlags === false ? "--tools --disallowedTools --permission-mode" : claudeSdkReviewPolicyCliFlags.join(" ")}'
  exit 0
fi
echo '2.1.143 (Claude Code)'
`,
  );
  chmodSync(executable, 0o755);
  return tempDir;
}
