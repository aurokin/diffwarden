import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
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

function input(overrides: { env?: NodeJS.ProcessEnv } = {}): ReviewAdapterInput {
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
