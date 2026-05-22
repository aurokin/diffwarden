import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalidCli, missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
import {
  type ReviewResult,
  reviewResultJsonSchema,
  reviewResultSchema,
  reviewResultStrictJsonSchema,
} from "../core/schema.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerConfig,
} from "./types.js";

type CliEngine = Exclude<ReviewReviewerConfig["sdk"], "fake">;

type CliInvocation = {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  outputPath?: string;
  captureMode: NonNullable<ReviewAdapterOutput["metadata"]>["captureMode"];
};

type CliRunResult = {
  executable: string;
  stdout: string;
  stderr: string;
};

type CliSpec = {
  defaultExecutable: string;
  readonlyCapability: NonNullable<
    NonNullable<ReviewAdapterOutput["metadata"]>["readonlyCapability"]
  >;
  supportsModel: boolean;
  supportsEffort: boolean;
  buildInvocation(input: ReviewAdapterInput, tempDir: string): Promise<CliInvocation>;
  parseOutput(result: CliRunResult, invocation: CliInvocation): Promise<ReviewAdapterOutput>;
};

const cliSpecs: Record<CliEngine, CliSpec> = {
  codex: {
    defaultExecutable: "codex",
    readonlyCapability: "enforced",
    supportsModel: true,
    supportsEffort: true,
    async buildInvocation(input, tempDir) {
      const schemaPath = path.join(tempDir, "review-schema.json");
      const outputPath = path.join(tempDir, "codex-review.json");
      await writeFile(schemaPath, `${JSON.stringify(reviewResultStrictJsonSchema)}\n`, "utf8");

      const args = [
        ...codexGlobalArgs(input.reviewer),
        "exec",
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
        executable: cliExecutable(input.reviewer, "codex"),
        args,
        stdin: input.prompt,
        outputPath,
        captureMode: "native-structured",
      };
    },
    async parseOutput(result, invocation) {
      const outputPath = invocation.outputPath;
      if (outputPath !== undefined) {
        try {
          return normalizeJsonLikeOutput(await readFile(outputPath, "utf8"), {
            captureMode: "native-structured",
            readonlyCapability: "enforced",
          });
        } catch {
          // Fall through to stdout/stderr handling below.
        }
      }

      return {
        text: result.stdout.trim(),
        metadata: {
          captureMode: "text",
          readonlyCapability: "enforced",
        },
      };
    },
  },
  claude: {
    defaultExecutable: "claude",
    readonlyCapability: "tool-restricted",
    supportsModel: true,
    supportsEffort: true,
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

      return {
        executable: cliExecutable(input.reviewer, "claude"),
        args,
        stdin: input.prompt,
        captureMode: "native-structured",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeOutput(result.stdout, {
        captureMode: "native-structured",
        readonlyCapability: "tool-restricted",
      });
    },
  },
  cursor: {
    defaultExecutable: "cursor-agent",
    readonlyCapability: "prompt-only",
    supportsModel: true,
    supportsEffort: false,
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
        executable: cliExecutable(input.reviewer, "cursor-agent"),
        args,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "prompt-only",
      });
    },
  },
  gemini: {
    defaultExecutable: "gemini",
    readonlyCapability: "tool-restricted",
    supportsModel: true,
    supportsEffort: false,
    async buildInvocation(input) {
      const args = ["--prompt", "", "--output-format", "json", "--approval-mode", "plan"];
      pushModel(args, input.reviewer);

      return {
        executable: cliExecutable(input.reviewer, "gemini"),
        args,
        env: {
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        },
        stdin: input.prompt,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "tool-restricted",
      });
    },
  },
  opencode: {
    defaultExecutable: "opencode",
    readonlyCapability: "prompt-only",
    supportsModel: true,
    supportsEffort: true,
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
        executable: cliExecutable(input.reviewer, "opencode"),
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
        },
      };
    },
  },
  pi: {
    defaultExecutable: "pi",
    readonlyCapability: "tool-restricted",
    supportsModel: true,
    supportsEffort: true,
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
        executable: cliExecutable(input.reviewer, "pi"),
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
        },
      };
    },
  },
  droid: {
    defaultExecutable: "droid",
    readonlyCapability: "enforced",
    supportsModel: true,
    supportsEffort: true,
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

      return {
        executable: cliExecutable(input.reviewer, "droid"),
        args,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "enforced",
      });
    },
  },
  grok: {
    defaultExecutable: "grok",
    readonlyCapability: "prompt-only",
    supportsModel: true,
    supportsEffort: true,
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
        executable: cliExecutable(input.reviewer, "grok"),
        args,
        captureMode: "text",
      };
    },
    async parseOutput(result) {
      return normalizeJsonLikeOutput(result.stdout, {
        captureMode: "text",
        readonlyCapability: "prompt-only",
      });
    },
  },
  antigravity: {
    defaultExecutable: "agy",
    readonlyCapability: "prompt-only",
    supportsModel: false,
    supportsEffort: false,
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
        executable: cliExecutable(input.reviewer, "agy"),
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

export function createCliAdapter(engine: CliEngine): ReviewAdapter {
  const spec = cliSpecs[engine];
  return {
    name: `${engine}:cli`,
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      validateSupportedCliOverrides(engine, spec, input.reviewer);
      const executable = cliExecutable(input.reviewer, spec.defaultExecutable);
      const resolvedExecutable = await resolveExecutable(executable, input.env);
      const metadata: ReviewAdapterPreflightResult["metadata"] = {
        readonlyCapability: spec.readonlyCapability,
        transport: "cli",
        executable: resolvedExecutable,
        ...(input.reviewer.model !== undefined ? { model: input.reviewer.model } : {}),
        ...(input.reviewer.effort !== undefined ? { effort: input.reviewer.effort } : {}),
      };

      return {
        checks: [
          {
            name: "executable",
            status: "passed",
            detail: `Using ${resolvedExecutable}.`,
          },
          {
            name: "readonly",
            status: spec.readonlyCapability === "prompt-only" ? "warning" : "passed",
            detail: readonlyDetail(spec.readonlyCapability),
          },
          {
            name: "auth",
            status: "skipped",
            detail: "CLI authentication is delegated to the selected executable.",
          },
          {
            name: "model",
            status: input.reviewer.model === undefined ? "skipped" : "passed",
            detail:
              input.reviewer.model === undefined
                ? "No model override was requested."
                : `Passing model override to CLI: ${input.reviewer.model}.`,
          },
          {
            name: "effort",
            status: input.reviewer.effort === undefined ? "skipped" : "passed",
            detail:
              input.reviewer.effort === undefined
                ? "No effort override was requested."
                : `Passing effort override to CLI: ${input.reviewer.effort}.`,
          },
        ],
        metadata,
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      validateSupportedCliOverrides(engine, spec, input.reviewer);
      const tempDir = await mkdtemp(path.join(tmpdir(), "diffwarden-cli-"));
      try {
        const invocation = await spec.buildInvocation(input, tempDir);
        const result = await runCli(invocation, input);
        const output = await spec.parseOutput(result, invocation);
        output.metadata = {
          ...output.metadata,
          transport: "cli",
          executable: result.executable,
          stderr: trimForMetadata(result.stderr),
        };
        return output;
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  };
}

async function runCli(invocation: CliInvocation, input: ReviewAdapterInput): Promise<CliRunResult> {
  throwIfAborted(input.signal, `${invocation.executable} reviewer aborted before start`);
  const env = {
    ...(input.env ?? process.env),
    ...invocation.env,
  };
  const executable = await resolveExecutable(invocation.executable, env);

  return await new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, invocation.args, {
        cwd: invocation.cwd ?? input.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(classifyCliStartError(invocation.executable, error));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const removeAbortListener = bindAbortSignal(input.signal, () => {
      child.kill("SIGTERM");
      rejectOnce(reviewerFailed(`${invocation.executable} reviewer aborted`));
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", (error) => {
      if (isNodeErrorWithCode(error, "EPIPE")) {
        return;
      }
      rejectOnce(reviewerFailed(`${invocation.executable} stdin failed: ${error.message}`));
    });
    child.on("error", (error) => {
      removeAbortListener();
      if (isNodeErrorWithCode(error, "ENOENT")) {
        rejectOnce(missingRequirement(`CLI executable not found: ${invocation.executable}`));
        return;
      }
      rejectOnce(classifyCliStartError(invocation.executable, error));
    });
    child.on("close", (code, signal) => {
      removeAbortListener();
      const result = {
        executable,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `signal ${signal ?? "none"}`;
        rejectOnce(classifyCliExit(invocation.executable, code, detail));
        return;
      }
      resolveOnce(result);
    });

    try {
      if (invocation.stdin !== undefined) {
        child.stdin.end(invocation.stdin);
      } else {
        child.stdin.end();
      }
    } catch (error) {
      rejectOnce(reviewerFailed(`${invocation.executable} stdin failed: ${errorMessage(error)}`));
    }

    function resolveOnce(result: CliRunResult): void {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }

    function rejectOnce(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    }
  });
}

function classifyCliStartError(executable: string, error: unknown): Error {
  if (isNodeErrorWithCode(error, "ENOENT")) {
    return missingRequirement(`CLI executable not found: ${executable}`);
  }

  if (isNodeErrorWithCode(error, "ENOEXEC")) {
    return missingRequirement(`CLI executable is not runnable: ${executable}`);
  }

  return reviewerFailed(`${executable} failed to start: ${errorMessage(error)}`);
}

function classifyCliExit(executable: string, code: number | null, detail: string): Error {
  if (/max_turns exceeded/i.test(detail)) {
    return reviewerFailed(`${executable} exited with code ${code}: ${detail}`);
  }

  if (isMissingAuthOutput(detail)) {
    return missingAuth(`${executable} authentication is missing or expired: ${detail}`);
  }

  return reviewerFailed(`${executable} exited with code ${code}: ${detail}`);
}

function isMissingAuthOutput(detail: string): boolean {
  return /\b(auth|authentication|login|logged in|api key|unauthorized|401|403)\b/i.test(detail);
}

async function resolveExecutable(executable: string, env: NodeJS.ProcessEnv | undefined) {
  if (executable.includes(path.sep)) {
    await assertExecutable(executable);
    return executable;
  }

  for (const directory of ((env === undefined ? process.env.PATH : env.PATH) ?? "").split(
    path.delimiter,
  )) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, executable);
    try {
      await assertExecutable(candidate);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }

  throw missingRequirement(`CLI executable not found: ${executable}`);
}

async function assertExecutable(executable: string): Promise<void> {
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw missingRequirement(`CLI executable not found: ${executable}`);
  }
}

