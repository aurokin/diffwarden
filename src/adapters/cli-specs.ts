import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  collectJsonLinesText,
  normalizeJsonLikeAdapterOutput,
  unwrapStructuredReview,
} from "../core/adapter-output.js";
import { reviewerFailed } from "../core/errors.js";
import { reviewResultJsonSchema, reviewResultStrictJsonSchema } from "../core/schema.js";
import {
  antigravityCliReviewMcpConfigFileName,
  antigravityCliReviewPolicyMetadata,
  antigravityCliReviewSettings,
  antigravityCliReviewSettingsFileName,
} from "./antigravity-tool-policy.js";
import { claudeCliDisallowedToolsArg, claudeCliReviewToolsArg } from "./claude-tool-policy.js";
import { claudeCliEnv, resolveClaudeRuntime } from "./claude.js";
import {
  claudeCliEffort,
  cliExecutable,
  codexGlobalArgs,
  defaultCliExecutable,
  droidCliEffort,
  grokCliEffort,
  numberCliOption,
  providerQualifiedModel,
  pushModel,
  pushModelAndEffort,
  pushPromptArg,
  stringCliOption,
} from "./cli-helpers.js";
import { cliRuntimeResolutionMetadata } from "./cli-runtime-metadata.js";
import type { CliEngine, CliSpec } from "./cli-types.js";
import {
  codexCliCwdArg,
  codexCliOutputLastMessageArg,
  codexCliOutputSchemaArg,
  codexCliPromptStdinArg,
  codexCliReviewBaseArgs,
} from "./codex-tool-policy.js";
import { cursorCliReviewMode, cursorCliSandboxMode } from "./cursor-policy.js";
import { droidSessionTag } from "./droid-session.js";
import {
  droidCliReviewAllowedToolsArg,
  droidCliReviewPolicyMetadata,
} from "./droid-tool-policy.js";
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
} from "./gemini-tool-policy.js";
import {
  grokCliAllowRules,
  grokCliDenyRules,
  grokCliDisallowedToolsArg,
  grokCliReviewOutputFormat,
  grokCliReviewPermissionMode,
  grokCliReviewPolicyMetadata,
  grokCliReviewSandbox,
  grokCliReviewToolsArg,
} from "./grok-tool-policy.js";
import { effortResolutionMetadata, modelResolutionMetadata } from "./metadata.js";
import { piCliReviewSurfaceArgs } from "./pi-tool-policy.js";
import type { ReviewAdapterInput } from "./types.js";

const antigravityUserSettingsPolicyKeys = new Set([
  "allowNonWorkspaceAccess",
  "always-proceed",
  "alwaysProceed",
  "always_proceed",
  "approvalMode",
  "artifactReviewPolicy",
  "autoApprove",
  "dangerouslySkipPermissions",
  "enableTerminalSandbox",
  "permissions",
  "sandbox",
  "skipPermissions",
  "toolPermission",
  "trustedWorkspaces",
]);

const opencodeGeneratedAgentPrefix = "diffwarden-review";

function opencodeReviewPermission(): Record<string, "allow" | "deny"> {
  return {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
  };
}

function opencodeInjectedConfig(
  input: ReviewAdapterInput,
): { agent: string; content: string } | undefined {
  const requestedAgent = stringCliOption(input.reviewer, "agent");
  if (requestedAgent !== undefined && requestedAgent !== opencodeGeneratedAgentPrefix) {
    return undefined;
  }

  const effectiveEnv = input.env ?? process.env;
  if (opencodeConfigEnvPresent(effectiveEnv)) {
    return undefined;
  }

  const agent = `${opencodeGeneratedAgentPrefix}-${randomUUID()}`;
  return {
    agent,
    content: JSON.stringify({
      agent: {
        [agent]: {
          mode: "primary",
          description: "Low-tool read-only agent used by Diffwarden review runs.",
          permission: opencodeReviewPermission(),
        },
      },
    }),
  };
}

