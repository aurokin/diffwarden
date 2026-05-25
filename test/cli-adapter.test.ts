import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliAdapter } from "../src/adapters/cli.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";

type CliEngine = Exclude<ReviewReviewerConfig["sdk"], "fake">;

let root: string | undefined;

afterEach(() => {
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

describe("createCliAdapter", () => {
  it("runs Codex CLI through a read-only exec invocation and reads the structured output file", async () => {
    const harness = createHarness("codex");
    const adapter = createCliAdapter("codex");
    const reviewer = createReviewer("codex", harness.executable, {
      model: "gpt-test",
      effort: "high",
    });

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const output = await adapter.run(createInput(reviewer, harness));
    const invocation = harness.readInvocation();

    expect(preflight?.metadata?.readonlyCapability).toBe("enforced");
    expect(preflight?.metadata).toMatchObject({
      model: "gpt-test",
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      modelResolutionSource: "requested",
      effort: "high",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "requested",
    });
    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex ok",
    });
    expect(output.metadata).toMatchObject({
      captureMode: "native-structured",
      model: "gpt-test",
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      modelResolutionSource: "requested",
      effort: "high",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "requested",
    });
    expect(invocation.args).toContain("--model");
    expect(invocation.args).toContain("gpt-test");
    expect(invocation.args).toContain('model_reasoning_effort="high"');
    expect(invocation.args).toContain("exec");
    expect(invocation.args).toContain("--sandbox");
    expect(invocation.args).toContain("read-only");
    expect(invocation.stdin).toBe("review prompt");
  });

  it.each([
    ["claude", "tool-restricted"],
    ["cursor", "prompt-only"],
    ["gemini", "tool-restricted"],
    ["droid", "enforced"],
    ["grok", "prompt-only"],
    ["antigravity", "prompt-only"],
  ] as const)("runs %s CLI and normalizes its text output", async (engine, readonlyCapability) => {
    const harness = createHarness(engine);
    const adapter = createCliAdapter(engine);
    const reviewer = createReviewer(
      engine,
      harness.executable,
      engine === "antigravity" ? {} : { model: "test-model" },
    );

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const output = await adapter.run(createInput(reviewer, harness));
    const invocation = harness.readInvocation();

    expect(preflight?.metadata?.readonlyCapability).toBe(readonlyCapability);
    if (engine !== "antigravity") {
      expect(preflight?.metadata).toMatchObject({
        model: "test-model",
        requestedModel: "test-model",
        resolvedModel: "test-model",
        modelResolutionSource: "requested",
      });
    }
    if (engine === "claude") {
      expect(output.structured).toMatchObject({
        overall_explanation: "claude ok",
      });
    } else {
      expect(output.text).toContain(`${engine} text`);
      expect(output.metadata?.captureMode).toBe("text");
    }
    if (engine === "cursor") {
      expect(invocation.args).toContain("--trust");
      expect(invocation.args.join(" ")).toContain("review prompt");
    } else {
      expect(invocation.args.join(" ")).not.toContain("review prompt");
    }
    if (engine !== "antigravity") {
      expect(invocation.args.join(" ")).toContain("test-model");
      expect(output.metadata).toMatchObject({
        model: "test-model",
        requestedModel: "test-model",
        resolvedModel: "test-model",
        modelResolutionSource: "requested",
      });
    }
    if (engine === "droid") {
      expect(invocation.args).toContain("exec");
      expect(invocation.args).toContain("--cwd");
      expect(invocation.args).toContain(harness.cwd);
      expect(invocation.args).toContain("--use-spec");
      expect(invocation.args).toContain("--file");
      expect(invocation.args).not.toContain("--auto");
      expect(JSON.parse(invocation.args[invocation.args.indexOf("--tag") + 1] ?? "{}")).toEqual({
        name: "diffwarden",
        metadata: {
          reviewer: "droid",
          target: "custom",
          transport: "cli",
        },
      });
      expect(invocation.stdin).toBe("");
    } else if (engine === "grok") {
      expect(invocation.args).toContain("--prompt-file");
      expect(invocation.stdin).toBe("");
    } else if (engine === "cursor") {
      expect(invocation.stdin).toBe("");
    } else if (engine === "claude") {
      expect(invocation.args).toContain("--setting-sources");
      expect(
        invocation.args.slice(
          invocation.args.indexOf("--setting-sources"),
          invocation.args.indexOf("--setting-sources") + 2,
        ),
      ).toEqual(["--setting-sources", ""]);
      expect(invocation.args).toContain("--strict-mcp-config");
      expect(invocation.args).toContain("--disable-slash-commands");
      expect(invocation.stdin).toBe("review prompt");
    } else {
      expect(invocation.stdin).toBe("review prompt");
    }
  });

  it("prefers Claude Code auth for Claude CLI runs and strips API credentials", async () => {
    const harness = createHarness("claude");
    const adapter = createCliAdapter("claude");
    const reviewer = createReviewer("claude", harness.executable, { model: "test-model" });

    await adapter.run({
      ...createInput(reviewer, harness),
      env: {
        ...harness.env,
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_AUTH_TOKEN: "test-token",
      },
    });
    const invocation = harness.readInvocation();

    expect(invocation.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(invocation.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("can force Claude API key auth for Claude CLI runs", async () => {
    const harness = createHarness("claude");
    const adapter = createCliAdapter("claude");
    const reviewer = createReviewer("claude", harness.executable, {
      model: "test-model",
      sdkOptions: { authMode: "api-key" },
    });

    await adapter.run({
      ...createInput(reviewer, harness),
      env: {
        ...harness.env,
        ANTHROPIC_API_KEY: "test-key",
      },
    });
    const invocation = harness.readInvocation();

    expect(invocation.env).toMatchObject({ ANTHROPIC_API_KEY: "test-key" });
  });

  it.each([
    ["opencode", "prompt-only"],
    ["pi", "tool-restricted"],
  ] as const)(
    "collects %s JSONL text and applies read-only CLI controls",
    async (engine, readonlyCapability) => {
      const harness = createHarness(engine);
      const adapter = createCliAdapter(engine);
      const reviewer = createReviewer(engine, harness.executable, {
        provider: "provider",
        model: "model",
        effort: "high",
      });

      const output = await adapter.run(createInput(reviewer, harness));
      const invocation = harness.readInvocation();

      expect(output.text).toBe(`${engine} first\n${engine} second`);
      expect(output.metadata?.readonlyCapability).toBe(readonlyCapability);
      expect(output.metadata).toMatchObject({
        model: "model",
        requestedModel: "provider/model",
        resolvedModel: "provider/model",
        modelResolutionSource: "requested",
        effort: "high",
        requestedEffort: "high",
        resolvedEffort: "high",
        effortResolutionSource: "requested",
      });
      expect(invocation.args.join(" ")).toContain("provider/model");
      if (engine === "opencode") {
        expect(invocation.args).toContain("--pure");
        expect(invocation.args.join(" ")).toContain("review prompt");
        expect(invocation.stdin).toBe("");
        expect(JSON.parse(invocation.env.OPENCODE_PERMISSION ?? "")).toMatchObject({
          "*": "deny",
          read: "allow",
          edit: "deny",
          bash: "deny",
        });
      } else {
        expect(invocation.stdin).toBe("review prompt");
        expect(invocation.args).toContain("--tools");
        expect(invocation.args).toContain("read,grep,find,ls");
        expect(invocation.args).toContain("--thinking");
        expect(invocation.args).toContain("high");
      }
    },
  );

  it("fails preflight when the configured executable is missing", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-cli-adapter-"));
    const adapter = createCliAdapter("gemini");
    const missing = path.join(root, "missing-gemini");

    await expect(
      adapter.preflight?.({
        cwd: root,
        reviewer: createReviewer("gemini", missing),
        readonly: true,
        env: { PATH: "" },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("CLI executable not found"),
    });
  });

  it("does not use process PATH when preflight receives an isolated env", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", "gemini");

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: "CLI executable not found: gemini",
    });
  });

  it("spawns the same executable path that preflight resolves from PATH", async () => {
    const harness = createHarness("gemini");
    const safeBin = path.join(harness.cwd, "safe-bin");
    mkdirSync(safeBin);
    const safeExecutable = path.join(safeBin, "gemini");
    writeFileSync(safeExecutable, fakeCliScript("gemini"), "utf8");
    chmodSync(safeExecutable, 0o755);
    writeFileSync(
      path.join(harness.cwd, "gemini"),
      "#!/bin/sh\necho shadow executable should not run >&2\nexit 99\n",
    );
    chmodSync(path.join(harness.cwd, "gemini"), 0o755);
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", "gemini");

    const output = await adapter.run({
      ...createInput(reviewer, harness),
      env: {
        PATH: `${path.delimiter}${safeBin}${path.delimiter}${path.dirname(process.execPath)}`,
        DIFFWARDEN_FAKE_CLI: "gemini",
        DIFFWARDEN_INVOCATION_PATH: path.join(harness.cwd, "gemini-invocation.json"),
      },
    });

    expect(output.text).toContain("gemini text");
    expect(output.metadata?.executable).toBe(safeExecutable);
  });

  it("classifies CLI auth failures as missing auth", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_EXIT_AUTH: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      message: expect.stringContaining("authentication"),
    });
  });

  it("reaps CLI processes after abort", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);
    const abortController = new AbortController();
    const run = adapter.run({
      ...createInput(reviewer, harness),
      signal: abortController.signal,
      env: {
        ...harness.env,
        DIFFWARDEN_FAKE_HANG: "1",
      },
    });

    await waitForInvocation(harness);
    const pid = harness.readInvocation().pid;
    abortController.abort(new Error("test abort"));

    await expect(run).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("reviewer aborted"),
    });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("rejects unsupported Antigravity model overrides", async () => {
    const harness = createHarness("antigravity");
    const adapter = createCliAdapter("antigravity");
    const reviewer = createReviewer("antigravity", harness.executable, { model: "test-model" });

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: harness.env,
      }),
    ).rejects.toMatchObject({
      code: "invalid_cli",
      message: expect.stringContaining("does not support per-run model overrides"),
    });
  });

  it("preserves provider prefixes even when the model id contains a slash", async () => {
    const harness = createHarness("opencode");
    const adapter = createCliAdapter("opencode");
    const reviewer = createReviewer("opencode", harness.executable, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
    });

    const output = await adapter.run(createInput(reviewer, harness));

    expect(harness.readInvocation().args).toContain("openrouter/anthropic/claude-sonnet");
    expect(output.metadata).toMatchObject({
      model: "anthropic/claude-sonnet",
      requestedModel: "openrouter/anthropic/claude-sonnet",
      resolvedModel: "openrouter/anthropic/claude-sonnet",
      modelResolutionSource: "requested",
    });
  });

  it("maps public effort values to Claude CLI native effort values", async () => {
    const harness = createHarness("claude");
    const adapter = createCliAdapter("claude");
    const reviewer = createReviewer("claude", harness.executable, { effort: "minimal" });

    const output = await adapter.run(createInput(reviewer, harness));

    const args = harness.readInvocation().args;
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "low",
    ]);
    expect(output.metadata).toMatchObject({
      effort: "minimal",
      requestedEffort: "minimal",
      resolvedEffort: "low",
      effortResolutionSource: "adapter-selection",
    });
  });

  it("maps public effort values to Droid CLI native effort values", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable, { effort: "minimal" });

    const output = await adapter.run(createInput(reviewer, harness));

    const args = harness.readInvocation().args;
    expect(
      args.slice(
        args.indexOf("--spec-reasoning-effort"),
        args.indexOf("--spec-reasoning-effort") + 2,
      ),
    ).toEqual(["--spec-reasoning-effort", "low"]);
    expect(output.metadata).toMatchObject({
      effort: "minimal",
      requestedEffort: "minimal",
      resolvedEffort: "low",
      effortResolutionSource: "adapter-selection",
    });
  });

  it("maps public effort values to Grok CLI native effort values", async () => {
    const harness = createHarness("grok");
    const adapter = createCliAdapter("grok");
    const reviewer = createReviewer("grok", harness.executable, { effort: "minimal" });

    const output = await adapter.run(createInput(reviewer, harness));

    const args = harness.readInvocation().args;
    expect(
      args.slice(args.indexOf("--reasoning-effort"), args.indexOf("--reasoning-effort") + 2),
    ).toEqual(["--reasoning-effort", "low"]);
    expect(output.metadata).toMatchObject({
      effort: "minimal",
      requestedEffort: "minimal",
      resolvedEffort: "low",
      effortResolutionSource: "adapter-selection",
    });
  });

  it.each([
    ["codex", "model_reasoning_effort"],
    ["claude", "--effort"],
    ["droid", "--spec-reasoning-effort"],
    ["grok", "--reasoning-effort"],
    ["opencode", "--variant"],
  ] as const)("does not report omitted %s off effort as resolved", async (engine, omittedArg) => {
    const harness = createHarness(engine);
    const adapter = createCliAdapter(engine);
    const reviewer = createReviewer(engine, harness.executable, { effort: "off" });

    const output = await adapter.run(createInput(reviewer, harness));

    expect(harness.readInvocation().args.join(" ")).not.toContain(omittedArg);
    expect(output.metadata).toMatchObject({
      effort: "off",
      requestedEffort: "off",
      effortResolutionSource: "adapter-selection",
    });
    expect(output.metadata).not.toHaveProperty("resolvedEffort");
  });

  it("reports Pi off effort as resolved because it is passed to the CLI", async () => {
    const harness = createHarness("pi");
    const adapter = createCliAdapter("pi");
    const reviewer = createReviewer("pi", harness.executable, { effort: "off" });

    const output = await adapter.run(createInput(reviewer, harness));

    const args = harness.readInvocation().args;
    expect(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual([
      "--thinking",
      "off",
    ]);
    expect(output.metadata).toMatchObject({
      effort: "off",
      requestedEffort: "off",
      resolvedEffort: "off",
      effortResolutionSource: "requested",
    });
  });

  it("rejects oversized Cursor prompts before spawning", async () => {
    const harness = createHarness("cursor");
    const adapter = createCliAdapter("cursor");
    const reviewer = createReviewer("cursor", harness.executable);
    const input = createInput(reviewer, harness);

    await expect(
      adapter.run({
        ...input,
        prompt: "x".repeat(128 * 1024 + 1),
      }),
    ).rejects.toMatchObject({
      code: "invalid_cli",
      message: expect.stringContaining("prompt argv input"),
    });
  });
});