function normalizeJsonLikeOutput(
  raw: string,
  metadata: NonNullable<ReviewAdapterOutput["metadata"]>,
): ReviewAdapterOutput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: "", metadata: { ...metadata, captureMode: "text" } };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const review = unwrapStructuredReview(parsed);
    if (review !== undefined) {
      return {
        structured: review,
        metadata,
      };
    }
    const text = unwrapText(parsed);
    if (text !== undefined) {
      return {
        text,
        metadata: { ...metadata, captureMode: "text" },
      };
    }
  } catch {
    // The parser below handles plain text fallbacks.
  }

  return {
    text: trimmed,
    metadata: { ...metadata, captureMode: "text" },
  };
}

function unwrapStructuredReview(value: unknown): ReviewResult | undefined {
  const parsed = reviewResultSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["structured_output", "structuredOutput", "result", "response", "message"]) {
    const nested = value[key];
    if (nested === undefined || typeof nested === "string") {
      continue;
    }
    const review = unwrapStructuredReview(nested);
    if (review !== undefined) {
      return review;
    }
  }

  return undefined;
}

function unwrapText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(unwrapText).filter(isNonEmptyString).join("\n").trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["result", "response", "text", "content", "message", "output"]) {
    const text = unwrapText(value[key]);
    if (isNonEmptyString(text)) {
      return text;
    }
  }

  return undefined;
}

