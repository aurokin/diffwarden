import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copilotReviewAvailableTools,
  copilotReviewExcludedTools,
  copilotSdkReviewAvailableTools,
  createCopilotSdkPermissionHandler,
} from "../src/adapters/copilot-tool-policy.js";
import { createCopilotAdapter } from "../src/adapters/copilot.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";
import { isIntegrationDisabled } from "./integration.js";
import {
  type LiveFixture,
  createLiveAdapterInput,
  createLiveFixture,
  expectFixtureReadOnly,
  expectLiveAdapterOutput,
} from "./live/helpers.js";

describe("createCopilotAdapter", () => {
  it("loads the installed Copilot SDK entrypoint", async () => {
    await expect(import("@github/copilot-sdk")).resolves.toMatchObject({
      CopilotClient: expect.any(Function),
      RuntimeConnection: expect.any(Object),
    });
  });

  it("preflights the SDK path with read/search policy metadata", async () => {
    const executable = createCopilotRuntimeFixture();
    const { adapter } = createMockCopilotAdapter();
    const preflight = await adapter.preflight?.({
      cwd: "/repo",
      reviewer: createReviewer({
        model: "gpt-test",
        effort: "minimal",
        sdkOptions: {
          baseDirectory: "/copilot-home",
          executable,
        },
      }),
      readonly: true,
      env: {},
    });

    expect(preflight?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sdk", status: "passed" }),
        expect.objectContaining({ name: "readonly", status: "passed" }),
        expect.objectContaining({ name: "tools", status: "passed" }),
      ]),
    );
    expect(preflight?.metadata).toMatchObject({
      transport: "sdk",
      preferredCaptureMode: "text",
      readonlyCapability: "tool-restricted",
      sdkVersion: "1.0.0-test",
      copilotToolPolicy: "read-search-allowlist",
      copilotAllowedTools: [...copilotReviewAvailableTools],
      copilotSdkAllowedTools: [...copilotSdkReviewAvailableTools],
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      requestedEffort: "minimal",
      resolvedEffort: "low",
      effortResolutionSource: "adapter-selection",
      copilotBaseDirectory: "/copilot-home",
      copilotBaseDirectorySource: "config",
      executable,
      resolvedExecutable: executable,
    });
  });

  it("fails preflight when a configured SDK executable cannot be resolved", async () => {
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: "/repo",
        reviewer: createReviewer({
          sdkOptions: {
            executable: "missing-copilot-runtime",
          },
        }),
        readonly: true,
        env: {
          HOME: "/home/test",
          PATH: "",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("CLI executable not found: missing-copilot-runtime"),
    });
  });

  it("fails preflight when a configured SDK executable is not a Copilot runtime", async () => {
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: "/repo",
        reviewer: createReviewer({
          sdkOptions: {
            executable: process.execPath,
          },
        }),
        readonly: true,
        env: {
          HOME: "/home/test",
        },
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      message: expect.stringContaining("must be a Copilot runtime binary or readable .js"),
    });
  });

  it("accepts readable JavaScript SDK runtime overrides without executable bits", async () => {
    const runtimeDir = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-js-runtime-"));
    const runtime = path.join(runtimeDir, "index.js");
    writeFileSync(runtime, "export {};\n", "utf8");
    chmodSync(runtime, 0o644);
    const { adapter } = createMockCopilotAdapter();

    const preflight = await adapter.preflight?.({
      cwd: "/repo",
      reviewer: createReviewer({
        sdkOptions: {
          baseDirectory: "/copilot-home",
          executable: runtime,
        },
      }),
      readonly: true,
      env: {},
    });

    expect(preflight?.metadata).toMatchObject({
      executable: runtime,
      resolvedExecutable: runtime,
      copilotRuntimeSource: "config",
    });
  });

  it("resolves relative JavaScript SDK runtime overrides from the caller cwd", async () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-runtime-repo-")));
    const cwd = path.join(repo, "packages", "app");
    const runtimeDir = realpathSync(
      mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-runtime-")),
    );
    const runtime = path.join(runtimeDir, "index.js");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(runtime, "export {};\n", "utf8");
    chmodSync(runtime, 0o644);
    const { adapter } = createMockCopilotAdapter();

    const preflight = await adapter.preflight?.({
      cwd,
      repoRoot: repo,
      reviewer: createReviewer({
        sdkOptions: {
          baseDirectory: "/copilot-home",
          executable: path.relative(cwd, runtime),
        },
      }),
      readonly: true,
      env: {},
    });

    expect(preflight?.metadata).toMatchObject({
      resolvedExecutable: runtime,
      copilotRuntimeSource: "config",
    });
  });

  it("launches readable JavaScript SDK runtime overrides through Node", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-sdk-home-"));
    const runtimeDir = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-js-runtime-"));
    const runtime = path.join(runtimeDir, "index.js");
    writeFileSync(runtime, "export {};\n", "utf8");
    chmodSync(runtime, 0o644);
    const { adapter, calls } = createMockCopilotAdapter({
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    await adapter.run(
      input({
        reviewer: createReviewer({
          sdkOptions: {
            executable: runtime,
          },
        }),
        env: {
          HOME: home,
        },
      }),
    );

    expect(calls.runtimeConnectionOptions).toEqual({
      path: process.execPath,
      args: [runtime, "--no-auto-update", "--no-remote"],
    });
  });

  it("fails preflight for Windows command-script SDK runtime overrides", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-sdk-home-"));
    const runtimeDir = mkdtempSync(path.join(tmpdir(), "diffwarden copilot runtime "));
    const runtime = path.join(runtimeDir, "copilot.cmd");
    writeFileSync(runtime, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(runtime, 0o755);
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: "/repo",
        repoRoot: "/repo",
        reviewer: createReviewer({
          sdkOptions: {
            executable: runtime,
          },
        }),
        readonly: true,
        env: {
          HOME: home,
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("command-script runtimes"),
    });
  });

  it("fails preflight when explicit SDK env cannot resolve a Copilot base directory", async () => {
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: "/repo",
        reviewer: createReviewer(),
        readonly: true,
        env: {
          PATH: "/usr/bin",
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK base directory could not be resolved"),
    });
  });

  it("fails preflight when the SDK base directory is inside the review workspace", async () => {
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: "/repo",
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/repo/.copilot",
          },
        }),
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK base directory resolved inside"),
    });
  });

  it("fails preflight when a dot-dot-prefixed SDK base directory is inside the review workspace", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-dotdot-base-"));
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: repo,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: path.join(repo, "..copilot"),
          },
        }),
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK base directory resolved inside"),
    });
  });

  it("fails preflight when the SDK base directory is inside the repo root from a subdirectory", async () => {
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: "/repo/packages/app",
        repoRoot: "/repo",
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/repo/.copilot",
          },
        }),
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK base directory resolved inside"),
    });
  });

  it("discovers the repo root for SDK preflight checks from a subdirectory", async () => {
    const repo = realpathSync(
      mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-preflight-root-")),
    );
    const cwd = path.join(repo, "packages/app");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: path.join(repo, ".copilot"),
          },
        }),
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK base directory resolved inside"),
    });
  });

  it("resolves relative SDK base directory config from the caller cwd", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-base-repo-")));
    const cwd = path.join(repo, "packages", "app");
    const baseDirectory = realpathSync(
      mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-base-")),
    );
    mkdirSync(cwd, { recursive: true });

    const preflight = await adapter.preflight?.({
      cwd,
      repoRoot: repo,
      reviewer: createReviewer({
        sdkOptions: {
          baseDirectory: path.relative(cwd, baseDirectory),
        },
      }),
      readonly: true,
      env: {},
    });

    expect(preflight?.metadata).toMatchObject({
      copilotBaseDirectory: baseDirectory,
      copilotBaseDirectorySource: "config",
    });
  });

  it("fails preflight when a relative SDK base directory resolves inside the caller cwd repo", async () => {
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: "/repo",
        repoRoot: "/repo",
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: ".copilot-diffwarden",
          },
        }),
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK base directory resolved inside"),
    });
  });

  it("fails preflight when SDK GitHub CLI auth dirs resolve inside the repo root", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-auth-repo-"));
    const ghConfigDir = path.join(repo, ".gh-config");
    const xdgConfigHome = path.join(repo, ".xdg");
    const home = path.join(repo, "home");
    for (const hostsDir of [
      ghConfigDir,
      path.join(xdgConfigHome, "gh"),
      path.join(home, ".config", "gh"),
    ]) {
      mkdirSync(hostsDir, { recursive: true });
      writeFileSync(
        path.join(hostsDir, "hosts.yml"),
        "github.com:\n  oauth_token: token\n",
        "utf8",
      );
    }
    const cases: NodeJS.ProcessEnv[] = [
      { GH_CONFIG_DIR: ghConfigDir },
      { XDG_CONFIG_HOME: xdgConfigHome },
      { HOME: home },
    ];

    for (const env of cases) {
      await expect(
        adapter.preflight?.({
          cwd: path.join(repo, "packages", "app"),
          repoRoot: repo,
          reviewer: createReviewer({
            sdkOptions: {
              baseDirectory: "/copilot-home",
            },
          }),
          readonly: true,
          env,
        }),
      ).rejects.toMatchObject({
        code: "reviewer_failed",
        message: expect.stringContaining("Copilot SDK GitHub CLI auth state resolved inside"),
      });
    }
  });

  it("allows SDK GitHub CLI auth candidates inside the repo when no hosts files are copied", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-empty-auth-repo-"));

    await expect(
      adapter.preflight?.({
        cwd: path.join(repo, "packages", "app"),
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/copilot-home",
          },
        }),
        readonly: true,
        env: {
          HOME: path.join(repo, "home"),
          XDG_CONFIG_HOME: path.join(repo, ".xdg"),
        },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects relative SDK GitHub CLI auth env paths that resolve inside the caller cwd repo", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-relative-auth-repo-"));
    const ghConfigDir = path.join(repo, ".config", "gh");
    mkdirSync(ghConfigDir, { recursive: true });
    writeFileSync(
      path.join(ghConfigDir, "hosts.yml"),
      "github.com:\n  oauth_token: token\n",
      "utf8",
    );

    await expect(
      adapter.preflight?.({
        cwd: repo,
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/copilot-home",
          },
        }),
        readonly: true,
        env: {
          GH_CONFIG_DIR: ".config/gh",
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK GitHub CLI auth state resolved inside"),
    });
  });

  it("allows SDK GitHub CLI auth from external XDG when lower-priority HOME is inside the repo", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-xdg-auth-repo-"));
    const xdgConfigHome = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-xdg-auth-"));
    mkdirSync(path.join(xdgConfigHome, "gh"), { recursive: true });
    writeFileSync(
      path.join(xdgConfigHome, "gh", "hosts.yml"),
      "github.com:\n  oauth_token: token\n",
      "utf8",
    );

    await expect(
      adapter.preflight?.({
        cwd: path.join(repo, "packages", "app"),
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/copilot-home",
          },
        }),
        readonly: true,
        env: {
          HOME: path.join(repo, "home"),
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      }),
    ).resolves.toBeDefined();
  });

  it("allows SDK GitHub CLI auth from external GH_CONFIG_DIR when HOME is inside the repo", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-gh-config-repo-"));
    const ghConfigDir = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-gh-config-"));
    writeFileSync(
      path.join(ghConfigDir, "hosts.yml"),
      "github.com:\n  oauth_token: token\n",
      "utf8",
    );

    await expect(
      adapter.preflight?.({
        cwd: path.join(repo, "packages", "app"),
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/copilot-home",
          },
        }),
        readonly: true,
        env: {
          GH_CONFIG_DIR: ghConfigDir,
          HOME: path.join(repo, "home"),
        },
      }),
    ).resolves.toBeDefined();
  });

  it("checks HOME GitHub CLI auth fallback when SDK XDG config has no hosts file", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-fallback-auth-repo-"));
    const home = path.join(repo, "home");
    const homeGhConfigDir = path.join(home, ".config", "gh");
    mkdirSync(homeGhConfigDir, { recursive: true });
    writeFileSync(
      path.join(homeGhConfigDir, "hosts.yml"),
      "github.com:\n  oauth_token: token\n",
      "utf8",
    );

    await expect(
      adapter.preflight?.({
        cwd: path.join(repo, "packages", "app"),
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/copilot-home",
          },
        }),
        readonly: true,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: "/safe/.config",
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK GitHub CLI auth state resolved inside"),
    });
  });

  it("fails preflight when SDK GitHub CLI auth is inside a dot-dot-prefixed repo path", async () => {
    const { adapter } = createMockCopilotAdapter();
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-dotdot-auth-"));
    const home = path.join(repo, "..home");
    const homeGhConfigDir = path.join(home, ".config", "gh");
    mkdirSync(homeGhConfigDir, { recursive: true });
    writeFileSync(
      path.join(homeGhConfigDir, "hosts.yml"),
      "github.com:\n  oauth_token: token\n",
      "utf8",
    );

    await expect(
      adapter.preflight?.({
        cwd: repo,
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            baseDirectory: "/copilot-home",
          },
        }),
        readonly: true,
        env: {
          HOME: home,
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK GitHub CLI auth state resolved inside"),
    });
  });

  it("fails preflight when the SDK runtime resolves inside the review workspace", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-runtime-"));
    const executable = path.join(repo, "copilot-runtime");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(executable, 0o755);
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: repo,
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            executable,
          },
        }),
        readonly: true,
        env: {
          HOME: "/home/test",
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK runtime resolved inside"),
    });
  });

  it("fails preflight when a dot-dot-prefixed SDK runtime resolves inside the review workspace", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-dotdot-runtime-"));
    const executable = path.join(repo, "..copilot-runtime", "copilot-runtime");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(executable, 0o755);
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.preflight?.({
        cwd: repo,
        repoRoot: repo,
        reviewer: createReviewer({
          sdkOptions: {
            executable,
          },
        }),
        readonly: true,
        env: {
          HOME: "/home/test",
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK runtime resolved inside"),
    });
  });

  it("fails preflight when the bundled SDK runtime resolves inside the review workspace", async () => {
    const { adapter } = createMockCopilotAdapter({
      bundledRuntimeExecutable: "/repo/node_modules/@github/copilot/index.js",
    });

    await expect(
      adapter.preflight?.({
        cwd: "/repo",
        repoRoot: "/repo",
        reviewer: createReviewer(),
        readonly: true,
        env: {
          HOME: "/home/test",
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK runtime resolved inside"),
    });
  });

  it("reports the installed Copilot SDK package version in default preflight metadata", async () => {
    const preflight = await createCopilotAdapter().preflight?.({
      cwd: "/repo",
      reviewer: createReviewer(),
      readonly: true,
      env: {
        HOME: "/home/test",
      },
    });

    expect(preflight?.metadata?.sdkVersion).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+/));
    expect(preflight?.metadata).toMatchObject({
      copilotRuntimeSource: "sdk-bundled",
      resolvedExecutable: expect.stringContaining(path.join("@github", "copilot", "index.js")),
    });
    expect(preflight?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runtime",
          status: "passed",
          detail: expect.stringContaining("Copilot SDK bundled runtime resolved: "),
        }),
      ]),
    );
  });

  it("runs Copilot SDK sessions in empty mode with read/search tool allowlisting", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-sdk-home-"));
    const sourceCopilotHome = path.join(home, ".copilot");
    mkdirSync(sourceCopilotHome, { recursive: true });
    writeFileSync(
      path.join(sourceCopilotHome, "config.json"),
      `{
        // Copilot config is commonly JSONC; auth staging should preserve tokens.
        "copilotTokens": null,
        "lastLoggedInUser": { "host": "github.com", "login": "octo" },
        "loggedInUsers": [],
        "staff": {},
        "installedPlugins": [{ "name": "unsafe" }],
      }`,
      "utf8",
    );
    writeFileSync(
      path.join(sourceCopilotHome, "config"),
      [
        'copilotTokens={"github.com":"legacy-token"}',
        'lastLoggedInUser={"host":"github.com","login":"legacy"}',
        'loggedInUsers=[{"host":"github.com","login":"legacy"}]',
        "staff=true",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(sourceCopilotHome, "mcp-config.json"),
      JSON.stringify({ mcpServers: { unsafe: { command: "node" } } }),
      "utf8",
    );
    const callsRef: { current?: MockCopilotCalls } = {};
    const stagedFiles: Record<string, string> = {};
    const { adapter, calls } = createMockCopilotAdapter({
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
      model: "gpt-runtime",
      effort: "high",
      afterCreateSession: () => {
        const baseDirectory = callsRef.current?.clientOptions?.baseDirectory;
        if (baseDirectory === undefined) {
          throw new Error("Copilot staged base directory was not captured");
        }
        stagedFiles.config = readFileSync(path.join(baseDirectory, "config.json"), "utf8");
        stagedFiles.mcpConfig = readFileSync(path.join(baseDirectory, "mcp-config.json"), "utf8");
        stagedFiles.settings = readFileSync(path.join(baseDirectory, "settings.json"), "utf8");
      },
    });
    callsRef.current = calls;
    const executable = createCopilotRuntimeFixture();
    const reviewer = createReviewer({
      model: "gpt-requested",
      effort: "high",
      sdkOptions: { executable },
    });

    const output = await adapter.run(
      input({
        reviewer,
        env: {
          HOME: home,
          PATH: path.dirname(process.execPath),
          COPILOT_ALLOW_ALL: "true",
          COPILOT_CACHE_HOME: path.join("/repo", ".cache"),
          COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/unsafe",
          GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: "true",
          HOMEDRIVE: "C:",
          HOMEPATH: "\\Users\\unsafe",
          NODE_OPTIONS: "--require /repo/hook.js",
          NODE_PATH: "/repo/node_modules",
        },
      }),
    );

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
    expect(output.usage).toMatchObject({
      model: "gpt-runtime",
      reasoningEffort: "high",
    });
    expect(output.metadata).toMatchObject({
      transport: "sdk",
      captureMode: "text",
      readonlyCapability: "tool-restricted",
      sdkVersion: "1.0.0-test",
      copilotToolPolicy: "read-search-allowlist",
      copilotSourceBaseDirectory: sourceCopilotHome,
      executable,
      resolvedExecutable: executable,
      requestedModel: "gpt-requested",
      resolvedModel: "gpt-runtime",
      modelResolutionSource: "provider-result",
      requestedEffort: "high",
      resolvedEffort: "high",
      effortResolutionSource: "provider-result",
    });
    expect(output.metadata?.copilotBaseDirectory).toEqual(
      expect.stringContaining("diffwarden-copilot-sdk-"),
    );

    expect(calls.clientOptions).toMatchObject({
      mode: "empty",
      workingDirectory: "/repo",
    });
    expect(calls.clientOptions?.baseDirectory).toBe(output.metadata?.copilotBaseDirectory);
    expect(calls.clientOptions?.telemetry).toBeUndefined();
    expect(calls.clientOptions?.env?.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(calls.clientOptions?.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined();
    expect(calls.clientOptions?.env?.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS).toBeUndefined();
    expect(calls.clientOptions?.env?.NODE_OPTIONS).toBeUndefined();
    expect(calls.clientOptions?.env?.NODE_PATH).toBeUndefined();
    expect(calls.clientOptions?.env?.COPILOT_HOME).toBe(calls.clientOptions?.baseDirectory);
    expect(calls.clientOptions?.env?.GH_CONFIG_DIR).toBe(
      path.join(path.dirname(calls.clientOptions?.baseDirectory ?? ""), "gh"),
    );
    expect(calls.clientOptions?.env?.COPILOT_CACHE_HOME).toBe(
      path.join(
        path.dirname(calls.clientOptions?.baseDirectory ?? ""),
        "home",
        ".cache",
        "copilot",
      ),
    );
    expect(calls.clientOptions?.env?.HOME).toBe(
      path.join(path.dirname(calls.clientOptions?.baseDirectory ?? ""), "home"),
    );
    expect(calls.clientOptions?.env?.USERPROFILE).toBe(calls.clientOptions?.env?.HOME);
    expect(calls.clientOptions?.env?.XDG_CONFIG_HOME).toBe(
      path.join(calls.clientOptions?.env?.HOME ?? "", ".config"),
    );
    expect(calls.clientOptions?.env?.APPDATA).toBe(
      path.join(calls.clientOptions?.env?.HOME ?? "", "AppData", "Roaming"),
    );
    expect(calls.clientOptions?.env?.LOCALAPPDATA).toBe(
      path.join(calls.clientOptions?.env?.HOME ?? "", "AppData", "Local"),
    );
    expect(calls.clientOptions?.env?.HOMEDRIVE).toBeUndefined();
    expect(calls.clientOptions?.env?.HOMEPATH).toBeUndefined();
    expect(calls.clientOptions?.env?.COPILOT_AUTO_UPDATE).toBe("false");
    expect(calls.clientOptions?.env?.TMPDIR).toBe(
      path.join(path.dirname(calls.clientOptions?.baseDirectory ?? ""), "tool-output-temp"),
    );
    expect(calls.clientOptions?.env?.TMP).toBe(calls.clientOptions?.env?.TMPDIR);
    expect(calls.clientOptions?.env?.TEMP).toBe(calls.clientOptions?.env?.TMPDIR);
    expect(stagedFiles.config).toBeDefined();
    expect(JSON.parse(stagedFiles.config ?? "{}")).toEqual({
      copilotTokens: { "github.com": "legacy-token" },
      lastLoggedInUser: { host: "github.com", login: "octo" },
      loggedInUsers: [{ host: "github.com", login: "legacy" }],
      staff: true,
    });
    expect(stagedFiles.mcpConfig).toBe("{}\n");
    expect(stagedFiles.settings).toBeDefined();
    expect(JSON.parse(stagedFiles.settings ?? "{}")).toMatchObject({
      disabledMcpServers: ["*"],
      enabledMcpServers: [],
      enabledPlugins: {},
    });
    expect(calls.runtimeConnectionOptions).toEqual({
      path: executable,
      args: ["--no-auto-update", "--no-remote"],
    });
    expect(calls.sessionConfig).toMatchObject({
      clientName: "diffwarden",
      workingDirectory: "/repo",
      availableTools: [...copilotSdkReviewAvailableTools],
      excludedTools: [...copilotReviewExcludedTools],
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      coauthorEnabled: false,
      manageScheduleEnabled: false,
      requestExtensions: false,
      enableMcpApps: false,
      mcpServers: {},
      enableSkills: false,
      installedPlugins: [],
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      customAgents: [],
      skillDirectories: [],
      pluginDirectories: [],
      instructionDirectories: [],
      defaultAgent: {
        excludedTools: [...copilotReviewExcludedTools],
      },
      streaming: false,
      includeSubAgentStreamingEvents: false,
      mcpOAuthTokenStorage: "in-memory",
      enableSessionTelemetry: false,
      infiniteSessions: { enabled: false },
      model: "gpt-requested",
      reasoningEffort: "high",
    });
    expect(calls.sessionConfig?.disabledSkills).toEqual(["*", "customize-cloud-agent"]);
    expect(calls.sendOptions).toEqual({ prompt: "review prompt" });
    expect(calls.usedSendAndWait).not.toBe(true);
    await expect(
      calls.sessionConfig?.onPermissionRequest?.(
        { kind: "read", path: "/repo/file.ts", intention: "" },
        { sessionId: "test" },
      ),
    ).resolves.toEqual({
      kind: "approve-once",
    });
    const toolOutputTempDir = calls.clientOptions?.env?.TMPDIR;
    if (toolOutputTempDir === undefined) {
      throw new Error("Copilot SDK tool-output temp dir was not captured");
    }
    await expect(
      calls.sessionConfig?.onPermissionRequest?.(
        { kind: "read", path: path.join(toolOutputTempDir, "large-output.txt"), intention: "" },
        { sessionId: "test" },
      ),
    ).resolves.toEqual({
      kind: "approve-once",
    });
    await expect(
      calls.sessionConfig?.onPermissionRequest?.(
        { kind: "read", path: "/outside/file.ts", intention: "" },
        { sessionId: "test" },
      ),
    ).resolves.toMatchObject({
      kind: "reject",
    });
    await expect(
      calls.sessionConfig?.onPermissionRequest?.(
        {
          kind: "write",
          fileName: "/repo/file.ts",
          diff: "",
          intention: "",
          canOfferSessionApproval: false,
        },
        { sessionId: "test" },
      ),
    ).resolves.toMatchObject({ kind: "reject" });
  });

  it("stages Copilot SDK auth from relative paths resolved from the caller cwd", async () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-rel-repo-")));
    const cwd = path.join(repo, "packages", "app");
    const sourceCopilotHome = realpathSync(
      mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-rel-home-")),
    );
    const sourceGhConfigDir = path.join(
      realpathSync(mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-rel-gh-"))),
      "gh",
    );
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sourceCopilotHome, { recursive: true });
    mkdirSync(sourceGhConfigDir, { recursive: true });
    writeFileSync(
      path.join(sourceCopilotHome, "config.json"),
      JSON.stringify({
        copilotTokens: { "github.com": "relative-token" },
        lastLoggedInUser: { host: "github.com", login: "relative" },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(sourceGhConfigDir, "hosts.yml"),
      "github.com:\n  oauth_token: relative-gh-token\n",
      "utf8",
    );
    const stagedFiles: {
      config?: string;
      hosts?: string;
      homeHosts?: string;
      appDataHosts?: string;
    } = {};
    const callsRef: { current?: MockCopilotCalls } = {};
    const { adapter, calls } = createMockCopilotAdapter({
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
      afterCreateSession: () => {
        const baseDirectory = callsRef.current?.clientOptions?.baseDirectory;
        const ghConfigDir = callsRef.current?.clientOptions?.env?.GH_CONFIG_DIR;
        const home = callsRef.current?.clientOptions?.env?.HOME;
        const appData = callsRef.current?.clientOptions?.env?.APPDATA;
        if (
          baseDirectory === undefined ||
          ghConfigDir === undefined ||
          home === undefined ||
          appData === undefined
        ) {
          throw new Error("Copilot staged SDK auth paths were not captured");
        }
        stagedFiles.config = readFileSync(path.join(baseDirectory, "config.json"), "utf8");
        stagedFiles.hosts = readFileSync(path.join(ghConfigDir, "hosts.yml"), "utf8");
        stagedFiles.homeHosts = readFileSync(path.join(home, ".config", "gh", "hosts.yml"), "utf8");
        stagedFiles.appDataHosts = readFileSync(
          path.join(appData, "GitHub CLI", "hosts.yml"),
          "utf8",
        );
      },
    });
    callsRef.current = calls;

    const output = await adapter.run(
      input({
        cwd,
        repoRoot: repo,
        env: {
          COPILOT_HOME: path.relative(cwd, sourceCopilotHome),
          GH_CONFIG_DIR: path.relative(cwd, sourceGhConfigDir),
        },
      }),
    );

    expect(output.metadata).toMatchObject({
      copilotSourceBaseDirectory: sourceCopilotHome,
    });
    expect(JSON.parse(stagedFiles.config ?? "{}")).toEqual({
      copilotTokens: { "github.com": "relative-token" },
      lastLoggedInUser: { host: "github.com", login: "relative" },
    });
    for (const hosts of [stagedFiles.hosts, stagedFiles.homeHosts, stagedFiles.appDataHosts]) {
      expect(hosts).toBe("github.com:\n  oauth_token: relative-gh-token\n");
    }
  });

  it("does not start a Copilot session when the SDK base directory is inside the repo root", async () => {
    const { adapter, calls } = createMockCopilotAdapter();

    await expect(
      adapter.run(
        input({
          env: {
            HOME: "/repo",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("Copilot SDK base directory resolved inside"),
    });

    expect(calls.clientOptions).toBeUndefined();
    expect(calls.sessionConfig).toBeUndefined();
  });

  it("ignores session idle events emitted before the review prompt is sent", async () => {
    const { adapter, calls } = createMockCopilotAdapter({
      emitInitialIdle: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input());

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
    expect(calls.sendOptions).toEqual({ prompt: "review prompt" });
  });

  it("ignores stale session idle events emitted while the review prompt send is pending", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitIdleWhileSendPendingBeforeReview: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input());

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("resolves when send-pending idle is followed by review text without another idle", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitSendPendingIdleBeforeReviewWithoutTrailingIdle: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input({ timeoutMs: 2_000 }));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("ignores session idle events emitted after send resolves but before review text arrives", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitIdleAfterSendBeforeReview: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input());

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("accepts review text emitted shortly after an idle event without output", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitDelayedReviewAfterIdleMs: 100,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input({ timeoutMs: 2_000 }));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("waits for review text when usage arrives before an idle event", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitUsageBeforeIdleBeforeReview: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input({ timeoutMs: 2_000 }));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("resolves when review text arrives after an early idle without another idle", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitIdleBeforeReviewWithoutTrailingIdle: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input({ timeoutMs: 2_000 }));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("ignores sub-agent lifecycle events before the root review completes", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitSubagentLifecycleBeforeReview: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input());

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("ignores sub-agent usage events when reporting root review metadata", async () => {
    const { adapter } = createMockCopilotAdapter({
      model: "gpt-root",
      effort: "high",
      emitSubagentUsageAfterRootUsage: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input());

    expect(output.usage).toMatchObject({
      model: "gpt-root",
      reasoningEffort: "high",
    });
    expect(output.metadata).toMatchObject({
      resolvedModel: "gpt-root",
      resolvedEffort: "high",
    });
  });

  it("fails when Copilot remains idle without producing output", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitIdleWithoutReview: true,
    });

    await expect(adapter.run(input({ timeoutMs: 1_000 }))).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("became idle without producing an assistant message"),
    });
  });

  it("roots Copilot SDK runtime and read permissions at the review repo root", async () => {
    const { adapter, calls } = createMockCopilotAdapter();

    await adapter.run(
      input({
        cwd: "/repo/packages/app",
        repoRoot: "/repo",
      }),
    );

    expect(calls.clientOptions?.workingDirectory).toBe("/repo");
    expect(calls.sessionConfig?.workingDirectory).toBe("/repo");
    await expect(
      calls.sessionConfig?.onPermissionRequest?.(
        { kind: "read", path: "/repo/other/file.ts", intention: "" },
        { sessionId: "test" },
      ),
    ).resolves.toEqual({
      kind: "approve-once",
    });
  });

  it("ignores recoverable model-call session errors before idle", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitRecoverableModelCallError: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input());

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("ignores recoverable permission session errors before a valid review", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitRecoverablePermissionSessionError: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    const output = await adapter.run(input());

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "copilot ok",
    });
  });

  it("surfaces Copilot SDK session errors even when review text arrives later", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitNonRecoverableSessionError: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("denied then recovered"),
    });
  });

  it("surfaces Copilot SDK session errors even when review text arrives asynchronously", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitNonRecoverableSessionErrorBeforeAsyncReview: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("denied then recovered asynchronously"),
    });
  });

  it("surfaces Copilot SDK session errors emitted after review text but before idle", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitNonRecoverableSessionErrorAfterReviewBeforeIdle: true,
      content: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "copilot ok",
        overall_confidence_score: 1,
      }),
    });

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("failed after provisional review"),
    });
  });

  it("surfaces Copilot SDK fatal session errors without waiting for idle", async () => {
    const { adapter } = createMockCopilotAdapter({
      emitOnlyNonRecoverableSessionError: true,
    });

    await expect(adapter.run(input({ timeoutMs: 100 }))).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("denied without recovery"),
    });
  });

  it("cleans up staged Copilot SDK auth when client construction fails", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-sdk-home-"));
    const { adapter, calls } = createMockCopilotAdapter({
      throwOnClientConstruction: true,
    });

    await expect(
      adapter.run(
        input({
          env: {
            HOME: home,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("client construction failed"),
    });

    const stagedBaseDirectory = calls.clientOptions?.baseDirectory;
    expect(stagedBaseDirectory).toBeDefined();
    expect(existsSync(stagedBaseDirectory ?? "")).toBe(false);
  });

  it("uses TMP and TEMP fallbacks for Copilot SDK staging", async () => {
    for (const tempKey of ["TMP", "TEMP"] as const) {
      const home = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-sdk-home-"));
      const tempRoot = mkdtempSync(path.join(tmpdir(), `diffwarden-copilot-sdk-${tempKey}-`));
      const { adapter, calls } = createMockCopilotAdapter();

      await adapter.run(
        input({
          env: {
            HOME: home,
            [tempKey]: tempRoot,
          },
        }),
      );

      expect(calls.clientOptions?.baseDirectory).toEqual(expect.stringContaining(tempRoot));
      expect(calls.clientOptions?.env?.TMPDIR).toBe(
        path.join(path.dirname(calls.clientOptions?.baseDirectory ?? ""), "tool-output-temp"),
      );
    }
  });

  it("fails SDK runs when the review env TMPDIR resolves inside the repo", async () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-repo-")));
    const home = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-sdk-home-"));
    const tempRoot = path.join(repo, "tmp");
    mkdirSync(tempRoot, { recursive: true });
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.run(
        input({
          cwd: repo,
          repoRoot: repo,
          env: {
            HOME: home,
            TMPDIR: tempRoot,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("isolated base directory resolved inside"),
    });
  });

  it("resolves relative SDK temp roots from the caller cwd before workspace checks", async () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-rel-tmp-repo-")));
    const home = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-sdk-home-"));
    const { adapter } = createMockCopilotAdapter();

    await expect(
      adapter.run(
        input({
          cwd: repo,
          repoRoot: repo,
          env: {
            HOME: home,
            TMPDIR: ".tmp",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("isolated base directory resolved inside"),
    });
    expect(existsSync(path.join(repo, ".tmp"))).toBe(false);
  });

  it("denies non-read permission requests through the exported handler", async () => {
    const handler = createCopilotSdkPermissionHandler("/repo", ["/tmp/copilot-tool-output"]);

    await expect(
      handler(
        {
          kind: "read",
          path: "/tmp/copilot-tool-output/large-output.txt",
          intention: "read large tool output",
        },
        { sessionId: "test" },
      ),
    ).resolves.toEqual({
      kind: "approve-once",
    });

    await expect(
      handler(
        {
          kind: "url",
          url: "https://example.com",
          intention: "fetch docs",
        },
        { sessionId: "test" },
      ),
    ).resolves.toMatchObject({
      kind: "reject",
    });
  });

  it("does not start a Copilot session when the reviewer signal is already aborted", async () => {
    const { adapter, calls } = createMockCopilotAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.run(input({ signal: controller.signal }))).rejects.toThrow(
      "Copilot reviewer aborted before session startup",
    );

    expect(calls.sessionConfig).toBeUndefined();
    expect(calls.sendOptions).toBeUndefined();
  });

  it("does not send the review prompt when the signal aborts before prompting", async () => {
    const controller = new AbortController();
    const { adapter, calls } = createMockCopilotAdapter({
      afterCreateSession: () => controller.abort(),
    });

    await expect(adapter.run(input({ signal: controller.signal }))).rejects.toThrow(
      "Copilot reviewer aborted",
    );

    expect(calls.sendOptions).toBeUndefined();
    expect(calls.disconnected).toBe(true);
    expect(calls.stopped).toBe(true);
  });

  it("applies reviewer timeout while starting the Copilot session", async () => {
    const { adapter, calls } = createMockCopilotAdapter({
      createSession: "never",
    });

    await expect(adapter.run(input({ timeoutMs: 50 }))).rejects.toThrow(
      "Copilot reviewer timed out starting session",
    );

    expect(calls.sessionConfig).toBeDefined();
    expect(calls.sendOptions).toBeUndefined();
    expect(calls.stopped).toBe(true);
  });
});

describe.skipIf(isIntegrationDisabled("copilot"))("live Copilot SDK adapter", () => {
  let fixture: LiveFixture | undefined;

  it("runs a live Copilot SDK review without modifying the fixture", async () => {
    fixture = createLiveFixture("diffwarden-live-copilot-");
    try {
      const reviewer = createReviewer({
        ...(process.env.DIFFWARDEN_LIVE_COPILOT_MODEL
          ? { model: process.env.DIFFWARDEN_LIVE_COPILOT_MODEL }
          : {}),
        ...(process.env.DIFFWARDEN_LIVE_COPILOT_EFFORT
          ? { effort: process.env.DIFFWARDEN_LIVE_COPILOT_EFFORT }
          : {}),
      });
      const output = await createCopilotAdapter().run(
        await createLiveAdapterInput(fixture, reviewer, process.env),
      );

      expectLiveAdapterOutput(output);
      expectFixtureReadOnly(fixture.repo);
    } finally {
      fixture?.cleanup();
    }
  }, 180_000);
});

function createReviewer(extra: Partial<ReviewReviewerConfig> = {}): ReviewReviewerConfig {
  return {
    id: "copilot",
    sdk: "copilot",
    readonly: true,
    ...extra,
  };
}

function createCopilotRuntimeFixture(name = "copilot-runtime"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "diffwarden-copilot-runtime-fixture-"));
  const executable = path.join(directory, name);
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(executable, 0o755);
  return executable;
}

