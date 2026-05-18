import { describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";

describe("cursorAdapter", () => {
  it("preflights auth before loading the SDK", async () => {
    await expect(
      cursorAdapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "cursor",
          sdk: "cursor",
          model: "composer-2",
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

  it.skipIf(process.env.INTEGRATION_TEST_ON !== "1" || !process.env.CURSOR_API_KEY)(
    "runs a live Cursor local review smoke test",
    async () => {
      const preflight = await cursorAdapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "cursor",
          sdk: "cursor",
          model: "composer-2",
          readonly: true,
        },
        readonly: true,
        env: process.env,
      });
      const output = await cursorAdapter.run(input({ env: process.env }));

      expect(preflight?.metadata?.readonlyCapability).toBe("prompt-only");
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
      id: "cursor",
      sdk: "cursor",
      model: "composer-2",
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
