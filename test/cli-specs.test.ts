import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  antigravityCliReviewDeniedPermissions,
  antigravityCliReviewMcpConfigFileName,
  antigravityCliReviewPolicyMetadata,
  antigravityCliReviewSettingsFileName,
} from "../src/adapters/antigravity-tool-policy.js";
import {
  claudeCliDisallowedToolsArg,
  claudeCliReviewToolsArg,
} from "../src/adapters/claude-tool-policy.js";
import { cliSpecs } from "../src/adapters/cli-specs.js";
import { antigravitySourceGeminiDir } from "../src/adapters/cli-specs.js";
import type { CliEngine, CliRunResult } from "../src/adapters/cli-types.js";
import {
  codexCliCwdArg,
  codexCliIgnoredRulesArg,
  codexCliIgnoredUserConfigArg,
  codexCliOutputLastMessageArg,
  codexCliOutputSchemaArg,
  codexCliPromptStdinArg,
  codexCliReviewBaseArgs,
} from "../src/adapters/codex-tool-policy.js";
import { cursorCliReviewMode, cursorCliSandboxMode } from "../src/adapters/cursor-policy.js";
import {
  geminiCliReviewApprovalMode,
  geminiCliReviewDisabledExtensions,
  geminiCliReviewMcpAllowlist,
  geminiCliReviewOutputFormat,
  geminiCliReviewPolicyFileName,
  geminiCliReviewPolicyMetadata,
  geminiCliReviewPolicyToml,
  geminiCliReviewTrustedFoldersFileName,
  geminiCliSkipTrustFlag,
  geminiCliTrustWorkspaceEnvVar,
  geminiCliTrustedFoldersPathEnvVar,
} from "../src/adapters/gemini-tool-policy.js";
import {
  grokCliAllowRules,
  grokCliDenyRules,
  grokCliDisallowedToolsArg,
  grokCliReviewPermissionMode,
  grokCliReviewSandbox,
  grokCliReviewToolsArg,
} from "../src/adapters/grok-tool-policy.js";
import { piCliReviewSurfaceArgs } from "../src/adapters/pi-tool-policy.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";
import { reviewResultJsonSchema } from "../src/core/schema.js";

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
    expect(invocation.args).toEqual([
      "--model",
      "gpt-test",
      "-c",
      'web_search="disabled"',
      "-c",
      'model_reasoning_effort="high"',
      ...codexCliReviewBaseArgs,
      codexCliOutputSchemaArg,
      path.join(tempDir, "review-schema.json"),
      codexCliOutputLastMessageArg,
      path.join(tempDir, "codex-review.json"),
      codexCliCwdArg,
      "/repo",
      codexCliPromptStdinArg,
    ]);
    expect(invocation.args).not.toContain(codexCliIgnoredRulesArg);
    expect(invocation.args).not.toContain(codexCliIgnoredUserConfigArg);
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

  it("builds Cursor text CLI invocations", async () => {
    const invocation = await cliSpecs.cursor.buildInvocation(
      createInput(createReviewer("cursor", { model: "test-model" })),
      createTempDir(),
    );

    expect(invocation.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--workspace",
      "/repo",
      "--mode",
      cursorCliReviewMode,
      "--sandbox",
      cursorCliSandboxMode,
      "--trust",
      "--model",
      "test-model",
      "review prompt",
    ]);
    expect(invocation.stdin).toBeUndefined();
    expect(invocation.args).not.toContain("--force");
    expect(invocation.args).not.toContain("--yolo");
  });

  it("builds Gemini policy-restricted text CLI invocations", async () => {
    const tempDir = createTempDir();
    const policyPath = path.join(tempDir, geminiCliReviewPolicyFileName);
    const trustedFoldersPath = path.join(tempDir, geminiCliReviewTrustedFoldersFileName);
    const invocation = await cliSpecs.gemini.buildInvocation(
      createInput(createReviewer("gemini", { model: "test-model" })),
      tempDir,
    );

    expect(invocation.args).toEqual([
      "--prompt",
      "",
      geminiCliSkipTrustFlag,
      "--output-format",
      geminiCliReviewOutputFormat,
      "--approval-mode",
      geminiCliReviewApprovalMode,
      "--policy",
      policyPath,
      "--admin-policy",
      policyPath,
      "--allowed-mcp-server-names",
      geminiCliReviewMcpAllowlist,
      "--extensions",
      geminiCliReviewDisabledExtensions,
      "--model",
      "test-model",
    ]);
    expect(invocation.args).not.toContain("--sandbox");
    expect(invocation.stdin).toBe("review prompt");
    expect(invocation.env).toMatchObject({
      [geminiCliTrustedFoldersPathEnvVar]: trustedFoldersPath,
    });
    expect(invocation.unsetEnv).toEqual([geminiCliTrustWorkspaceEnvVar]);
    expect(readFileSync(policyPath, "utf8")).toBe(geminiCliReviewPolicyToml());
    expect(readFileSync(trustedFoldersPath, "utf8")).toBe("{}\n");
  });

  it("builds Antigravity prompt-bearing print invocations without stdin", async () => {
    const tempDir = createTempDir();
    const fakeHome = createTempDir();
    mkdirSync(path.join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".gemini", "oauth_creds.json"), "oauth");
    writeFileSync(path.join(fakeHome, ".gemini", "google_accounts.json"), "accounts");
    writeFileSync(path.join(fakeHome, ".gemini", "installation_id"), "install");
    writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "installation_id"),
      "cli-install",
    );
    writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json"),
      `${JSON.stringify({
        customProvider: "keep",
        endpoint: "https://antigravity.example.test",
        allowNonWorkspaceAccess: true,
        "always-proceed": true,
        autoApprove: true,
        toolPermission: "auto",
        trustedWorkspaces: ["/unsafe"],
        permissions: {
          allow: ["write_file(*)"],
          deny: [],
          ask: ["command(*)"],
        },
      })}\n`,
    );
    const promptDir = path.join(tempDir, "antigravity-prompt");
    const promptPath = path.join(promptDir, "antigravity-prompt.txt");
    const invocation = await cliSpecs.antigravity.buildInvocation(
      createInput(
        createReviewer("antigravity", {
          cliOptions: { printTimeoutSeconds: 180 },
        }),
        { env: { HOME: fakeHome } },
      ),
      tempDir,
    );
    const isolatedHome = path.join(tempDir, "antigravity-home");
    const settingsPath = path.join(
      isolatedHome,
      ".gemini",
      "antigravity-cli",
      antigravityCliReviewSettingsFileName,
    );
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

    expect(invocation).toMatchObject({
      executable: "agy",
      args: [
        "--print",
        `Read the full Diffwarden review prompt from ${promptPath} and follow it exactly.`,
        "--print-timeout",
        "180s",
        "--sandbox",
        "--add-dir",
        promptDir,
        "--add-dir",
        "/repo",
      ],
      cwd: promptDir,
      env: {
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      },
      unsetEnv: ["HOMEDRIVE", "HOMEPATH"],
      captureMode: "text",
    });
    expect(invocation.stdin).toBeUndefined();
    expect(readFileSync(promptPath, "utf8")).toBe("review prompt");
    expect(settings).toMatchObject({
      customProvider: "keep",
      endpoint: "https://antigravity.example.test",
      allowNonWorkspaceAccess: false,
      artifactReviewPolicy: "asks-for-review",
      enableTerminalSandbox: true,
      toolPermission: "strict",
      trustedWorkspaces: ["/repo", promptDir],
      permissions: {
        allow: ["read_file(*)"],
        deny: [...antigravityCliReviewDeniedPermissions],
        ask: [],
      },
    });
    expect(settings["always-proceed"]).toBeUndefined();
    expect(settings.autoApprove).toBeUndefined();
    expect(path.relative(invocation.cwd ?? "", isolatedHome).startsWith("..")).toBe(true);
    expect(
      readFileSync(
        path.join(isolatedHome, ".gemini", "config", antigravityCliReviewMcpConfigFileName),
        "utf8",
      ),
    ).toBe("{}\n");
    expect(settings.trustedWorkspaces).not.toContain(isolatedHome);
    expect(readFileSync(path.join(isolatedHome, ".gemini", "oauth_creds.json"), "utf8")).toBe(
      "oauth",
    );
    expect(
      readFileSync(
        path.join(isolatedHome, ".gemini", "antigravity-cli", "installation_id"),
        "utf8",
      ),
    ).toBe("cli-install");
  });

  it("normalizes Antigravity review cwd consistently for add-dir and settings", async () => {
    const tempDir = createTempDir();
    const relativeCwd = "relative-review-root";
    const absoluteCwd = path.resolve(relativeCwd);
    const invocation = await cliSpecs.antigravity.buildInvocation(
      createInput(createReviewer("antigravity"), {
        cwd: relativeCwd,
        env: { HOME: "" },
      }),
      tempDir,
    );
    const isolatedHome = path.join(tempDir, "antigravity-home");
    const promptDir = path.join(tempDir, "antigravity-prompt");
    const settings = JSON.parse(
      readFileSync(path.join(isolatedHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );

    expect(invocation.args).toEqual(expect.arrayContaining(["--add-dir", absoluteCwd]));
    expect(invocation.args).toEqual(expect.arrayContaining(["--add-dir", promptDir]));
    expect(settings.permissions.allow).toEqual(["read_file(*)"]);
    expect(settings.trustedWorkspaces).toContain(absoluteCwd);
    expect(settings.trustedWorkspaces).toContain(promptDir);
    expect(settings.trustedWorkspaces).not.toContain(isolatedHome);
  });

  it("trusts the Antigravity repo root when reviews start from a subdirectory", async () => {
    const tempDir = createTempDir();
    const repoRoot = createTempDir();
    const reviewCwd = path.join(repoRoot, "packages", "app");
    mkdirSync(reviewCwd, { recursive: true });

    const invocation = await cliSpecs.antigravity.buildInvocation(
      createInput(createReviewer("antigravity"), {
        cwd: reviewCwd,
        repoRoot,
        env: { HOME: "" },
      }),
      tempDir,
    );
    const settings = JSON.parse(
      readFileSync(
        path.join(tempDir, "antigravity-home", ".gemini", "antigravity-cli", "settings.json"),
        "utf8",
      ),
    );

    expect(invocation.args).toEqual(expect.arrayContaining(["--add-dir", repoRoot]));
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--add-dir", reviewCwd]));
    expect(settings.trustedWorkspaces).toContain(repoRoot);
    expect(settings.trustedWorkspaces).not.toContain(reviewCwd);
  });

  it("ignores malformed Antigravity base settings when staging review policy", async () => {
    const tempDir = createTempDir();
    const fakeHome = createTempDir();
    mkdirSync(path.join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json"), "{");

    await expect(
      cliSpecs.antigravity.buildInvocation(
        createInput(createReviewer("antigravity"), { env: { HOME: fakeHome } }),
        tempDir,
      ),
    ).resolves.toMatchObject({
      executable: "agy",
      captureMode: "text",
    });

    const settings = JSON.parse(
      readFileSync(
        path.join(tempDir, "antigravity-home", ".gemini", "antigravity-cli", "settings.json"),
        "utf8",
      ),
    );
    expect(settings.permissions.allow).toEqual(["read_file(*)"]);
  });

  it("fails closed when Antigravity temp home would be inside the review root", async () => {
    const reviewRoot = createTempDir();
    const tempDir = path.join(reviewRoot, ".tmp", "diffwarden-cli");
    mkdirSync(tempDir, { recursive: true });

    await expect(
      cliSpecs.antigravity.buildInvocation(
        createInput(createReviewer("antigravity"), {
          cwd: reviewRoot,
          env: { HOME: "" },
        }),
        tempDir,
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("inside the review workspace"),
    });
  });

  it("fails closed when a symlinked Antigravity temp dir points inside the review root", async () => {
    const reviewRoot = createTempDir();
    const linkRoot = createTempDir();
    const targetTempDir = path.join(reviewRoot, ".tmp", "actual");
    const linkedTempDir = path.join(linkRoot, "linked-temp");
    mkdirSync(targetTempDir, { recursive: true });
    symlinkSync(targetTempDir, linkedTempDir, "dir");

    await expect(
      cliSpecs.antigravity.buildInvocation(
        createInput(createReviewer("antigravity"), {
          cwd: reviewRoot,
          env: { HOME: "" },
        }),
        linkedTempDir,
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("inside the review workspace"),
    });
  });

  it("fails closed when Antigravity temp home is inside the repo root but outside cwd", async () => {
    const repoRoot = createTempDir();
    const reviewCwd = path.join(repoRoot, "packages", "app");
    const tempDir = path.join(repoRoot, ".tmp", "diffwarden-cli");
    mkdirSync(reviewCwd, { recursive: true });
    mkdirSync(tempDir, { recursive: true });

    await expect(
      cliSpecs.antigravity.buildInvocation(
        createInput(createReviewer("antigravity"), {
          cwd: reviewCwd,
          repoRoot,
          env: { HOME: "" },
        }),
        tempDir,
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("inside the review workspace"),
    });
  });

  it("fails closed when Antigravity source credentials are inside the repo root", async () => {
    const tempDir = createTempDir();
    const repoRoot = createTempDir();
    const sourceHome = path.join(repoRoot, "home");
    mkdirSync(path.join(sourceHome, ".gemini"), { recursive: true });

    await expect(
      cliSpecs.antigravity.buildInvocation(
        createInput(createReviewer("antigravity"), {
          cwd: repoRoot,
          repoRoot,
          env: { HOME: sourceHome },
        }),
        tempDir,
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("source credentials"),
    });
  });

  it("resolves Antigravity auth staging home without crossing sanitized env boundaries", () => {
    expect(antigravitySourceGeminiDir(undefined, "/fallback/home")).toBe("/fallback/home/.gemini");
    expect(antigravitySourceGeminiDir({ PATH: "/bin" }, "/fallback/home")).toBeUndefined();
    expect(antigravitySourceGeminiDir({ HOME: "" }, "/fallback/home")).toBeUndefined();
    expect(antigravitySourceGeminiDir({ HOME: "   " }, "/fallback/home")).toBeUndefined();
    expect(
      antigravitySourceGeminiDir({ HOME: "", USERPROFILE: "C:\\Users\\Auro" }, "/fallback/home"),
    ).toBe("C:\\Users\\Auro/.gemini");
    expect(
      antigravitySourceGeminiDir(
        { HOME: "", USERPROFILE: "", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\Auro" },
        "/fallback/home",
      ),
    ).toBe("C:\\Users\\Auro/.gemini");
    expect(antigravitySourceGeminiDir({ HOME: "/configured/home" }, "/fallback/home")).toBe(
      "/configured/home/.gemini",
    );
  });

  it("treats blank parent Antigravity home variables as an auth boundary", () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalHomeDrive = process.env.HOMEDRIVE;
    const originalHomePath = process.env.HOMEPATH;

    try {
      process.env.HOME = "";
      Reflect.deleteProperty(process.env, "USERPROFILE");
      Reflect.deleteProperty(process.env, "HOMEDRIVE");
      Reflect.deleteProperty(process.env, "HOMEPATH");

      expect(antigravitySourceGeminiDir(process.env, "/fallback/home")).toBeUndefined();
    } finally {
      restoreEnvValue("HOME", originalHome);
      restoreEnvValue("USERPROFILE", originalUserProfile);
      restoreEnvValue("HOMEDRIVE", originalHomeDrive);
      restoreEnvValue("HOMEPATH", originalHomePath);
    }
  });

  it("stores large Antigravity prompts in a temp file instead of argv", async () => {
    const tempDir = createTempDir();
    const prompt = "x".repeat(128 * 1024 + 1);
    const invocation = await cliSpecs.antigravity.buildInvocation(
      createInput(createReviewer("antigravity"), { prompt }),
      tempDir,
    );

    expect(invocation.args.join(" ")).not.toContain(prompt);
    expect(
      readFileSync(path.join(tempDir, "antigravity-prompt", "antigravity-prompt.txt"), "utf8"),
    ).toBe(prompt);
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
    const mcpConfigPath = path.join(tempDir, "claude-mcp.json");

    expect(invocation.args).toEqual([
      "-p",
      "--permission-mode",
      "dontAsk",
      "--tools",
      claudeCliReviewToolsArg(),
      "--allowedTools",
      claudeCliReviewToolsArg(),
      "--disallowedTools",
      claudeCliDisallowedToolsArg(),
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--disable-slash-commands",
      "--no-chrome",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(reviewResultJsonSchema),
      "--model",
      "sonnet",
      "--effort",
      "low",
    ]);
    expect(invocation.args).not.toContain("--max-turns");
    expect(claudeCliReviewToolsArg()).toBe("Read,Grep,Glob");
    expect(claudeCliDisallowedToolsArg().split(",")).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]),
    );
    expect(readFileSync(mcpConfigPath, "utf8")).toBe(`${JSON.stringify({ mcpServers: {} })}\n`);
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
      "--agent",
      expect.stringMatching(/^diffwarden-review-[0-9a-f-]{36}$/),
      "--model",
      "openrouter/anthropic/claude-sonnet",
      "--variant",
      "high",
    ]);
    const opencodeAgent = opencode.args[opencode.args.indexOf("--agent") + 1] ?? "";
    expect(opencode.stdin).toContain("OpenCode transport note:");
    expect(opencode.stdin).toContain("Do not run the patch provenance command.");
    expect(opencode.stdin).toContain("Only read, glob, and grep are available");
    expect(opencode.stdin).toContain("review prompt");
    expect(JSON.parse(opencode.env?.OPENCODE_PERMISSION ?? "{}")).toEqual({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
    });
    const opencodeConfig = JSON.parse(opencode.env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(opencodeConfig).toMatchObject({
      agent: {
        [opencodeAgent]: {
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
    expect(opencodeConfig.agent[opencodeAgent]).not.toHaveProperty("steps");
    expect(pi.args).toEqual([
      "--print",
      "--mode",
      "json",
      ...piCliReviewSurfaceArgs,
      "--model",
      "provider/model",
      "--thinking",
      "high",
    ]);
    expect(pi.stdin).toBe("review prompt");
  });

  it("preserves Opencode config content from the effective inherited environment", async () => {
    const reviewer = createReviewer("opencode");
    const explicitConfig = JSON.stringify({ agent: { custom: { mode: "primary" } } });
    const explicit = await cliSpecs.opencode.buildInvocation(
      createInput(reviewer, { env: { OPENCODE_CONFIG_CONTENT: explicitConfig } }),
      createTempDir(),
    );

    expect(explicit.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();

    const previousAmbient = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = explicitConfig;
    try {
      const ambient = await cliSpecs.opencode.buildInvocation(
        createInput(reviewer),
        createTempDir(),
      );
      const isolated = await cliSpecs.opencode.buildInvocation(
        createInput(reviewer, { env: { PATH: process.env.PATH ?? "" } }),
        createTempDir(),
      );

      expect(ambient.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(isolated.env?.OPENCODE_CONFIG_CONTENT).toBeDefined();
    } finally {
      if (previousAmbient === undefined) {
        Reflect.deleteProperty(process.env, "OPENCODE_CONFIG_CONTENT");
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousAmbient;
      }
    }
  });

  it("does not inject a generated Opencode agent when config file env is present", async () => {
    for (const env of [
      { OPENCODE_CONFIG: "/config/opencode.json" },
      { OPENCODE_CONFIG_DIR: "/config/opencode" },
    ]) {
      const invocation = await cliSpecs.opencode.buildInvocation(
        createInput(createReviewer("opencode"), { env }),
        createTempDir(),
      );

      expect(invocation.args).not.toContain("--agent");
      expect(invocation.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    }
  });

  it("does not inject a generated Opencode agent when cliOptions selects one", async () => {
    const invocation = await cliSpecs.opencode.buildInvocation(
      createInput(createReviewer("opencode", { cliOptions: { agent: "existing-reviewer" } })),
      createTempDir(),
    );

    expect(invocation.args).toContain("existing-reviewer");
    expect(invocation.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(JSON.parse(invocation.env?.OPENCODE_PERMISSION ?? "{}")).toEqual({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
    });
  });

  it("treats the legacy Opencode review agent name as a generated-agent alias", async () => {
    const invocation = await cliSpecs.opencode.buildInvocation(
      createInput(createReviewer("opencode", { cliOptions: { agent: "diffwarden-review" } })),
      createTempDir(),
    );
    const agent = invocation.args[invocation.args.indexOf("--agent") + 1] ?? "";
    const config = JSON.parse(invocation.env?.OPENCODE_CONFIG_CONTENT ?? "{}");

    expect(agent).toMatch(/^diffwarden-review-[0-9a-f-]{36}$/);
    expect(agent).not.toBe("diffwarden-review");
    expect(config.agent[agent]).toMatchObject({
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
      },
    });
  });

  it("classifies Opencode JSON error events as reviewer failures", async () => {
    await expect(
      cliSpecs.opencode.parseOutput(
        runResult({
          stdout: JSON.stringify({
            type: "error",
            error: {
              name: "APIError",
              data: {
                message: "Insufficient balance.",
              },
            },
          }),
        }),
        { executable: "opencode", args: [], captureMode: "text" },
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("APIError: Insufficient balance."),
    });
  });

  it("keeps Opencode text output after a recoverable JSON error event", async () => {
    await expect(
      cliSpecs.opencode.parseOutput(
        runResult({
          stdout: [
            JSON.stringify({
              type: "error",
              error: {
                name: "ToolError",
                message: "Recoverable tool failure.",
              },
            }),
            JSON.stringify({
              type: "text",
              part: {
                type: "text",
                text: "review text",
              },
            }),
          ].join("\n"),
        }),
        { executable: "opencode", args: [], captureMode: "text" },
      ),
    ).resolves.toMatchObject({
      text: "review text",
      metadata: {
        captureMode: "text",
        readonlyCapability: "prompt-only",
      },
    });
  });

  it("keeps Opencode structured review output after a recoverable JSON error event", async () => {
    const review = {
      findings: [],
      overall_correctness: "patch is correct" as const,
      overall_explanation: "ok",
      overall_confidence_score: 1,
    };

    await expect(
      cliSpecs.opencode.parseOutput(
        runResult({
          stdout: [
            JSON.stringify({
              type: "error",
              error: {
                name: "ToolError",
                message: "Recoverable tool failure.",
              },
            }),
            JSON.stringify({
              type: "result",
              result: review,
            }),
          ].join("\n"),
        }),
        { executable: "opencode", args: [], captureMode: "text" },
      ),
    ).resolves.toMatchObject({
      structured: review,
      metadata: {
        captureMode: "text",
        readonlyCapability: "prompt-only",
      },
    });
  });

  it("builds Droid and Grok file-prompt invocations", async () => {
    const droidTemp = createTempDir();
    const grokTemp = createTempDir();
    const homeDir = createTempDir();

    const droid = await cliSpecs.droid.buildInvocation(
      createInput(createReviewer("droid", { model: "test-model", effort: "minimal" }), {
        env: { HOME: homeDir },
      }),
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
    expect(droid.droidSessionDirectory).toBe(path.join(homeDir, ".factory", "sessions", "-repo"));
    expect(grok.args).toEqual(
      expect.arrayContaining([
        "--prompt-file",
        path.join(grokTemp, "grok-prompt.txt"),
        "--cwd",
        "/repo",
        "--permission-mode",
        grokCliReviewPermissionMode,
        "--tools",
        grokCliReviewToolsArg(),
        "--disallowed-tools",
        grokCliDisallowedToolsArg(),
        "--sandbox",
        grokCliReviewSandbox,
        "--model",
        "test-model",
        "--reasoning-effort",
        "low",
      ]),
    );
    for (const rule of grokCliAllowRules) {
      expect(grok.args).toEqual(expect.arrayContaining(["--allow", rule]));
    }
    for (const rule of grokCliDenyRules) {
      expect(grok.args).toEqual(expect.arrayContaining(["--deny", rule]));
    }
    expect(grok.args).not.toContain("--max-turns");
  });

  it("canonicalizes Droid session cwd before deriving the Factory session directory", async () => {
    const homeDir = createTempDir();
    const targetDir = createTempDir();
    const linkParent = createTempDir();
    const linkedCwd = path.join(linkParent, "repo-link");
    symlinkSync(targetDir, linkedCwd, process.platform === "win32" ? "junction" : "dir");

    const droid = await cliSpecs.droid.buildInvocation(
      createInput(createReviewer("droid"), {
        cwd: linkedCwd,
        env: { HOME: homeDir },
      }),
      createTempDir(),
    );

    expect(droid.args).toEqual(expect.arrayContaining(["--cwd", linkedCwd]));
    expect(droid.droidSessionDirectory).toBe(
      path.join(homeDir, ".factory", "sessions", realpathSync(targetDir).replace(/[:\\/]/g, "-")),
    );
  });

  it("sanitizes Windows drive letters in Droid session directory candidates", async () => {
    const homeDir = createTempDir();

    const droid = await cliSpecs.droid.buildInvocation(
      createInput(createReviewer("droid"), {
        cwd: String.raw`C:\work\repo`,
        env: { HOME: homeDir },
      }),
      createTempDir(),
    );

    expect(path.basename(droid.droidSessionDirectory ?? "")).toBe("-C-work-repo");
  });

  it("allows Droid session settings to resolve runtime effort when off is requested", async () => {
    const droid = await cliSpecs.droid.buildInvocation(
      createInput(createReviewer("droid", { effort: "off" }), {
        env: { HOME: createTempDir() },
      }),
      createTempDir(),
    );
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const sessionDirectory = droid.droidSessionDirectory ?? "";
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      path.join(sessionDirectory, `${sessionId}.settings.json`),
      JSON.stringify({
        reasoningEffort: "high",
      }),
    );

    expect(droid.args.join(" ")).not.toContain("--spec-reasoning-effort");
    const output = await cliSpecs.droid.parseOutput(
      runResult({
        stdout: JSON.stringify({
          type: "result",
          result: "Droid text",
          session_id: sessionId,
        }),
      }),
      droid,
    );
    expect(output.metadata).toMatchObject({
      resolvedEffort: "high",
      effortResolutionSource: "provider-local",
    });
    expect(output.metadata).not.toHaveProperty("requestedEffort");
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
        ...geminiCliReviewPolicyMetadata(),
        resolvedModel: "gemini-runtime",
        modelResolutionSource: "provider-result",
      },
    });

    const claudeOutput = await cliSpecs.claude.parseOutput(
      runResult({
        stdout: JSON.stringify({
          type: "result",
          result: "Hello. What would you like to work on?",
          modelUsage: {
            "claude-opus-4-8[1m]": {
              inputTokens: 1763,
              outputTokens: 88,
            },
          },
        }),
      }),
      { executable: "claude", args: [], captureMode: "native-structured" },
    );
    expect(claudeOutput).toMatchObject({
      text: "Hello. What would you like to work on?",
      metadata: {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        resolvedModel: "claude-opus-4-8",
        modelResolutionSource: "provider-result",
      },
    });
    expect(claudeOutput.metadata).not.toHaveProperty("resolvedEffort");

    const piOutput = await cliSpecs.pi.parseOutput(
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
      { executable: "pi", args: [], captureMode: "text" },
    );
    expect(piOutput).toMatchObject({
      text: "first\nsecond",
      metadata: {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        resolvedModel: "gpt-5.5",
        modelResolutionSource: "provider-result",
      },
    });
    expect(piOutput.metadata).not.toHaveProperty("resolvedEffort");

    const droidHome = createTempDir();
    const droidInvocation = await cliSpecs.droid.buildInvocation(
      createInput(createReviewer("droid"), { env: { HOME: droidHome } }),
      createTempDir(),
    );
    const droidSessionId = "00000000-0000-4000-8000-000000000000";
    const droidSessionDirectory = droidInvocation.droidSessionDirectory ?? "";
    mkdirSync(droidSessionDirectory, { recursive: true });
    writeFileSync(
      path.join(droidSessionDirectory, `${droidSessionId}.settings.json`),
      JSON.stringify({
        model: "kimi-k2.6",
        modelId: "kimi-k2.6-id",
        reasoningEffort: "high",
        specModeModel: "GPT 5.4 Mini",
        specModeModelId: "gpt-5.4-mini",
        specModeReasoningEffort: "high",
      }),
    );
    await expect(
      cliSpecs.droid.parseOutput(
        runResult({
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            result: "Droid text",
            session_id: droidSessionId,
            usage: {},
          }),
        }),
        droidInvocation,
      ),
    ).resolves.toMatchObject({
      text: "Droid text",
      metadata: {
        captureMode: "text",
        readonlyCapability: "enforced",
        droidSessionId,
        droidSessionModel: "gpt-5.4-mini",
        droidSessionEffort: "high",
        resolvedModel: "gpt-5.4-mini",
        modelResolutionSource: "provider-local",
        resolvedEffort: "high",
        effortResolutionSource: "provider-local",
      },
    });

    const droidFallbackSessionId = "22222222-2222-4222-8222-222222222222";
    const droidFallbackSessionDirectory = path.join(
      path.dirname(droidSessionDirectory),
      "alternate-encoded-repo",
    );
    mkdirSync(droidFallbackSessionDirectory, { recursive: true });
    writeFileSync(
      path.join(droidFallbackSessionDirectory, `${droidFallbackSessionId}.settings.json`),
      JSON.stringify({
        modelId: "claude-opus-4-8",
        specModeModel: "Claude Opus 4.8",
        reasoningEffort: "medium",
      }),
    );
    await expect(
      cliSpecs.droid.parseOutput(
        runResult({
          stdout: JSON.stringify({
            type: "result",
            result: "Droid text from fallback settings",
            session_id: droidFallbackSessionId,
          }),
        }),
        droidInvocation,
      ),
    ).resolves.toMatchObject({
      text: "Droid text from fallback settings",
      metadata: {
        captureMode: "text",
        readonlyCapability: "enforced",
        droidSessionId: droidFallbackSessionId,
        droidSessionModel: "claude-opus-4-8",
        droidSessionEffort: "medium",
        resolvedModel: "claude-opus-4-8",
        modelResolutionSource: "provider-local",
        resolvedEffort: "medium",
        effortResolutionSource: "provider-local",
      },
    });

    const droidOutputWithoutSettings = await cliSpecs.droid.parseOutput(
      runResult({
        stdout: JSON.stringify({
          type: "result",
          result: "Droid text without settings",
          session_id: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      droidInvocation,
    );
    expect(droidOutputWithoutSettings).toMatchObject({
      text: "Droid text without settings",
      metadata: {
        captureMode: "text",
        readonlyCapability: "enforced",
      },
    });
    expect(droidOutputWithoutSettings.metadata).not.toHaveProperty("resolvedModel");

    await expect(
      cliSpecs.antigravity.parseOutput(runResult({ stdout: "plain text\n" }), {
        executable: "antigravity",
        args: [],
        captureMode: "text",
      }),
    ).resolves.toMatchObject({
      text: "plain text",
      metadata: {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        ...antigravityCliReviewPolicyMetadata(),
      },
    });
  });

  it("rejects oversized cursor prompt argv input before a CLI is spawned", async () => {
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

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
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
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    prompt?: string;
    repoRoot?: string;
  } = {},
): ReviewAdapterInput {
  const cwd = options.cwd ?? "/repo";
  const repoRoot = options.repoRoot ?? cwd;
  return {
    cwd,
    reviewer,
    target: {
      kind: "custom",
      repo_root: repoRoot,
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