function createHarness(engine: CliEngine) {
  root = mkdtempSync(path.join(tmpdir(), "diffwarden-cli-adapter-"));
  const executable = path.join(root, engine);
  const invocationPath = path.join(root, `${engine}-invocation.json`);
  writeFileSync(executable, fakeCliScript(engine), "utf8");
  chmodSync(executable, 0o755);

  return {
    cwd: root,
    executable,
    env: {
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      DIFFWARDEN_FAKE_CLI: engine,
      DIFFWARDEN_INVOCATION_PATH: invocationPath,
    },
    readInvocation() {
      return JSON.parse(readFileSync(invocationPath, "utf8")) as {
        args: string[];
        env: Record<string, string | undefined>;
        pid: number;
        stdin: string;
      };
    },
  };
}

function createReviewer(
  engine: CliEngine,
  executable: string,
  extra: Partial<ReviewReviewerConfig> = {},
): ReviewReviewerConfig {
  return {
    id: engine,
    sdk: engine,
    transport: "cli",
    readonly: true,
    cliOptions: { executable },
    ...extra,
  };
}

function createInput(reviewer: ReviewReviewerConfig, harness: ReturnType<typeof createHarness>) {
  return {
    cwd: harness.cwd,
    reviewer,
    target: {
      kind: "custom",
      repo_root: harness.cwd,
      diff_command: "test diff",
      changed_files: ["file.ts"],
    },
    diff: "diff --git a/file.ts b/file.ts\n",
    changedFiles: ["file.ts"],
    prompt: "review prompt",
    readonly: true,
    env: harness.env,
  } satisfies ReviewAdapterInput;
}

