import { readFile, writeFile } from "node:fs/promises";
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
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeAdapterOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "enforced",
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
      const printTimeoutSeconds = numberCliOption(input.reviewer, "printTimeoutSeconds") ?? 300;
      const args = [
        "--print",
        "--print-timeout",
        `${printTimeoutSeconds}s`,
        "--sandbox",
        "--add-dir",
        input.cwd,
      ];

      return {
        executable: cliExecutable(input.reviewer, defaultCliExecutable("antigravity")),
        args,
        cwd: tempDir,
        stdin: input.prompt,
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
