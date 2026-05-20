import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter, createClaudeAdapter } from "../src/adapters/claude.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";
import { parseReviewOutput } from "../src/core/parse.js";

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
          model: "claude-sonnet-4-6",
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
        model: "claude-sonnet-4-6",
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
          model: "claude-sonnet-4-6",
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
    const fakeBin = createFakeClaudeExecutable({ loggedIn: true });
    const preflight = await claudeAdapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "claude",
        sdk: "claude",
        model: "claude-sonnet-4-6",
        readonly: true,
      },
      readonly: true,
      env: {
        PATH: fakeBin,
      },
    });

    expect(preflight?.metadata?.authMode).toBe("claude-code");
    expect(preflight?.metadata?.executable).toBe("claude");
  });

  it("fails clearly when no Claude auth path is available", async () => {
    await expect(claudeAdapter.run(input({ env: { PATH: "" } }))).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
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
          model: "claude-sonnet-4-6",
          effort: "xhigh",
          readonly: true,
        },
      }),
    );

    expect(calls[0]?.options).toMatchObject({
      effort: "max",
    });
    expect(output.metadata).toMatchObject({
      effort: "max",
      requestedEffort: "xhigh",
    });
  });

  it.skipIf(process.env.INTEGRATION_TEST_ON !== "1")(
    "runs a live Claude local review smoke test",
    async () => {
      const preflight = await claudeAdapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "claude",
          sdk: "claude",
          model: "claude-sonnet-4-6",
          readonly: true,
        },
        readonly: true,
        env: process.env,
      });
      const output = await claudeAdapter.run(input({ env: process.env }));

      expect(preflight?.metadata?.readonlyCapability).toBe("enforced");
      expect(["api-key", "claude-code"]).toContain(preflight?.metadata?.authMode);
      expect(["native-structured", "text"]).toContain(output.metadata?.captureMode);

      const parsed =
        output.structured !== undefined
          ? parseReviewOutput({ structured: output.structured })
          : parseReviewOutput({ text: output.text ?? "" });

      expect(parsed.validation.valid_schema).toBe(true);
      expect(parsed.result).toMatchObject({
        findings: expect.any(Array),
        overall_correctness: expect.any(String),
        overall_explanation: expect.any(String),
        overall_confidence_score: expect.any(Number),
      });
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
  prompt: string;
  options?: {
    outputFormat?: unknown;
    [key: string]: unknown;
  };
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
      return { authMode: "api-key" };
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
      model: "claude-sonnet-4-6",
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
echo '2.1.143 (Claude Code)'
`,
  );
  chmodSync(executable, 0o755);
  return tempDir;
}