function opencodeConfigEnvPresent(env: NodeJS.ProcessEnv): boolean {
  return (
    env.OPENCODE_CONFIG_CONTENT !== undefined ||
    env.OPENCODE_CONFIG !== undefined ||
    env.OPENCODE_CONFIG_DIR !== undefined
  );
}

function opencodeErrorMessage(raw: string): string | undefined {
  for (const event of opencodeJsonLineEvents(raw)) {
    const message = opencodeErrorEventMessage(event);
    if (message !== undefined) {
      return message;
    }
  }

  return undefined;
}

function opencodeJsonLineEvents(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON text is handled by the normal text fallback.
    }
  }

  return events;
}

function opencodeErrorEventMessage(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "error") {
    return undefined;
  }

  return opencodeErrorDetail(event.error) ?? stringValue(event.message) ?? JSON.stringify(event);
}

function opencodeStructuredReview(raw: string): unknown | undefined {
  for (const event of opencodeJsonLineEvents(raw)) {
    const review = unwrapStructuredReview(event);
    if (review !== undefined) {
      return review;
    }
  }

  return undefined;
}

function opencodeErrorDetail(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const nested =
    stringValue(value.message) ??
    opencodeErrorDetail(value.data) ??
    opencodeErrorDetail(value.error) ??
    stringValue(value.responseBody);
  const name = stringValue(value.name);
  if (name !== undefined && nested !== undefined) {
    return `${name}: ${nested}`;
  }
  return nested ?? name;
}

function opencodeReviewPrompt(prompt: string): string {
  return [
    "OpenCode transport note:",
    "- The complete patch is included below; treat it as the source of truth for diff-backed reviews.",
    "- Do not run the patch provenance command.",
    "- Only read, glob, and grep are available for local context; do not edit, write, run shell commands, start tasks, or fetch web content.",
    "- Return the final ReviewResult JSON as soon as you have enough evidence.",
    "",
    prompt,
  ].join("\n");
}