function fakeCliScript(engine: CliEngine): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const engine = process.env.DIFFWARDEN_FAKE_CLI;
const invocationPath = process.env.DIFFWARDEN_INVOCATION_PATH;
if (engine === "claude" && process.argv[2] === "auth" && process.argv[3] === "status") {
  if (process.env.ANTHROPIC_API_KEY) {
    process.stdout.write(JSON.stringify({ loggedIn: true, apiKeySource: "ANTHROPIC_API_KEY" }));
  } else {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
  }
  process.exit(0);
}
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(invocationPath, JSON.stringify({
  args: process.argv.slice(2),
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
  },
  pid: process.pid,
  stdin,
}));
if (process.env.DIFFWARDEN_FAKE_EXIT_AUTH === "1") {
  process.stderr.write("not logged in: API key required");
  process.exit(1);
}
if (process.env.DIFFWARDEN_FAKE_HANG === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const review = {
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: engine + " ok",
  overall_confidence_score: 1
};
if (engine === "codex") {
  const outputIndex = process.argv.indexOf("--output-last-message");
  fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify(review));
} else if (engine === "claude") {
  process.stdout.write(JSON.stringify({ result: review }));
} else if (engine === "cursor") {
  process.stdout.write(JSON.stringify({ result: engine + " text" }));
} else if (engine === "gemini") {
  process.stdout.write(JSON.stringify({ response: engine + " text" }));
} else if (engine === "droid") {
  process.stdout.write(JSON.stringify({ result: engine + " text" }));
} else if (engine === "grok") {
  process.stdout.write(JSON.stringify({ result: engine + " text" }));
} else if (engine === "opencode" || engine === "pi") {
  process.stdout.write(JSON.stringify({ type: "tool_use", content: "ignored tool output" }) + "\\n");
  if (engine === "opencode") {
    process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: engine + " first", time: { end: 1 } } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: engine + " second", time: { end: 2 } } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ignored tool result" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: engine + " first" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: engine + " second" }] } }) + "\\n");
  }
} else if (engine === "antigravity") {
  process.stdout.write(engine + " text");
} else {
  process.stderr.write("unexpected engine " + engine);
  process.exit(1);
}
`;
}

async function waitForInvocation(harness: ReturnType<typeof createHarness>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      harness.readInvocation();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("fake CLI did not record invocation");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
