import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";

describe("claudeAdapter", () => {
  it("preflights auth before loading the SDK", async () => {
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
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("fails clearly when ANTHROPIC_API_KEY is missing", async () => {
    await expect(claudeAdapter.run(input({ env: {} }))).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it.skipIf(process.env.INTEGRATION_TEST_ON !== "1" || !process.env.ANTHROPIC_API_KEY)(
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
      expect(output.metadata?.captureMode).toBe("text");
      expect(typeof output.text).toBe("string");
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