function input(
  options: {
    reviewer?: ReviewReviewerConfig;
    cwd?: string;
    repoRoot?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): ReviewAdapterInput {
  const cwd = options.cwd ?? "/repo";
  const repoRoot = options.repoRoot ?? cwd;
  return {
    cwd,
    reviewer: options.reviewer ?? createReviewer(),
    target: {
      kind: "custom",
      repo_root: repoRoot,
      diff_command: "test diff",
      changed_files: ["file.ts"],
    },
    diff: "diff --git a/file.ts b/file.ts\n",
    changedFiles: ["file.ts"],
    prompt: "review prompt",
    readonly: true,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

function createMockCopilotAdapter(result: Partial<MockCopilotResult> = {}) {
  const calls: MockCopilotCalls = {};
  const adapter = createCopilotAdapter({
    loadSdk: async () => mockCopilotSdk(calls, result),
    readPackageVersion: async () => "1.0.0-test",
    resolveBundledRuntimeExecutable: async () =>
      result.bundledRuntimeExecutable ?? "/sdk/bundled/copilot/index.js",
  });
  return { adapter, calls };
}

function mockCopilotSdk(
  calls: MockCopilotCalls,
  result: Partial<MockCopilotResult>,
): typeof import("@github/copilot-sdk") {
  class MockCopilotClient {
    constructor(options?: unknown) {
      if (options !== undefined) {
        calls.clientOptions = options as NonNullable<MockCopilotCalls["clientOptions"]>;
      }
      if (result.throwOnClientConstruction === true) {
        throw new Error("client construction failed");
      }
    }

    async createSession(config: unknown) {
      calls.sessionConfig = config as NonNullable<MockCopilotCalls["sessionConfig"]>;
      if (result.createSession === "never") {
        return await new Promise<MockCopilotSession>(() => undefined);
      }
      const sessionResult: MockCopilotResult = {
        content: result.content ?? "plain text",
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.effort !== undefined ? { effort: result.effort } : {}),
        ...(result.emitInitialIdle !== undefined
          ? { emitInitialIdle: result.emitInitialIdle }
          : {}),
        ...(result.emitRecoverableModelCallError !== undefined
          ? { emitRecoverableModelCallError: result.emitRecoverableModelCallError }
          : {}),
        ...(result.emitRecoverablePermissionSessionError !== undefined
          ? { emitRecoverablePermissionSessionError: result.emitRecoverablePermissionSessionError }
          : {}),
        ...(result.emitNonRecoverableSessionError !== undefined
          ? { emitNonRecoverableSessionError: result.emitNonRecoverableSessionError }
          : {}),
        ...(result.emitNonRecoverableSessionErrorBeforeAsyncReview !== undefined
          ? {
              emitNonRecoverableSessionErrorBeforeAsyncReview:
                result.emitNonRecoverableSessionErrorBeforeAsyncReview,
            }
          : {}),
        ...(result.emitNonRecoverableSessionErrorAfterReviewBeforeIdle !== undefined
          ? {
              emitNonRecoverableSessionErrorAfterReviewBeforeIdle:
                result.emitNonRecoverableSessionErrorAfterReviewBeforeIdle,
            }
          : {}),
        ...(result.emitOnlyNonRecoverableSessionError !== undefined
          ? { emitOnlyNonRecoverableSessionError: result.emitOnlyNonRecoverableSessionError }
          : {}),
        ...(result.emitIdleWhileSendPendingBeforeReview !== undefined
          ? {
              emitIdleWhileSendPendingBeforeReview: result.emitIdleWhileSendPendingBeforeReview,
            }
          : {}),
        ...(result.emitSendPendingIdleBeforeReviewWithoutTrailingIdle !== undefined
          ? {
              emitSendPendingIdleBeforeReviewWithoutTrailingIdle:
                result.emitSendPendingIdleBeforeReviewWithoutTrailingIdle,
            }
          : {}),
        ...(result.emitIdleAfterSendBeforeReview !== undefined
          ? { emitIdleAfterSendBeforeReview: result.emitIdleAfterSendBeforeReview }
          : {}),
        ...(result.emitUsageBeforeIdleBeforeReview !== undefined
          ? { emitUsageBeforeIdleBeforeReview: result.emitUsageBeforeIdleBeforeReview }
          : {}),
        ...(result.emitIdleBeforeReviewWithoutTrailingIdle !== undefined
          ? {
              emitIdleBeforeReviewWithoutTrailingIdle:
                result.emitIdleBeforeReviewWithoutTrailingIdle,
            }
          : {}),
        ...(result.emitIdleWithoutReview !== undefined
          ? { emitIdleWithoutReview: result.emitIdleWithoutReview }
          : {}),
        ...(result.emitDelayedReviewAfterIdleMs !== undefined
          ? { emitDelayedReviewAfterIdleMs: result.emitDelayedReviewAfterIdleMs }
          : {}),
        ...(result.emitSubagentLifecycleBeforeReview !== undefined
          ? { emitSubagentLifecycleBeforeReview: result.emitSubagentLifecycleBeforeReview }
          : {}),
        ...(result.emitSubagentUsageAfterRootUsage !== undefined
          ? { emitSubagentUsageAfterRootUsage: result.emitSubagentUsageAfterRootUsage }
          : {}),
      };
      const session = new MockCopilotSession(calls, sessionResult);
      result.afterCreateSession?.();
      return session;
    }

    async stop() {
      calls.stopped = true;
      return [];
    }
  }

  return {
    CopilotClient: MockCopilotClient,
    RuntimeConnection: {
      forStdio(options?: unknown) {
        calls.runtimeConnectionOptions = options;
        return { kind: "stdio", options };
      },
    },
  } as unknown as typeof import("@github/copilot-sdk");
}

class MockCopilotSession {
  private handlers = new Set<(event: MockCopilotEvent) => void>();
  private emittedInitialIdle = false;

  constructor(
    private readonly calls: MockCopilotCalls,
    private readonly result: MockCopilotResult,
  ) {}

  on(handler: (event: MockCopilotEvent) => void): () => void {
    this.handlers.add(handler);
    if (
      this.result.emitInitialIdle === true &&
      !this.emittedInitialIdle &&
      this.handlers.size > 1
    ) {
      this.emittedInitialIdle = true;
      queueMicrotask(() => {
        this.emit({
          type: "session.idle",
          id: "initial-idle",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {},
        });
      });
    }
    return () => this.handlers.delete(handler);
  }

  async send(options: unknown): Promise<string> {
    this.calls.sendOptions = options;
    if (this.result.emitIdleAfterSendBeforeReview === true) {
      return await new Promise((resolve) => {
        queueMicrotask(() => resolve("message-id"));
        setTimeout(() => {
          this.emit({
            type: "session.idle",
            id: "post-send-idle",
            parentId: null,
            timestamp: new Date().toISOString(),
            data: {},
          });
        }, 0);
        setTimeout(() => this.emitSuccessfulReview(), 1);
      });
    }
    if (this.result.emitIdleWithoutReview === true) {
      setTimeout(() => {
        this.emit({
          type: "session.idle",
          id: "no-output-idle",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {},
        });
      });
      return "message-id";
    }
    if (this.result.emitDelayedReviewAfterIdleMs !== undefined) {
      setTimeout(() => {
        this.emit({
          type: "session.idle",
          id: "delayed-review-idle",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {},
        });
      });
      setTimeout(() => this.emitSuccessfulReview(), this.result.emitDelayedReviewAfterIdleMs);
      return "message-id";
    }
    if (this.result.emitIdleWhileSendPendingBeforeReview === true) {
      queueMicrotask(() => {
        this.emit({
          type: "session.idle",
          id: "send-pending-idle",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {},
        });
      });
      return await new Promise((resolve) => {
        setTimeout(() => {
          resolve("message-id");
          setTimeout(() => this.emitSuccessfulReview(), 0);
        }, 300);
      });
    }
    if (this.result.emitSendPendingIdleBeforeReviewWithoutTrailingIdle === true) {
      queueMicrotask(() => {
        this.emit({
          type: "session.idle",
          id: "send-pending-idle",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {},
        });
      });
      return await new Promise((resolve) => {
        setTimeout(() => {
          resolve("message-id");
          setTimeout(() => {
            this.emit({
              type: "assistant.message",
              id: "assistant-message",
              parentId: null,
              timestamp: new Date().toISOString(),
              data: {
                content: this.result.content,
                messageId: "message-id",
                ...(this.result.model !== undefined ? { model: this.result.model } : {}),
              },
            });
          }, 0);
        }, 300);
      });
    }
    if (this.result.emitUsageBeforeIdleBeforeReview === true) {
      setTimeout(() => {
        this.emit({
          type: "assistant.usage",
          id: "early-usage",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            model: this.result.model ?? "model",
          },
        });
        this.emit({
          type: "session.idle",
          id: "usage-only-idle",
          parentId: "early-usage",
          timestamp: new Date().toISOString(),
          data: {},
        });
      });
      setTimeout(() => this.emitSuccessfulReview(), 1);
      return "message-id";
    }
    if (this.result.emitIdleBeforeReviewWithoutTrailingIdle === true) {
      setTimeout(() => {
        this.emit({
          type: "session.idle",
          id: "early-idle",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {},
        });
      });
      setTimeout(() => {
        this.emit({
          type: "assistant.message",
          id: "assistant-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            content: this.result.content,
            messageId: "message-id",
            ...(this.result.model !== undefined ? { model: this.result.model } : {}),
          },
        });
      }, 1);
      return "message-id";
    }
    queueMicrotask(() => {
      if (this.result.emitRecoverableModelCallError === true) {
        this.emit({
          type: "session.error",
          id: "recoverable-error",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            errorType: "model_call",
            message: "retrying model call",
          },
        });
      }
      if (this.result.emitRecoverablePermissionSessionError === true) {
        this.emit({
          type: "session.error",
          id: "permission-error",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            errorType: "permission",
            message: "blocked write_file",
          },
        });
      }
      if (this.result.emitNonRecoverableSessionError === true) {
        this.emit({
          type: "session.error",
          id: "non-recoverable-error",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            errorType: "runtime",
            message: "denied then recovered",
          },
        });
      }
      if (this.result.emitNonRecoverableSessionErrorBeforeAsyncReview === true) {
        this.emit({
          type: "session.error",
          id: "non-recoverable-error",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            errorType: "runtime",
            message: "denied then recovered asynchronously",
          },
        });
        queueMicrotask(() => this.emitSuccessfulReview());
        return;
      }
      if (this.result.emitNonRecoverableSessionErrorAfterReviewBeforeIdle === true) {
        this.emit({
          type: "assistant.message",
          id: "provisional-assistant-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            content: this.result.content,
            messageId: "message-id",
            ...(this.result.model !== undefined ? { model: this.result.model } : {}),
          },
        });
        this.emit({
          type: "session.error",
          id: "post-review-error",
          parentId: "provisional-assistant-message",
          timestamp: new Date().toISOString(),
          data: {
            errorType: "runtime",
            message: "failed after provisional review",
          },
        });
        return;
      }
      if (this.result.emitOnlyNonRecoverableSessionError === true) {
        this.emit({
          type: "session.error",
          id: "fatal-error",
          parentId: null,
          timestamp: new Date().toISOString(),
          data: {
            errorType: "runtime",
            message: "denied without recovery",
          },
        });
        return;
      }
      if (this.result.emitSubagentLifecycleBeforeReview === true) {
        this.emit({
          type: "session.idle",
          id: "subagent-idle",
          parentId: null,
          timestamp: new Date().toISOString(),
          agentId: "helper-agent",
          data: {},
        });
        this.emit({
          type: "session.error",
          id: "subagent-error",
          parentId: null,
          timestamp: new Date().toISOString(),
          agentId: "helper-agent",
          data: {
            errorType: "runtime",
            message: "helper failed after collecting context",
          },
        });
        this.emit({
          type: "session.shutdown",
          id: "subagent-shutdown",
          parentId: null,
          timestamp: new Date().toISOString(),
          agentId: "helper-agent",
          data: {
            shutdownType: "error",
            errorReason: "helper shut down",
          },
        });
      }
      this.emitSuccessfulReview();
    });
    return "message-id";
  }

  async sendAndWait(): Promise<never> {
    this.calls.usedSendAndWait = true;
    throw new Error("sendAndWait should not be used");
  }

  async abort(): Promise<void> {
    this.calls.aborted = true;
  }

  async disconnect(): Promise<void> {
    this.calls.disconnected = true;
  }

  private emit(event: MockCopilotEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private emitSuccessfulReview(): void {
    this.emit({
      type: "assistant.message",
      id: "assistant-message",
      parentId: null,
      timestamp: new Date().toISOString(),
      data: {
        content: this.result.content,
        messageId: "message-id",
        ...(this.result.model !== undefined ? { model: this.result.model } : {}),
      },
    });
    this.emit({
      type: "assistant.usage",
      id: "assistant-usage",
      parentId: "assistant-message",
      timestamp: new Date().toISOString(),
      data: {
        model: this.result.model ?? "model",
        ...(this.result.effort !== undefined ? { reasoningEffort: this.result.effort } : {}),
      },
    });
    if (this.result.emitSubagentUsageAfterRootUsage === true) {
      this.emit({
        type: "assistant.usage",
        id: "subagent-usage",
        parentId: "assistant-message",
        timestamp: new Date().toISOString(),
        agentId: "helper-agent",
        data: {
          model: "gpt-helper",
          reasoningEffort: "low",
        },
      });
    }
    this.emit({
      type: "session.idle",
      id: "idle",
      parentId: "assistant-usage",
      timestamp: new Date().toISOString(),
      data: {},
    });
  }
}

