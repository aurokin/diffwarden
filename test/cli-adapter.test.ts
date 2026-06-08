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
import { antigravityCliReviewDeniedPermissions } from "../src/adapters/antigravity-tool-policy.js";
import { claudeCliReviewPolicyCliFlags } from "../src/adapters/claude-tool-policy.js";
import { createCliAdapter } from "../src/adapters/cli.js";
import {
  droidCliReviewAllowedTools,
  droidCliReviewAllowedToolsArg,
  droidCliReviewPolicyCliFlags,
} from "../src/adapters/droid-tool-policy.js";
import {
  geminiCliReviewPolicyCliFlags,
  geminiCliSkipTrustFlag,
  geminiCliTrustWorkspaceEnvVar,
  geminiCliTrustedFoldersPathEnvVar,
} from "../src/adapters/gemini-tool-policy.js";
import {
  grokCliDisallowedToolsArg,
  grokCliReviewPermissionMode,
  grokCliReviewPolicyCliFlags,
  grokCliReviewSandbox,
  grokCliReviewToolsArg,
} from "../src/adapters/grok-tool-policy.js";
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
    (harness.env as NodeJS.ProcessEnv)[geminiCliTrustWorkspaceEnvVar] = "true";
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
    expect(invocation.env[geminiCliTrustWorkspaceEnvVar]).toBeUndefined();
    expect(invocation.env[geminiCliTrustedFoldersPathEnvVar]).toContain(
      "gemini-trusted-folders.json",
    );
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        geminiCliSkipTrustFlag,
        "--approval-mode",
        "plan",
        "--policy",
        expect.stringContaining("gemini-review-policy.toml"),
        "--admin-policy",
        expect.stringContaining("gemini-review-policy.toml"),
        "--allowed-mcp-server-names",
        "",
        "--extensions",
        "none",
      ]),
    );
    expect(invocation.args).not.toContain("--sandbox");
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

  it("runs Grok with read-only sandboxing and low-tool review controls", async () => {
    const harness = createHarness("grok");
    const adapter = createCliAdapter("grok");
    const reviewer = createReviewer("grok", harness.executable, {
      model: "grok-test",
      effort: "minimal",
    });

    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    if (prepared === undefined) {
      throw new Error("Grok CLI adapter did not return a prepared run context");
    }
    if (prepared.preflight === undefined) {
      throw new Error("Grok CLI adapter did not return preflight metadata");
    }
    const output = await adapter.run({
      ...createInput(reviewer, harness),
      runContext: prepared.runContext,
    });
    const invocation = harness.readInvocation();

    expect(prepared.preflight.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "grok-policy",
          status: "passed",
        }),
        expect.objectContaining({
          name: "readonly",
          status: "passed",
        }),
      ]),
    );
    expect(output.text).toContain("grok text");
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      readonlyCapability: "enforced",
      grokPermissionMode: grokCliReviewPermissionMode,
      grokSandboxMode: grokCliReviewSandbox,
      grokAllowedTools: ["read_file", "grep", "list_dir"],
    });
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        grokCliReviewPermissionMode,
        "--tools",
        grokCliReviewToolsArg(),
        "--disallowed-tools",
        grokCliDisallowedToolsArg(),
        "--sandbox",
        grokCliReviewSandbox,
        "--no-subagents",
        "--no-memory",
        "--disable-web-search",
        "--model",
        "grok-test",
        "--reasoning-effort",
        "low",
      ]),
    );
    expect(invocation.args).toEqual(expect.arrayContaining(["--allow", "Read"]));
    expect(invocation.args).toEqual(expect.arrayContaining(["--allow", "Grep"]));
    expect(invocation.args).toEqual(expect.arrayContaining(["--deny", "Bash"]));
    expect(invocation.args).toEqual(expect.arrayContaining(["--deny", "MCPTool"]));
    expect(invocation.args).not.toContain("--max-turns");
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
    expect(preflight?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "gemini-policy",
          status: "passed",
        }),
      ]),
    );
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
      readonlyCapability: "tool-restricted",
      antigravityToolPermission: "strict",
      antigravitySandbox: "enabled",
    });
    expect(invocation.args[0]).toBe("--print");
    expect(invocation.args[1]).toContain("Read the full Diffwarden review prompt from");
    expect(invocation.args[1]).toContain("antigravity-prompt.txt");
    expect(invocation.cwd).toContain("antigravity-prompt");
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--print-timeout", "300s", "--sandbox", "--add-dir", harness.cwd]),
    );
    expect(invocation.args).not.toContain("review prompt");
    expect(invocation.env.HOME).toContain("diffwarden-cli-");
    const isolatedHome = invocation.env.HOME;
    if (isolatedHome === undefined) {
      throw new Error("Antigravity isolated HOME was not captured");
    }
    expect(invocation.env.USERPROFILE).toBe(isolatedHome);
    expect(invocation.env.HOMEDRIVE).toBeUndefined();
    expect(invocation.env.HOMEPATH).toBeUndefined();
    expect(invocation.env.XDG_CONFIG_HOME).toBe(path.join(isolatedHome, ".config"));
    expect(invocation.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    const settings = JSON.parse(invocation.antigravitySettings ?? "{}");
    expect(settings.permissions.deny).toEqual([...antigravityCliReviewDeniedPermissions]);
    expect(settings.permissions.allow).toEqual(["read_file(*)"]);
    expect(settings.trustedWorkspaces).toEqual(
      expect.arrayContaining([expect.stringContaining("diffwarden-cli-"), harness.cwd]),
    );
    expect(settings.trustedWorkspaces).not.toContain(isolatedHome);
    expect(path.relative(invocation.cwd, isolatedHome).startsWith("..")).toBe(true);
    expect(invocation.stdin).toBe("");
  });

  it("preflights Antigravity review policy support", async () => {
    const harness = createHarness("antigravity");
    const adapter = createCliAdapter("antigravity");
    const reviewer = createReviewer("antigravity", harness.executable);

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });

    expect(preflight?.metadata?.readonlyCapability).toBe("tool-restricted");
    expect(preflight?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "antigravity-policy",
          status: "passed",
        }),
      ]),
    );
  });

  it("fails Antigravity preflight when the executable predates review policy support", async () => {
    const harness = createHarness("antigravity");
    const adapter = createCliAdapter("antigravity");
    const reviewer = createReviewer("antigravity", harness.executable);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: { ...harness.env, DIFFWARDEN_FAKE_OLD_ANTIGRAVITY_VERSION: "1" },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("required review policy version"),
    });
  });

  it("rechecks Antigravity review policy under the isolated run environment", async () => {
    const harness = createHarness("antigravity");
    const adapter = createCliAdapter("antigravity");
    const reviewer = createReviewer("antigravity", harness.executable);
    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const versionHomeCapturePath = path.join(harness.cwd, "antigravity-version-home.txt");

    await adapter.run({
      ...createInput(reviewer, harness),
      runContext: prepared?.runContext,
      env: {
        ...harness.env,
        DIFFWARDEN_ANTIGRAVITY_VERSION_HOME_CAPTURE_PATH: versionHomeCapturePath,
      },
    });

    expect(readFileSync(versionHomeCapturePath, "utf8")).toContain("antigravity-home");
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

  it("preflights and runs Droid CLI reviews with explicit read-only tool policy", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const env = {
      ...harness.env,
      DIFFWARDEN_EXPECT_DROID_LIST_TOOLS_CWD: harness.cwd,
    };
    const reviewer = createReviewer("droid", harness.executable, {
      model: "claude-opus-4-8",
      effort: "minimal",
    });

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env,
    });
    const output = await adapter.run({
      ...createInput(reviewer, harness),
      env,
    });
    const invocation = harness.readInvocation();

    expect(preflight?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "droid-policy",
          status: "passed",
        }),
        expect.objectContaining({
          name: "readonly",
          status: "passed",
        }),
      ]),
    );
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      readonlyCapability: "enforced",
      droidInteractionMode: "spec",
      droidAutonomyLevel: "default-readonly",
      droidToolPolicy: "allowlist",
      droidAllowedTools: [
        "read-cli",
        "glob-search-cli",
        "grep_tool_cli",
        "ls-cli",
        "exit-spec-mode",
      ],
      droidMissionMode: "disabled",
      droidLogGroupId: expect.stringMatching(/^diffwarden-droid-[0-9a-f-]{36}$/),
    });
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--output-format",
        "json",
        "--use-spec",
        "--enabled-tools",
        droidCliReviewAllowedToolsArg(),
        "--spec-model",
        "claude-opus-4-8",
        "--spec-reasoning-effort",
        "low",
        "--log-group-id",
        expect.stringMatching(/^diffwarden-droid-[0-9a-f-]{36}$/),
      ]),
    );
    expect(invocation.args).not.toContain("--disabled-tools");
    expect(invocation.args).not.toContain("--auto");
    expect(invocation.args).not.toContain("--skip-permissions-unsafe");
    expect(invocation.args).not.toContain("--mission");
  });

  it("does not require Droid model and effort flags for default CLI reviews", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable);

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: {
        ...harness.env,
        DIFFWARDEN_FAKE_DROID_NO_MODEL_FLAGS_HELP: "1",
      },
    });

    expect(preflight?.checks).toContainEqual(
      expect.objectContaining({
        name: "droid-policy",
        status: "passed",
      }),
    );
  });

  it("omits Droid log group metadata when the executable lacks that optional flag", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable);

    const output = await adapter.run({
      ...createInput(reviewer, harness),
      env: {
        ...harness.env,
        DIFFWARDEN_FAKE_DROID_NO_LOG_GROUP_HELP: "1",
      },
    });
    const invocation = harness.readInvocation();

    expect(invocation.args).not.toContain("--log-group-id");
    expect(output.metadata).not.toHaveProperty("droidLogGroupId");
  });

  it("accepts provider-qualified Droid CLI models when help lists bare model ids", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable, {
      provider: "factory",
      model: "claude-opus-4-8",
      effort: "high",
    });

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: {
        ...harness.env,
        DIFFWARDEN_FAKE_DROID_MODELS_HELP: "1",
      },
    });

    expect(preflight?.checks).toContainEqual(
      expect.objectContaining({
        name: "droid-policy",
        status: "passed",
      }),
    );
  });

  it("rechecks prepared Droid CLI policy when model requirements change", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer: createReviewer("droid", harness.executable),
      readonly: true,
      env: {
        ...harness.env,
        DIFFWARDEN_FAKE_DROID_NO_MODEL_FLAGS_HELP: "1",
      },
    });
    const reviewer = createReviewer("droid", harness.executable, { model: "claude-opus-4-8" });

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        runContext: prepared?.runContext,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_DROID_NO_MODEL_FLAGS_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--spec-model"),
    });
  });

  it("rechecks prepared Droid CLI policy when review cwd changes", async () => {
    const harness = createHarness("droid");
    const markerPath = path.join(harness.cwd, "droid-list-tools.log");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable);
    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: {
        ...harness.env,
        DIFFWARDEN_DROID_LIST_TOOLS_MARKER: markerPath,
      },
    });
    const otherCwd = path.join(harness.cwd, "other-workspace");
    mkdirSync(otherCwd);

    await adapter.run({
      ...createInput(reviewer, harness),
      cwd: otherCwd,
      target: {
        kind: "custom",
        repo_root: otherCwd,
        diff_command: "test diff",
        changed_files: ["file.ts"],
      },
      runContext: prepared?.runContext,
      env: {
        ...harness.env,
        DIFFWARDEN_DROID_LIST_TOOLS_MARKER: markerPath,
      },
    });

    const listToolRuns = readFileSync(markerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(listToolRuns).toHaveLength(2);
    expect(listToolRuns[1]).toEqual(expect.arrayContaining(["--cwd", otherCwd]));
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

  it("fails Claude CLI preflight when the executable lacks review policy flags", async () => {
    const harness = createHarness("claude");
    const adapter = createCliAdapter("claude");
    const reviewer = createReviewer("claude", harness.executable);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_CLAUDE_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--allowedTools"),
    });
  });

  it("checks Claude CLI policy flags during direct API key runs", async () => {
    const harness = createHarness("claude");
    const adapter = createCliAdapter("claude");
    const reviewer = createReviewer("claude", harness.executable, {
      sdkOptions: { authMode: "api-key" },
    });

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        env: {
          ...harness.env,
          ANTHROPIC_API_KEY: "test-key",
          DIFFWARDEN_FAKE_OLD_CLAUDE_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--allowedTools"),
    });
  });

  it("fails Gemini CLI preflight when the executable lacks review policy flags", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_GEMINI_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--admin-policy"),
    });
  });

  it("does not treat Gemini --admin-policy help text as --policy support", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_GEMINI_ADMIN_POLICY_ONLY: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--policy"),
    });
  });

  it("isolates Gemini CLI trust state during preflight policy checks", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);

    const preflight = await adapter.preflight?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: {
        ...harness.env,
        DIFFWARDEN_FAIL_ON_TRUSTED_GEMINI_HELP: "1",
        [geminiCliTrustWorkspaceEnvVar]: "true",
      },
    });

    expect(preflight?.checks).toContainEqual(
      expect.objectContaining({
        name: "gemini-policy",
        status: "passed",
      }),
    );
  });

  it("checks Gemini CLI policy flags during direct runs", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_GEMINI_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--admin-policy"),
    });
  });

  it("fails Droid CLI preflight when the executable lacks review policy flags", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_DROID_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--enabled-tools"),
    });
  });

  it("checks Droid CLI policy flags during direct runs", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable);

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_DROID_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--enabled-tools"),
    });
  });

  it("fails Droid CLI preflight when the executable exposes unexpected review tools", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_DROID_BAD_TOOLS: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("tool allowlist"),
    });
  });

  it("fails Droid CLI preflight when the requested model is not listed", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable, { model: "missing-model" });

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_DROID_MODELS_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("missing-model"),
    });
  });

  it("fails Droid CLI preflight when the requested effort is unsupported", async () => {
    const harness = createHarness("droid");
    const adapter = createCliAdapter("droid");
    const reviewer = createReviewer("droid", harness.executable, {
      model: "gpt-5.4-mini",
      effort: "minimal",
    });

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_DROID_MODELS_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("does not support reasoning effort low"),
    });
  });

  it("fails Grok CLI preflight when the executable lacks review policy flags", async () => {
    const harness = createHarness("grok");
    const adapter = createCliAdapter("grok");
    const reviewer = createReviewer("grok", harness.executable);

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_GROK_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--tools"),
    });
  });

  it("checks Grok CLI policy flags during direct runs", async () => {
    const harness = createHarness("grok");
    const adapter = createCliAdapter("grok");
    const reviewer = createReviewer("grok", harness.executable);

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_GROK_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--tools"),
    });
  });

  it("reuses Gemini CLI policy preflight checks during prepared runs", async () => {
    const harness = createHarness("gemini");
    const failHelpMarker = path.join(harness.cwd, "fail-gemini-help");
    const env = {
      ...harness.env,
      DIFFWARDEN_FAIL_GEMINI_HELP_IF_MARKER: failHelpMarker,
    };
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);
    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env,
    });
    expect(Object.isFrozen(prepared?.runContext)).toBe(true);
    expect(prepared?.runContext).not.toHaveProperty("executableIdentity");
    writeFileSync(failHelpMarker, "fail repeated help");

    const output = await adapter.run({
      ...createInput(reviewer, harness),
      runContext: prepared?.runContext,
      env,
    });

    expect(output.text).toContain("gemini text");
  });

  it("rechecks Gemini CLI policy flags when the prepared run environment changes", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);
    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        runContext: prepared?.runContext,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_GEMINI_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--admin-policy"),
    });
  });

  it("rechecks Gemini CLI policy flags when the prepared executable changes", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);
    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    writeFileSync(harness.executable, `${fakeCliScript("gemini")}\n// changed after prepare\n`);
    chmodSync(harness.executable, 0o755);

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        runContext: prepared?.runContext,
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_GEMINI_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--admin-policy"),
    });
  });

  it("does not trust caller-supplied Gemini run contexts as policy preflight proof", async () => {
    const harness = createHarness("gemini");
    const adapter = createCliAdapter("gemini");
    const reviewer = createReviewer("gemini", harness.executable);

    await expect(
      adapter.run({
        ...createInput(reviewer, harness),
        runContext: {
          kind: "cli",
          requestedExecutable: harness.executable,
          resolvedExecutable: harness.executable,
          policyChecks: ["gemini"],
        },
        env: {
          ...harness.env,
          DIFFWARDEN_FAKE_OLD_GEMINI_HELP: "1",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("--admin-policy"),
    });
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
        antigravitySettings?: string;
        cwd: string;
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
const path = require("node:path");
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
if (engine === "claude" && process.argv.includes("--help")) {
  if (process.env.DIFFWARDEN_FAKE_OLD_CLAUDE_HELP === "1") {
    process.stdout.write("--tools --disallowedTools --permission-mode");
  } else {
    process.stdout.write(${JSON.stringify(claudeCliReviewPolicyCliFlags.join(" "))});
  }
  process.exit(0);
}
if (engine === "gemini" && process.argv.includes("--help")) {
  const failHelpMarker = process.env.DIFFWARDEN_FAIL_GEMINI_HELP_IF_MARKER;
  if (failHelpMarker && fs.existsSync(failHelpMarker)) {
    process.stderr.write("gemini help repeated after marker");
    process.exit(67);
  }
  if (
    process.env.DIFFWARDEN_FAIL_ON_TRUSTED_GEMINI_HELP === "1" &&
    process.env.GEMINI_CLI_TRUST_WORKSPACE === "true"
  ) {
    process.stderr.write("gemini help inherited trusted workspace");
    process.exit(66);
  }
  if (process.env.DIFFWARDEN_FAKE_GEMINI_ADMIN_POLICY_ONLY === "1") {
    process.stdout.write(${JSON.stringify(
      geminiCliReviewPolicyCliFlags.filter((flag) => flag !== "--policy").join(" "),
    )});
    process.exit(0);
  }
  if (process.env.DIFFWARDEN_FAKE_OLD_GEMINI_HELP === "1") {
    process.stdout.write("--prompt --output-format --approval-mode --allowed-mcp-server-names --extensions");
  } else {
    process.stdout.write(${JSON.stringify(geminiCliReviewPolicyCliFlags.join(" "))});
  }
  process.exit(0);
}
if (engine === "grok" && process.argv.includes("--help")) {
  if (process.env.DIFFWARDEN_FAKE_OLD_GROK_HELP === "1") {
    process.stdout.write("--prompt-file --cwd --output-format --permission-mode");
  } else {
    process.stdout.write(${JSON.stringify(grokCliReviewPolicyCliFlags.join(" "))});
  }
  process.exit(0);
}
if (engine === "droid" && process.argv[2] === "exec" && process.argv.includes("--help")) {
  if (process.env.DIFFWARDEN_FAKE_OLD_DROID_HELP === "1") {
    process.stdout.write("--cwd --output-format --use-spec --file --spec-model --spec-reasoning-effort --tag");
  } else {
    let flagsHelp = ${JSON.stringify([...droidCliReviewPolicyCliFlags])};
    if (process.env.DIFFWARDEN_FAKE_DROID_NO_MODEL_FLAGS_HELP === "1") {
      flagsHelp = flagsHelp.filter((flag) => flag !== "--spec-model" && flag !== "--spec-reasoning-effort");
    }
    if (process.env.DIFFWARDEN_FAKE_DROID_NO_LOG_GROUP_HELP === "1") {
      flagsHelp = flagsHelp.filter((flag) => flag !== "--log-group-id");
    }
    const modelsHelp = process.env.DIFFWARDEN_FAKE_DROID_MODELS_HELP === "1"
      ? "\\nAvailable Models:\\n  claude-opus-4-8              Claude Opus 4.8 (default)\\n  gpt-5.4-mini                 GPT 5.4 Mini\\nModel details:\\n  - Claude Opus 4.8: supports reasoning: Yes; supported: [off, low, medium, high]; default: high\\n  - GPT 5.4 Mini: supports reasoning: Yes; supported: [high]; default: high\\n"
      : "";
    process.stdout.write(flagsHelp.join(" ") + modelsHelp);
  }
  process.exit(0);
}
if (engine === "droid" && process.argv[2] === "exec" && process.argv.includes("--list-tools")) {
  const markerPath = process.env.DIFFWARDEN_DROID_LIST_TOOLS_MARKER;
  if (markerPath) {
    fs.appendFileSync(markerPath, JSON.stringify(process.argv.slice(2)) + "\\n");
  }
  const expectedCwd = process.env.DIFFWARDEN_EXPECT_DROID_LIST_TOOLS_CWD;
  if (expectedCwd) {
    const cwdIndex = process.argv.indexOf("--cwd");
    if (cwdIndex === -1 || process.argv[cwdIndex + 1] !== expectedCwd) {
      process.stderr.write("droid list-tools missing expected cwd");
      process.exit(75);
    }
  }
  const expectedTools = ${JSON.stringify([...droidCliReviewAllowedTools])};
  const tools = expectedTools.map((id) => ({
    id,
    llmId: id === "exit-spec-mode" ? "ExitSpecMode" : id,
    currentlyAllowed: true,
  }));
  tools.push({
    id: "execute-cli",
    llmId: "Execute",
    currentlyAllowed: process.env.DIFFWARDEN_FAKE_DROID_BAD_TOOLS === "1",
  });
  process.stdout.write(JSON.stringify(tools));
  process.exit(0);
}
if (engine === "antigravity" && process.argv.includes("--version")) {
  if (process.env.DIFFWARDEN_ANTIGRAVITY_VERSION_HOME_CAPTURE_PATH) {
    fs.appendFileSync(
      process.env.DIFFWARDEN_ANTIGRAVITY_VERSION_HOME_CAPTURE_PATH,
      (process.env.HOME ?? "") + "\\n",
    );
  }
  process.stdout.write(process.env.DIFFWARDEN_FAKE_OLD_ANTIGRAVITY_VERSION === "1" ? "1.0.5" : "1.0.6");
  process.exit(0);
}
const stdin = fs.readFileSync(0, "utf8");
const antigravitySettingsPath = process.env.HOME
  ? path.join(process.env.HOME, ".gemini", "antigravity-cli", "settings.json")
  : undefined;
fs.writeFileSync(invocationPath, JSON.stringify({
  args: process.argv.slice(2),
  antigravitySettings:
    antigravitySettingsPath && fs.existsSync(antigravitySettingsPath)
      ? fs.readFileSync(antigravitySettingsPath, "utf8")
      : undefined,
  cwd: process.cwd(),
  env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
      GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE,
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH,
      HOME: process.env.HOME,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
      OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
      USERPROFILE: process.env.USERPROFILE,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
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