function collectJsonLinesText(raw: string): string {
  const fragments: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event: unknown = JSON.parse(trimmed);
      const text = unwrapJsonLineOutputText(event);
      if (isNonEmptyString(text)) {
        fragments.push(text);
      }
    } catch {
      fragments.push(trimmed);
    }
  }

  return fragments.join("\n").trim();
}

function unwrapJsonLineOutputText(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const type = typeof event.type === "string" ? event.type : undefined;
  if (type === "text") {
    const part = event.part;
    if (isRecord(part) && part.type === "text") {
      return unwrapText(part.text);
    }
    return unwrapText(event.text ?? event.content);
  }

  if (type === "result") {
    return unwrapText(event.response ?? event.result ?? event.output ?? event.message);
  }

  if (
    type === "assistant" ||
    type === "assistant_message" ||
    type === "message_end" ||
    type === "text_end"
  ) {
    return unwrapText(event.message ?? event.content ?? event.text);
  }

  if (type === "message") {
    const message = event.message;
    if (isRecord(message) && message.role === "assistant") {
      return unwrapText(message.content ?? message.text);
    }
    if (event.role === "assistant") {
      return unwrapText(event.content ?? event.text);
    }
  }

  return undefined;
}

function cliExecutable(reviewer: ReviewReviewerConfig, fallback: string): string {
  const executable = reviewer.cliOptions?.executable;
  return typeof executable === "string" && executable.trim() ? executable : fallback;
}

