import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
      executable: harness.executable,
      requestedExecutable: harness.executable,
      executableSource: "config",
      model: "gpt-test",
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      modelResolutionSource: "requested",
      effort: "high",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "requested",
      webSearchPolicy: "disabled",
      webSearchMode: "disabled",
    });
    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex ok",
    });
    expect(output.metadata).toMatchObject({
      captureMode: "native-structured",
      executable: harness.executable,
      requestedExecutable: harness.executable,
      executableSource: "config",
      model: "gpt-test",
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      modelResolutionSource: "requested",
      effort: "high",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "requested",
      webSearchPolicy: "disabled",
      webSearchMode: "disabled",
    });
    expect(invocation.args).toContain("--model");
    expect(invocation.args).toContain("gpt-test");
    expect(invocation.args).toContain('web_search="disabled"');
    expect(invocation.args).toContain('model_reasoning_effort="high"');
    expect(invocation.args).toContain("exec");
    expect(invocation.args).toContain("--sandbox");
    expect(invocation.args).toContain("read-only");
    expect(invocation.stdin).toBe("review prompt");
  });

  it("spawns a text CLI and captures stdout", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable, { model: "test-model" });

    const output = await adapter.run(createInput(reviewer, harness));
    const invocation = harness.readInvocation();

    expect(output.text).toContain("gemini text");
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      readonlyCapability: "tool-restricted",
      model: "test-model",
      requestedModel: "test-model",
      resolvedModel: "test-model",
      modelResolutionSource: "requested",
    });
    expect(invocation.stdin).toBe("review prompt");
  });

  it("runs Opencode with stdin prompt input and low-tool review agent config", async () => {
    const harness = createHarness("opencode");
    const adapter = createCliAdapter("opencode");
    const reviewer = createReviewer("opencode", harness.executable);

    const output = await adapter.run(createInput(reviewer, harness));
    const invocation = harness.readInvocation();

    expect(output.text).toContain("opencode first");
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      readonlyCapability: "prompt-only",
    });
    expect(invocation.args).toEqual([
      "run",
      "--pure",
      "--format",
      "json",
      "--dir",
      harness.cwd,
      "--agent",
      expect.stringMatching(/^diffwarden-review-[0-9a-f-]{36}$/),
    ]);
    const agent = invocation.args[invocation.args.indexOf("--agent") + 1] ?? "";
    expect(invocation.stdin).toContain("OpenCode transport note:");
    expect(invocation.stdin).toContain("Only read, glob, and grep are available");
    expect(invocation.stdin).toContain("review prompt");
    const config = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config).toMatchObject({
      agent: {
        [agent]: {
          mode: "primary",
          permission: {
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
          },
        },
      },
    });
    expect(config.agent[agent]).not.toHaveProperty("steps");
    expect(JSON.parse(invocation.env.OPENCODE_PERMISSION ?? "{}")).toEqual({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
    });
  });

  it("records adapter-default executable provenance when no executable is configured", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer: ReviewReviewerConfig = {
      id: "gemini",
      sdk: "gemini",
      transport: "cli",
      readonly: true,
    };

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const output = await adapter.run(createInput(reviewer, harness));

    expect(preflight?.metadata).toMatchObject({
      executable: harness.executable,
      requestedExecutable: "gemini",
      executableSource: "adapter-default",
    });
    expect(output.metadata).toMatchObject({
      executable: harness.executable,
      requestedExecutable: "gemini",
      executableSource: "adapter-default",
    });
  });

  it("runs Antigravity with the prompt-bearing print flag", async () => {
    const harness = createHarness("antigravity");
    const adapter = createCliAdapter("antigravity");
    const reviewer = createReviewer("antigravity", harness.executable);

    const output = await adapter.run(createInput(reviewer, harness));
    const invocation = harness.readInvocation();

    expect(output.text).toContain("antigravity text");
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      readonlyCapability: "prompt-only",
    });
    expect(invocation.args[0]).toBe("--print");
    expect(invocation.args[1]).toContain("Read the full Diffwarden review prompt from");
    expect(invocation.args[1]).toContain("antigravity-prompt.txt");
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--print-timeout", "300s", "--sandbox", "--add-dir", harness.cwd]),
    );
    expect(invocation.args).not.toContain("review prompt");
    expect(invocation.stdin).toBe("");
  });

  it("prefers provider-observed CLI metadata over deterministic request metadata", async () => {
    const harness = createHarness("codex");
    const adapter = createCliAdapter("codex");
    const reviewer = createReviewer("codex", harness.executable, {
      model: "requested-model",
      effort: "high",
    });

    const output = await adapter.run({
      ...createInput(reviewer, harness),
      env: {
        ...harness.env,
        DIFFWARDEN_FAKE_RUNTIME_JSONL: JSON.stringify({
          type: "session_configured",
          model: "runtime-model",
          model_reasoning_effort: "medium",
        }),
      },
    });

    expect(output.metadata).toMatchObject({
      requestedModel: "requested-model",
      resolvedModel: "runtime-model",
      modelResolutionSource: "provider-init",
      requestedEffort: "high",
      resolvedEffort: "medium",
      effortResolutionSource: "provider-init",
    });
  });

  it("labels deterministic CLI metadata sourced from reviewer config", async () => {
    const harness = createHarness("codex");
    const adapter = createCliAdapter("codex");
    const reviewer = createReviewer("codex", harness.executable, {
      model: "configured-model",
      modelSource: "config",
      effort: "high",
      effortSource: "config",
    });

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const output = await adapter.run(createInput(reviewer, harness));

    expect(preflight?.metadata).toMatchObject({
      requestedModel: "configured-model",
      resolvedModel: "configured-model",
      modelResolutionSource: "config",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "config",
    });
    expect(output.metadata).toMatchObject({
      requestedModel: "configured-model",
      resolvedModel: "configured-model",
      modelResolutionSource: "config",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "config",
    });
  });

  it("keeps explicit Droid CLI metadata ahead of local session settings", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const homeDir = path.join(harness.cwd, "home");
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const sessionDirectory = path.join(
      homeDir,
      ".factory",
      "sessions",
      realpathSync(harness.cwd).replace(/[:\\/]/g, "-"),
    );
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      path.join(sessionDirectory, `${sessionId}.settings.json`),
      JSON.stringify({
        model: "droid-session-model",
        reasoningEffort: "medium",
      }),
    );
    const reviewer = createReviewer("droid", harness.executable, {
      model: "configured-model",
      modelSource: "config",
      effort: "high",
      effortSource: "config",
    });

    const output = await adapter.run({
      ...createInput(reviewer, harness),
      env: {
        ...harness.env,
        HOME: homeDir,
        DIFFWARDEN_FAKE_DROID_SESSION_ID: sessionId,
      },
    });

    expect(output.metadata).toMatchObject({
      requestedModel: "configured-model",
      resolvedModel: "configured-model",
      modelResolutionSource: "config",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "config",
      droidSessionId: sessionId,
      droidSessionModel: "droid-session-model",
      droidSessionEffort: "medium",
    });
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
    // Observe the run promise up front. Under heavy parallel load the fake CLI
    // can be slow to start, so waitForInvocation may throw before we abort;
    // without an attached handler the eventual rejection would surface as an
    // unhandled rejection, and the spawned process would outlive the test.
    const runOutcome = run.then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await waitForInvocation(harness);
      const pid = harness.readInvocation().pid;
      abortController.abort(new Error("test abort"));

      await expect(run).rejects.toMatchObject({
        code: "reviewer_failed",
        message: expect.stringContaining("reviewer aborted"),
      });
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      // Guarantee the child is signalled and reaped before afterEach deletes
      // the harness directory, even if the assertions above threw.
      abortController.abort(new Error("test cleanup"));
      await runOutcome;
    }
  });

  it.each([
    ["model", { model: "test-model" }, "model"],
    ["effort", { effort: "high" }, "effort"],
  ] as const)("rejects unsupported Antigravity %s overrides", async (_name, extra, message) => {
    const harness = createHarness("antigravity");
    const adapter = createCliAdapter("antigravity");
    const reviewer = createReviewer("antigravity", harness.executable, extra);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: harness.env,
      }),
    ).rejects.toMatchObject({
      code: "invalid_cli",
      message: expect.stringContaining(`does not support per-run ${message} overrides`),
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
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
  },
  pid: process.pid,
  stdin,
}));
if (process.env.DIFFWARDEN_FAKE_RUNTIME_JSONL) {
  process.stdout.write(process.env.DIFFWARDEN_FAKE_RUNTIME_JSONL + "\\n");
}
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
  process.stdout.write(JSON.stringify({ result: engine + " text", session_id: process.env.DIFFWARDEN_FAKE_DROID_SESSION_ID }));
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
  for (let attempt = 0; attempt < 500; attempt += 1) {
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
