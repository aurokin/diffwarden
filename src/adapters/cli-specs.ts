import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  collectJsonLinesText,
  normalizeJsonLikeAdapterOutput,
  unwrapStructuredReview,
} from "../core/adapter-output.js";
import { reviewerFailed } from "../core/errors.js";
import { reviewResultJsonSchema, reviewResultStrictJsonSchema } from "../core/schema.js";
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
import { droidSessionTag } from "./droid-session.js";
import { effortResolutionMetadata, modelResolutionMetadata } from "./metadata.js";
import { piCliReviewSurfaceArgs } from "./pi-tool-policy.js";
import type { ReviewAdapterInput } from "./types.js";

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
      await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} })}\n`, "utf8");
      const args = [
        "-p",
        "--permission-mode",
        "plan",
        "--tools",
        "Read,Grep,Glob,LS",
        "--disallowedTools",
        "Edit,Write,Bash",
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
        "plan",
        "--sandbox",
        "enabled",
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
    async buildInvocation(input) {
      const args = ["--prompt", "", "--output-format", "json", "--approval-mode", "plan"];
      pushModel(args, input.reviewer);

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("gemini")),
        args,
        env: {
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        },
        stdin: input.prompt,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
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
      args.push("--tag", JSON.stringify(droidSessionTag(input, "cli")));

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("droid")),
        args,
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
        "json",
        "--permission-mode",
        "plan",
        "--no-subagents",
        "--no-memory",
        "--disable-web-search",
      ];
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
        readonlyCapability: "prompt-only",
        ...cliRuntimeResolutionMetadata(result.stdout),
      });
    },
  },
  antigravity: {
    async buildInvocation(input, tempDir) {
      // agy has no prompt-file flag; a 2026-05-31 live probe confirmed
      // print mode can read this file.
      const promptPath = path.join(tempDir, "antigravity-prompt.txt");
      await writeFile(promptPath, input.prompt, "utf8");
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
        tempDir,
        "--add-dir",
        input.cwd,
      );

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("antigravity")),
        args,
        cwd: tempDir,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return {
        text: result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "prompt-only",
        },
      };
    },
  },
};

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