function numberCliOption(reviewer: ReviewReviewerConfig, key: string): number | undefined {
  const value = reviewer.cliOptions?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function codexGlobalArgs(reviewer: ReviewReviewerConfig): string[] {
  const args: string[] = [];
  pushModel(args, reviewer);
  if (reviewer.effort !== undefined && reviewer.effort !== "off") {
    args.push("-c", `model_reasoning_effort="${reviewer.effort}"`);
  }
  return args;
}

function pushModelAndEffort(
  args: string[],
  reviewer: ReviewReviewerConfig,
  mapEffort: (effort: string) => string,
): void {
  pushModel(args, reviewer);
  if (reviewer.effort !== undefined && reviewer.effort !== "off") {
    args.push("--effort", mapEffort(reviewer.effort));
  }
}

function pushModel(args: string[], reviewer: ReviewReviewerConfig): void {
  const model = providerQualifiedModel(reviewer);
  if (model !== undefined) {
    args.push("--model", model);
  }
}

function pushPromptArg(args: string[], prompt: string, engine: CliEngine): void {
  const maxBytes = 128 * 1024;
  const byteLength = Buffer.byteLength(prompt, "utf8");
  if (byteLength > maxBytes) {
    throw invalidCli(
      `${engine} CLI transport requires prompt argv input and the assembled review prompt is too large (${byteLength} bytes)`,
    );
  }
  args.push(prompt);
}

function providerQualifiedModel(reviewer: ReviewReviewerConfig): string | undefined {
  if (reviewer.model === undefined) {
    return undefined;
  }
  if (reviewer.provider === undefined) {
    return reviewer.model;
  }
  return `${reviewer.provider}/${reviewer.model}`;
}

function claudeCliEffort(effort: string): string {
  if (effort === "minimal") {
    return "low";
  }
  if (effort === "xhigh") {
    return "max";
  }
  return effort;
}

function grokCliEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}

function droidCliEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}

function validateSupportedCliOverrides(
  engine: CliEngine,
  spec: CliSpec,
  reviewer: ReviewReviewerConfig,
): void {
  if (!spec.supportsModel && reviewer.model !== undefined) {
    throw invalidCli(`${engine} CLI transport does not support per-run model overrides`);
  }
  if (!spec.supportsEffort && reviewer.effort !== undefined) {
    throw invalidCli(`${engine} CLI transport does not support per-run effort overrides`);
  }
}

function readonlyDetail(
  capability: NonNullable<ReviewAdapterOutput["metadata"]>["readonlyCapability"],
): string {
  if (capability === "enforced") {
    return "CLI invocation includes an engine-level read-only sandbox.";
  }
  if (capability === "tool-restricted") {
    return "CLI invocation restricts available tools to read-oriented review operations.";
  }
  return "CLI invocation uses the most restrictive documented mode, but read-only behavior is prompt-dependent.";
}

function trimForMetadata(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}...` : trimmed;
}

function bindAbortSignal(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (signal === undefined) {
    return () => {};
  }
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw reviewerFailed(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