export const cliSpecs: Record<CliEngine, CliSpec> = {
  codex: {
    async buildInvocation(input, tempDir) {
      const schemaPath = path.join(tempDir, "review-schema.json");
      const outputPath = path.join(tempDir, "codex-review.json");
      await writeFile(schemaPath, `${JSON.stringify(reviewResultStrictJsonSchema)}\n`, "utf8");

      const args = [
        ...codexGlobalArgs(input.reviewer),
        ...codexCliReviewBaseArgs,
        codexCliOutputSchemaArg,
        schemaPath,
        codexCliOutputLastMessageArg,
        outputPath,
        codexCliCwdArg,
        input.cwd,
        codexCliPromptStdinArg,
      ];

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("codex")),
        args,
        stdin: input.prompt,
        outputPath,
        captureMode: "native-structured",
      };
    },
    async parseOutput(result, invocation) {
      const runtimeMetadata = cliRuntimeResolutionMetadata(result.stdout);
      const outputPath = invocation.outputPath;
      if (outputPath !== undefined) {
        try {
          return normalizeJsonLikeAdapterOutput(await readFile(outputPath, "utf8"), {
            captureMode: "native-structured",
            readonlyCapability: "enforced",
            ...runtimeMetadata,
          });
        } catch {
          // Fall through to stdout/stderr handling below.
        }
      }

      return {
        text: collectJsonLinesText(result.stdout) || result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "enforced",
          ...runtimeMetadata,
        },
      };
    },
  },
  claude: {
    async buildInvocation(input, tempDir) {
      const mcpConfigPath = path.join(tempDir, "claude-mcp.json");
      // Claude CLI --mcp-config accepts JSON files as well as inline JSON strings.
      await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} })}\n`, "utf8");
      const args = [
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
      ];
      pushModelAndEffort(args, input.reviewer, claudeCliEffort);
      const executable = cliExecutable(input.reviewer, defaultCliExecutable("claude"));
      const runtime = await resolveClaudeRuntime(input, executable);
      const env = claudeCliEnv(runtime);

      return {
        executable,
        args,
        ...(env !== undefined ? { env } : {}),
        ...(runtime.authMode === "claude-code"
          ? { unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] }
          : {}),
        stdin: input.prompt,
        captureMode: "native-structured",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "native-structured",
        readonlyCapability: "tool-restricted",
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  cursor: {
    async buildInvocation(input) {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--workspace",
        input.cwd,
        "--mode",
        cursorCliReviewMode,
        "--sandbox",
        cursorCliSandboxMode,
        "--trust",
      ];
      pushModel(args, input.reviewer);
      pushPromptArg(args, input.prompt, "cursor");

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("cursor")),
        args,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "prompt-only",
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  gemini: {
    async buildInvocation(input, tempDir) {
      const policyPath = path.join(tempDir, geminiCliReviewPolicyFileName);
      const trustedFoldersPath = path.join(tempDir, geminiCliReviewTrustedFoldersFileName);
      await writeFile(policyPath, geminiCliReviewPolicyToml(), "utf8");
      await writeFile(trustedFoldersPath, "{}\n", "utf8");
      const args = [
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
      ];
      pushModel(args, input.reviewer);

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("gemini")),
        args,
        env: {
          [geminiCliTrustedFoldersPathEnvVar]: trustedFoldersPath,
        },
        unsetEnv: [geminiCliTrustWorkspaceEnvVar],
        stdin: input.prompt,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
        ...geminiCliReviewPolicyMetadata(),
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  opencode: {
    async buildInvocation(input) {
      const args = ["run", "--pure", "--format", "json", "--dir", input.cwd];
      const injectedConfig = opencodeInjectedConfig(input);
      const agent = injectedConfig?.agent ?? stringCliOption(input.reviewer, "agent");
      if (agent !== undefined) {
        args.push("--agent", agent);
      }
      const model = providerQualifiedModel(input.reviewer);
      if (model !== undefined) {
        args.push("--model", model);
      }
      if (input.reviewer.effort !== undefined && input.reviewer.effort !== "off") {
        args.push("--variant", input.reviewer.effort);
      }

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("opencode")),
        args,
        stdin: opencodeReviewPrompt(input.prompt),
        env: {
          OPENCODE_PERMISSION: JSON.stringify(opencodeReviewPermission()),
          ...(injectedConfig !== undefined
            ? { OPENCODE_CONFIG_CONTENT: injectedConfig.content }
            : {}),
        },
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      const metadata = {
        captureMode: "text" as const,
        readonlyCapability: "prompt-only" as const,
        ...cliRuntimeResolutionMetadata(result.stdout),
      };
      const structured = opencodeStructuredReview(result.stdout);
      if (structured !== undefined) {
        return {
          structured,
          metadata,
        };
      }

      const text = collectJsonLinesText(result.stdout);
      const errorMessage = opencodeErrorMessage(result.stdout);
      if (!text && errorMessage !== undefined) {
        throw reviewerFailed(`OpenCode reviewer failed: ${errorMessage}`);
      }

      return {
        text: text || result.stdout.trim(),
        metadata,
      };
    },
  },
  pi: {
    async buildInvocation(input) {
      const args = ["--print", "--mode", "json", ...piCliReviewSurfaceArgs];
      const model = providerQualifiedModel(input.reviewer);
      if (model !== undefined) {
        args.push("--model", model);
      }
      if (input.reviewer.effort !== undefined) {
        args.push("--thinking", input.reviewer.effort);
      }

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("pi")),
        args,
        stdin: input.prompt,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return {
        text: collectJsonLinesText(result.stdout) || result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "tool-restricted",
          ...cliRuntimeResolutionMetadata(result.stdout),
        },
      };
    },
  },
  droid: {
    async buildInvocation(input, tempDir) {
      const promptPath = path.join(tempDir, "droid-prompt.txt");
      await writeFile(promptPath, input.prompt, "utf8");
      const args = [
        "exec",
        "--cwd",
        input.cwd,
        "--output-format",
        "json",
        "--use-spec",
        "--enabled-tools",
        droidCliReviewAllowedToolsArg(),
        "--file",
        promptPath,
      ];
      const model = providerQualifiedModel(input.reviewer);
      if (model !== undefined) {
        args.push("--spec-model", model);
      }
      if (input.reviewer.effort !== undefined && input.reviewer.effort !== "off") {
        args.push("--spec-reasoning-effort", droidCliEffort(input.reviewer.effort));
      }
      const logGroupId = droidCliReviewLogGroupId(input);
      args.push("--tag", JSON.stringify(droidSessionTag(input, "cli")));
      args.push("--log-group-id", logGroupId);

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("droid")),
        args,
        droidLogGroupId: logGroupId,
        droidSessionDirectory: await droidCliSessionDirectory(input.cwd, input.env),
        captureMode: "text",
      };
    },
    async parseOutput(result, invocation) {
      const settingsMetadata = await droidCliSessionSettingsMetadata(
        result.stdout,
        invocation.droidSessionDirectory,
      );
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "enforced",
        ...droidCliReviewPolicyMetadata(),
        ...(invocation.droidLogGroupId !== undefined
          ? { droidLogGroupId: invocation.droidLogGroupId }
          : {}),
        ...settingsMetadata,
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  grok: {
    async buildInvocation(input, tempDir) {
      const promptPath = path.join(tempDir, "grok-prompt.txt");
      await writeFile(promptPath, input.prompt, "utf8");
      const args = [
        "--prompt-file",
        promptPath,
        "--cwd",
        input.cwd,
        "--output-format",
        grokCliReviewOutputFormat,
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
      ];
      for (const rule of grokCliAllowRules) {
        args.push("--allow", rule);
      }
      for (const rule of grokCliDenyRules) {
        args.push("--deny", rule);
      }
      pushModel(args, input.reviewer);
      if (input.reviewer.effort !== undefined && input.reviewer.effort !== "off") {
        args.push("--reasoning-effort", grokCliEffort(input.reviewer.effort));
      }

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("grok")),
        args,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "enforced",
        ...grokCliReviewPolicyMetadata(),
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  antigravity: {
    async buildInvocation(input, tempDir) {
      // agy has no prompt-file flag; a 2026-05-31 live probe confirmed
      // print mode can read this file.
      const reviewRoot = path.resolve(input.target.repo_root);
      const promptDir = path.join(tempDir, "antigravity-prompt");
      await mkdir(promptDir, { recursive: true });
      const promptPath = path.join(promptDir, "antigravity-prompt.txt");
      await writeFile(promptPath, input.prompt, "utf8");
      const isolatedHome = await stageAntigravityReviewHome({
        input,
        promptPath,
        reviewCwd: reviewRoot,
        tempDir,
      });
      const printTimeoutSeconds = numberCliOption(input.reviewer, "printTimeoutSeconds") ?? 300;
      const args = ["--print"];
      pushPromptArg(
        args,
        `Read the full Diffwarden review prompt from ${promptPath} and follow it exactly.`,
        "antigravity",
      );
      args.push(
        "--print-timeout",
        `${printTimeoutSeconds}s`,
        "--sandbox",
        "--add-dir",
        promptDir,
        "--add-dir",
        reviewRoot,
      );

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("antigravity")),
        args,
        cwd: promptDir,
        env: {
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        },
        unsetEnv: ["HOMEDRIVE", "HOMEPATH"],
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return {
        text: result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "tool-restricted",
          ...antigravityCliReviewPolicyMetadata(),
        },
      };
    },
  },
};

async function stageAntigravityReviewHome(input: {
  input: ReviewAdapterInput;
  promptPath: string;
  reviewCwd: string;
  tempDir: string;
}): Promise<string> {
  const isolatedHome = path.join(input.tempDir, "antigravity-home");
  const reviewRoots = [input.reviewCwd, input.input.target.repo_root];
  if (await antigravityHomeIsInsideReviewWorkspace(reviewRoots, input.tempDir)) {
    throw reviewerFailed(
      "Antigravity isolated home resolved inside the review workspace; set TMPDIR outside the repository before running Antigravity reviews.",
    );
  }
  const geminiDir = path.join(isolatedHome, ".gemini");
  const cliDir = path.join(geminiDir, "antigravity-cli");
  const configDir = path.join(geminiDir, "config");
  await mkdir(cliDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(isolatedHome, ".config"), { recursive: true });
  const sourceGeminiDir = antigravitySourceGeminiDir(input.input.env);
  if (
    sourceGeminiDir !== undefined &&
    (await pathIsInsideReviewWorkspace(reviewRoots, sourceGeminiDir))
  ) {
    throw reviewerFailed(
      "Antigravity source credentials resolved inside the review workspace; set HOME or USERPROFILE outside the repository before running Antigravity reviews.",
    );
  }
  await writeFile(
    path.join(cliDir, antigravityCliReviewSettingsFileName),
    `${JSON.stringify(
      {
        ...(await readAntigravityBaseSettings(sourceGeminiDir)),
        ...antigravityCliReviewSettings({ promptPath: input.promptPath, cwd: input.reviewCwd }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(configDir, antigravityCliReviewMcpConfigFileName), "{}\n", "utf8");
  await copyAntigravityAuthFiles(geminiDir, cliDir, sourceGeminiDir);
  return isolatedHome;
}

async function copyAntigravityAuthFiles(
  geminiDir: string,
  cliDir: string,
  sourceGeminiDir: string | undefined,
): Promise<void> {
  if (sourceGeminiDir === undefined) {
    return;
  }
  await copyIfPresent(
    path.join(sourceGeminiDir, "oauth_creds.json"),
    path.join(geminiDir, "oauth_creds.json"),
  );
  await copyIfPresent(
    path.join(sourceGeminiDir, "google_accounts.json"),
    path.join(geminiDir, "google_accounts.json"),
  );
  await copyIfPresent(
    path.join(sourceGeminiDir, "installation_id"),
    path.join(geminiDir, "installation_id"),
  );
  await copyIfPresent(
    path.join(sourceGeminiDir, "antigravity-cli", "installation_id"),
    path.join(cliDir, "installation_id"),
  );
}

async function readAntigravityBaseSettings(
  sourceGeminiDir: string | undefined,
): Promise<Record<string, unknown>> {
  if (sourceGeminiDir === undefined) {
    return {};
  }

  try {
    const contents = await readFile(
      path.join(sourceGeminiDir, "antigravity-cli", antigravityCliReviewSettingsFileName),
      "utf8",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return {};
    }
    return isPlainRecord(parsed) ? antigravityNonPolicySettings(parsed) : {};
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return {};
    }
    throw error;
  }
}

function antigravityNonPolicySettings(settings: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!antigravityUserSettingsPolicyKeys.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function antigravitySourceGeminiDir(
  env: NodeJS.ProcessEnv | undefined,
  fallbackHome = homedir(),
): string | undefined {
  const sourceHome = antigravitySourceHome(env, fallbackHome);
  return sourceHome === undefined ? undefined : path.join(sourceHome, ".gemini");
}

function antigravitySourceHome(
  env: NodeJS.ProcessEnv | undefined,
  fallbackHome: string,
): string | undefined {
  const home = env?.HOME?.trim();
  if (home) {
    return home;
  }

  const userProfile = env?.USERPROFILE?.trim();
  if (userProfile) {
    return userProfile;
  }

  const homeDrive = env?.HOMEDRIVE?.trim();
  const homePath = env?.HOMEPATH?.trim();
  if (homeDrive && homePath) {
    return path.win32.join(homeDrive, homePath);
  }

  const hasExplicitHomeBoundary =
    env !== undefined &&
    (env.HOME !== undefined ||
      env.USERPROFILE !== undefined ||
      env.HOMEDRIVE !== undefined ||
      env.HOMEPATH !== undefined);
  if (hasExplicitHomeBoundary) {
    return undefined;
  }

  if (env !== undefined) {
    if (env === process.env) {
      return fallbackHome;
    }
    // An explicit child environment is an auth boundary unless it provides a home path.
    return undefined;
  }

  return fallbackHome;
}

async function antigravityHomeIsInsideReviewWorkspace(
  reviewRoots: string[],
  tempDir: string,
): Promise<boolean> {
  const tempRoot = await realpathOrResolve(tempDir);
  return await pathIsInsideReviewWorkspace(reviewRoots, path.join(tempRoot, "antigravity-home"));
}

async function pathIsInsideReviewWorkspace(
  reviewRoots: string[],
  candidatePath: string,
): Promise<boolean> {
  const candidate = await realpathOrResolve(candidatePath);
  for (const reviewRoot of [...new Set(reviewRoots)]) {
    if (isPathInside(await realpathOrResolve(reviewRoot), candidate)) {
      return true;
    }
  }
  return false;
}

async function realpathOrResolve(inputPath: string): Promise<string> {
  try {
    return await realpath(inputPath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return path.resolve(inputPath);
    }
    throw error;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function droidCliSessionSettingsMetadata(
  stdout: string,
  sessionDirectory: string | undefined,
): Promise<Record<string, string>> {
  const sessionId = droidCliSessionId(stdout);
  if (sessionId === undefined || sessionDirectory === undefined) {
    return {};
  }

  const settings = await readDroidSessionSettings(sessionDirectory, sessionId);
  if (settings === undefined) {
    return {};
  }

  const model = droidSettingsModel(settings);
  const effort = stringValue(settings.specModeReasoningEffort ?? settings.reasoningEffort);

  return {
    droidSessionId: sessionId,
    ...(model !== undefined ? { droidSessionModel: model } : {}),
    ...(effort !== undefined ? { droidSessionEffort: effort } : {}),
    ...(model !== undefined
      ? modelResolutionMetadata({ resolved: model, source: "provider-local" })
      : {}),
    ...(effort !== undefined
      ? effortResolutionMetadata({ resolved: effort, source: "provider-local" })
      : {}),
  };
}

async function readDroidSessionSettings(
  sessionDirectory: string,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const fileName = `${sessionId}.settings.json`;
  const directFile = path.join(sessionDirectory, fileName);
  const directSettings = await readJsonRecord(directFile);
  if (directSettings !== undefined) {
    return directSettings;
  }

  try {
    for (const entry of await readdir(path.dirname(sessionDirectory), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidateFile = path.join(path.dirname(sessionDirectory), entry.name, fileName);
      if (candidateFile === directFile) {
        continue;
      }

      const candidateSettings = await readJsonRecord(candidateFile);
      if (candidateSettings !== undefined) {
        return candidateSettings;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function droidCliSessionId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      return undefined;
    }
    return stringValue(parsed.session_id ?? parsed.sessionId);
  } catch {
    return undefined;
  }
}

function droidCliReviewLogGroupId(input: { reviewer: { id: string } }): string {
  return `diffwarden-${sanitizeDroidLogGroupPart(input.reviewer.id)}-${randomUUID()}`;
}

function sanitizeDroidLogGroupPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "reviewer";
}

async function readJsonRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function droidCliSessionDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  return path.join(
    droidFactoryHome(env),
    "sessions",
    encodeDroidSessionProjectPath(await realCwd(cwd)),
  );
}

function droidFactoryHome(env: NodeJS.ProcessEnv | undefined): string {
  const home = env?.HOME?.trim() || homedir();
  return path.join(home, ".factory");
}

function encodeDroidSessionProjectPath(cwd: string): string {
  const drivePath = /^[A-Za-z]:[\\/]/.test(cwd) ? cwd : path.resolve(cwd);
  const driveMatch = /^([A-Za-z]):[\\/]*(.*)$/.exec(drivePath);
  if (driveMatch !== null) {
    const [, drive = "", rest = ""] = driveMatch;
    return `-${drive}-${rest.replace(/[\\/]+/g, "-")}`;
  }
  return path.resolve(cwd).replace(/[:\\/]/g, "-");
}

async function realCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function droidSettingsModel(settings: Record<string, unknown>): string | undefined {
  const specModeModel = stringValue(settings.specModeModel);
  const model = stringValue(settings.model);
  return (
    stringValue(settings.specModeModelId) ??
    stableModelId(specModeModel) ??
    stringValue(settings.modelId) ??
    specModeModel ??
    stableModelId(model) ??
    model
  );
}

function stableModelId(value: string | undefined): string | undefined {
  return value !== undefined && !/\s/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
