import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliSpecs } from "../src/adapters/cli-specs.js";
import type { CliEngine, CliRunResult } from "../src/adapters/cli-types.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("cliSpecs", () => {
  it("builds Codex read-only structured invocations and web-search config", async () => {
    const tempDir = createTempDir();
    const reviewer = createReviewer("codex", {
      model: "gpt-test",
      effort: "high",
    });

    const invocation = await cliSpecs.codex.buildInvocation(createInput(reviewer), tempDir);

    expect(invocation).toMatchObject({
      executable: "codex",
      stdin: "review prompt",
      outputPath: path.join(tempDir, "codex-review.json"),
      captureMode: "native-structured",
    });
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-test",
        "-c",
        'web_search="disabled"',
        "-c",
        'model_reasoning_effort="high"',
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--output-schema",
        path.join(tempDir, "review-schema.json"),
        "--output-last-message",
        path.join(tempDir, "codex-review.json"),
        "--cd",
        "/repo",
        "-",
      ]),
    );
    expect(readFileSync(path.join(tempDir, "review-schema.json"), "utf8")).toContain(
      '"overall_correctness"',
    );
  });

  it("omits Codex web-search config when inheritance is requested", async () => {
    const tempDir = createTempDir();
    const reviewer = createReviewer("codex", {
      cliOptions: { webSearch: "inherit" },
    });

    const invocation = await cliSpecs.codex.buildInvocation(createInput(reviewer), tempDir);

    expect(invocation.args.join(" ")).not.toContain("web_search=");
  });

  it.each([
    [
      "cursor",
      [
        "-p",
        "--output-format",
        "json",
        "--workspace",
        "/repo",
        "--mode",
        "plan",
        "--sandbox",
        "enabled",
        "--trust",
        "--model",
        "test-model",
        "review prompt",
      ],
      undefined,
    ],
    [
      "gemini",
      [
        "--prompt",
        "",
        "--output-format",
        "json",
        "--approval-mode",
        "plan",
        "--model",
        "test-model",
      ],
      "review prompt",
    ],
  ] as const)("builds %s text CLI invocations", async (engine, expectedArgs, expectedStdin) => {
    const invocation = await cliSpecs[engine].buildInvocation(
      createInput(createReviewer(engine, { model: "test-model" })),
      createTempDir(),
    );

    expect(invocation.args).toEqual(expectedArgs);
    expect(invocation.stdin).toBe(expectedStdin);
  });

  it("builds Claude restricted invocations and strips API credentials for Claude Code auth", async () => {
    const tempDir = createTempDir();
    const executable = path.join(tempDir, "claude");
    const reviewer = createReviewer("claude", {
      model: "sonnet",
      effort: "minimal",
      cliOptions: { executable },
      sdkOptions: { authMode: "api-key" },
    });

    const invocation = await cliSpecs.claude.buildInvocation(
      createInput(reviewer, { env: { ANTHROPIC_API_KEY: "test-key" } }),
      tempDir,
    );

    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--permission-mode",
        "plan",
        "--tools",
        "Read,Grep,Glob,LS",
        "--disallowedTools",
        "Edit,Write,Bash",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--model",
        "sonnet",
        "--effort",
        "low",
      ]),
    );
    expect(invocation.stdin).toBe("review prompt");
    expect(invocation.unsetEnv).toBeUndefined();
  });

  it("builds Opencode and Pi JSONL invocations with read-only controls", async () => {
    const opencode = await cliSpecs.opencode.buildInvocation(
      createInput(
        createReviewer("opencode", {
          provider: "openrouter",
          model: "anthropic/claude-sonnet",
          effort: "high",
        }),
      ),
      createTempDir(),
    );
    const pi = await cliSpecs.pi.buildInvocation(
      createInput(createReviewer("pi", { provider: "provider", model: "model", effort: "high" })),
      createTempDir(),
    );

    expect(opencode.args).toEqual([
      "run",
      "--pure",
      "--format",
      "json",
      "--dir",
      "/repo",
      "--model",
      "openrouter/anthropic/claude-sonnet",
      "--variant",
      "high",
      "review prompt",
    ]);
    expect(JSON.parse(opencode.env?.OPENCODE_PERMISSION ?? "{}")).toMatchObject({
      "*": "deny",
      read: "allow",
      edit: "deny",
      bash: "deny",
    });
    expect(pi.args).toEqual(
      expect.arrayContaining([
        "--print",
        "--mode",
        "json",
        "--tools",
        "read,grep,find,ls",
        "--model",
        "provider/model",
        "--thinking",
        "high",
      ]),
    );
    expect(pi.stdin).toBe("review prompt");
  });

  it("builds Droid and Grok file-prompt invocations", async () => {
    const droidTemp = createTempDir();
    const grokTemp = createTempDir();

    const droid = await cliSpecs.droid.buildInvocation(
      createInput(createReviewer("droid", { model: "test-model", effort: "minimal" })),
      droidTemp,
    );
    const grok = await cliSpecs.grok.buildInvocation(
      createInput(createReviewer("grok", { model: "test-model", effort: "minimal" })),
      grokTemp,
    );

    expect(droid.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--cwd",
        "/repo",
        "--output-format",
        "json",
        "--use-spec",
        "--file",
        path.join(droidTemp, "droid-prompt.txt"),
        "--spec-model",
        "test-model",
        "--spec-reasoning-effort",
        "low",
      ]),
    );
    expect(grok.args).toEqual(
      expect.arrayContaining([
        "--prompt-file",
        path.join(grokTemp, "grok-prompt.txt"),
        "--cwd",
        "/repo",
        "--permission-mode",
        "plan",
        "--model",
        "test-model",
        "--reasoning-effort",
        "low",
      ]),
    );
  });

  it("omits off effort for CLIs that do not pass an off value", async () => {
    for (const [engine, omittedArg] of [
      ["codex", "model_reasoning_effort"],
      ["claude", "--effort"],
      ["droid", "--spec-reasoning-effort"],
      ["grok", "--reasoning-effort"],
      ["opencode", "--variant"],
    ] as const) {
      const reviewer =
        engine === "claude"
          ? createReviewer(engine, {
              effort: "off",
              sdkOptions: { authMode: "api-key" },
            })
          : createReviewer(engine, { effort: "off" });
      const env = engine === "claude" ? { ANTHROPIC_API_KEY: "test-key" } : undefined;
      const invocation = await cliSpecs[engine].buildInvocation(
        createInput(reviewer, { ...(env !== undefined ? { env } : {}) }),
        createTempDir(),
      );

      expect(invocation.args.join(" ")).not.toContain(omittedArg);
    }
  });

  it("keeps Pi off effort because the CLI accepts it", async () => {
    const invocation = await cliSpecs.pi.buildInvocation(
      createInput(createReviewer("pi", { effort: "off" })),
      createTempDir(),
    );

    expect(invocation.args.slice(invocation.args.indexOf("--thinking"))).toContain("off");
  });

  it("parses structured, JSON, JSONL, and text outputs without spawning a CLI", async () => {
    const tempDir = createTempDir();
    const codexInvocation = await cliSpecs.codex.buildInvocation(
      createInput(createReviewer("codex")),
      tempDir,
    );
    writeReviewOutput(codexInvocation.outputPath ?? "");

    await expect(
      cliSpecs.codex.parseOutput(
        runResult({
          stdout: JSON.stringify({
            type: "session_configured",
            model: "codex-runtime",
            model_reasoning_effort: "high",
          }),
        }),
        codexInvocation,
      ),
    ).resolves.toMatchObject({
      structured: {
        overall_correctness: "patch is correct",
        overall_explanation: "ok",
      },
      metadata: {
        captureMode: "native-structured",
        readonlyCapability: "enforced",
        resolvedModel: "codex-runtime",
        modelResolutionSource: "provider-init",
        resolvedEffort: "high",
        effortResolutionSource: "provider-init",
      },
    });

    await expect(
      cliSpecs.gemini.parseOutput(
        runResult({ stdout: JSON.stringify({ response: "text", model: "gemini-runtime" }) }),
        {
          executable: "gemini",
          args: [],
          captureMode: "text",
        },
      ),
    ).resolves.toMatchObject({
      text: "text",
      metadata: {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        resolvedModel: "gemini-runtime",
        modelResolutionSource: "provider-result",
      },
    });

    await expect(
      cliSpecs.pi.parseOutput(
        runResult({
          stdout: [
            JSON.stringify({
              type: "session_start",
              model: "pi-runtime",
              thinkingLevel: "medium",
            }),
            JSON.stringify({ type: "message", message: { role: "toolResult", content: "skip" } }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: "first" } }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: "second" } }),
          ].join("\n"),
        }),
        { executable: "pi", args: [], captureMode: "text" },
      ),
    ).resolves.toMatchObject({
      text: "first\nsecond",
      metadata: {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        resolvedModel: "pi-runtime",
        modelResolutionSource: "provider-init",
        resolvedEffort: "medium",
        effortResolutionSource: "provider-init",
      },
    });

    await expect(
      cliSpecs.antigravity.parseOutput(runResult({ stdout: "plain text\n" }), {
        executable: "antigravity",
        args: [],
        captureMode: "text",
      }),
    ).resolves.toMatchObject({
      text: "plain text",
      metadata: { captureMode: "text", readonlyCapability: "prompt-only" },
    });
  });

  it("rejects oversized prompt argv input before a CLI is spawned", async () => {
    await expect(
      cliSpecs.cursor.buildInvocation(
        createInput(createReviewer("cursor"), { prompt: "x".repeat(128 * 1024 + 1) }),
        createTempDir(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_cli",
      message: expect.stringContaining("prompt argv input"),
    });
  });
});

function createTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "diffwarden-cli-specs-"));
  tempDirs.push(directory);
  return directory;
}

function createReviewer(
  engine: CliEngine,
  extra: Partial<ReviewReviewerConfig> = {},
): ReviewReviewerConfig {
  return {
    id: engine,
    sdk: engine,
    transport: "cli",
    readonly: true,
    ...extra,
  };
}

function createInput(
  reviewer: ReviewReviewerConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    prompt?: string;
  } = {},
): ReviewAdapterInput {
  return {
    cwd: "/repo",
    reviewer,
    target: {
      kind: "custom",
      repo_root: "/repo",
      diff_command: "test diff",
      changed_files: ["file.ts"],
    },
    diff: "diff --git a/file.ts b/file.ts\n",
    changedFiles: ["file.ts"],
    prompt: options.prompt ?? "review prompt",
    readonly: true,
    ...(options.env !== undefined ? { env: options.env } : {}),
  };
}

function runResult(options: Partial<CliRunResult>): CliRunResult {
  return {
    executable: "test-cli",
    stdout: "",
    stderr: "",
    ...options,
  };
}

function writeReviewOutput(outputPath: string): void {
  const review = {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "ok",
    overall_confidence_score: 1,
  };
  writeFileSync(outputPath, JSON.stringify(review));
}