type MockCopilotResult = {
  content: string;
  model?: string;
  effort?: string;
  createSession?: "never";
  afterCreateSession?: () => void;
  emitInitialIdle?: boolean;
  emitRecoverableModelCallError?: boolean;
  emitRecoverablePermissionSessionError?: boolean;
  emitNonRecoverableSessionError?: boolean;
  emitNonRecoverableSessionErrorBeforeAsyncReview?: boolean;
  emitNonRecoverableSessionErrorAfterReviewBeforeIdle?: boolean;
  emitOnlyNonRecoverableSessionError?: boolean;
  emitIdleWhileSendPendingBeforeReview?: boolean;
  emitSendPendingIdleBeforeReviewWithoutTrailingIdle?: boolean;
  emitIdleAfterSendBeforeReview?: boolean;
  emitUsageBeforeIdleBeforeReview?: boolean;
  emitIdleBeforeReviewWithoutTrailingIdle?: boolean;
  emitIdleWithoutReview?: boolean;
  emitDelayedReviewAfterIdleMs?: number;
  emitSubagentLifecycleBeforeReview?: boolean;
  emitSubagentUsageAfterRootUsage?: boolean;
  throwOnClientConstruction?: boolean;
  bundledRuntimeExecutable?: string;
};

type MockCopilotCalls = {
  clientOptions?: {
    mode?: string;
    workingDirectory?: string;
    baseDirectory?: string;
    env?: NodeJS.ProcessEnv;
    telemetry?: Record<string, unknown>;
  };
  runtimeConnectionOptions?: unknown;
  sessionConfig?: {
    onPermissionRequest?: (
      request: Record<string, unknown>,
      invocation: { sessionId: string },
    ) => unknown;
    [key: string]: unknown;
  };
  sendOptions?: unknown;
  usedSendAndWait?: boolean;
  aborted?: boolean;
  disconnected?: boolean;
  stopped?: boolean;
};

type MockCopilotEvent =
  | {
      type: "assistant.message";
      id: string;
      parentId: string | null;
      timestamp: string;
      agentId?: string;
      data: {
        content: string;
        messageId: string;
        model?: string;
      };
    }
  | {
      type: "assistant.usage";
      id: string;
      parentId: string | null;
      timestamp: string;
      agentId?: string;
      data: {
        model: string;
        reasoningEffort?: string;
      };
    }
  | {
      type: "session.idle";
      id: string;
      parentId: string | null;
      timestamp: string;
      agentId?: string;
      data: Record<string, never>;
    }
  | {
      type: "session.error";
      id: string;
      parentId: string | null;
      timestamp: string;
      agentId?: string;
      data: {
        errorType?: string;
        message: string;
      };
    }
  | {
      type: "session.shutdown";
      id: string;
      parentId: string | null;
      timestamp: string;
      agentId?: string;
      data: {
        shutdownType: "routine" | "error";
        errorReason?: string;
      };
    };
