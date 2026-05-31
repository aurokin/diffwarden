import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { collectJsonLinesText, normalizeJsonLikeAdapterOutput } from "../core/adapter-output.js";
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
} from "./cli-helpers.js";
import { cliRuntimeResolutionMetadata } from "./cli-runtime-metadata.js";
import type { CliEngine, CliSpec } from "./cli-types.js";
import { droidSessionTag } from "./droid-session.js";
import { effortResolutionMetadata, modelResolutionMetadata } from "./metadata.js";

export const cliSpecs: Record<CliEngine, CliSpec> = {
  codex: {
    async buildInvocation(input, tempDir) {
      const schemaPath = path.join(tempDir, "review-schema.json");
      const outputPath = path.join(tempDir, "codex-review.json");
      await writeFile(schemaPath, `${JSON.stringify(reviewResultStrictJsonSchema)}\n`, "utf8");

      const args = [
        ...codexGlobalArgs(input.reviewer),
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "--cd",
        input.cwd,
        "-",
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
      const model = providerQualifiedModel(input.reviewer);
      if (model !== undefined) {
        args.push("--model", model);
      }
      if (input.reviewer.effort !== undefined && input.reviewer.effort !== "off") {
        args.push("--variant", input.reviewer.effort);
      }
      pushPromptArg(args, input.prompt, "opencode");

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("opencode")),
        args,
        env: {
          OPENCODE_PERMISSION: JSON.stringify({
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            edit: "deny",
            write: "deny",
            bash: "deny",
            task: "deny",
            todowrite: "deny",
            webfetch: "deny",
            websearch: "deny",
          }),
        },
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return {
        text: collectJsonLinesText(result.stdout) || result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "prompt-only",
          ...cliRuntimeResolutionMetadata(result.stdout),
        },
      };
    },
  },
  pi: {
    async buildInvocation(input) {
      const args = [
        "--print",
        "--mode",
        "json",
        "--no-session",
        "--tools",
        "read,grep,find,ls",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
      ];
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
        droidSessionSettings: {
          promoteModel: input.reviewer.model === undefined,
          promoteEffort: input.reviewer.effort === undefined || input.reviewer.effort === "off",
        },
        captureMode: "text",
      };
    },
    async parseOutput(result, invocation) {
      const settingsMetadata = await droidCliSessionSettingsMetadata(
        result.stdout,
        invocation.droidSessionDirectory,
        invocation.droidSessionSettings,
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
  options: { promoteModel?: boolean; promoteEffort?: boolean } = {},
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
  const promoteModel = options.promoteModel ?? true;
  const promoteEffort = options.promoteEffort ?? true;

  return {
    droidSessionId: sessionId,
    ...(model !== undefined ? { droidSessionModel: model } : {}),
    ...(effort !== undefined ? { droidSessionEffort: effort } : {}),
    ...(model !== undefined && promoteModel
      ? modelResolutionMetadata({ resolved: model, source: "provider-init" })
      : {}),
    ...(effort !== undefined && promoteEffort
      ? effortResolutionMetadata({ resolved: effort, source: "provider-init" })
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
