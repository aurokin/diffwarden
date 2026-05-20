import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import { reviewResultJsonSchema, reviewResultSchema } from "../core/schema.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const defaultClaudeModel = "claude-sonnet-4-6";
const defaultClaudeExecutable = "claude";
const maxClaudeTurns = 3;
const execFileAsync = promisify(execFile);

type ClaudeAdapterDependencies = {
  loadSdk: () => Promise<ClaudeSdk>;
  resolveRuntime: (env: NodeJS.ProcessEnv | undefined) => Promise<ClaudeRuntime>;
};

const defaultClaudeAdapterDependencies: ClaudeAdapterDependencies = {
  loadSdk: loadClaudeSdk,
  resolveRuntime: resolveClaudeRuntime,
};

export function createClaudeAdapter(
  dependencies: ClaudeAdapterDependencies = defaultClaudeAdapterDependencies,
): ReviewAdapter {
  return {
    name: "claude",
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      await dependencies.loadSdk();
      const runtime = await dependencies.resolveRuntime(input.env);

      return {
        checks: [
          {
            name: "auth",
            status: "passed",
            detail:
              runtime.authMode === "api-key"
                ? "ANTHROPIC_API_KEY is present."
                : "Claude Code executable reports authenticated local auth.",
          },
          {
            name: "sdk",
            status: "passed",
            detail: "@anthropic-ai/claude-agent-sdk loaded successfully.",
          },
          {
            name: "model",
            status: "skipped",
            detail: "Claude model capability preflight is not implemented yet.",
          },
          {
            name: "readonly",
            status: "passed",
            detail: "Claude built-in tools are disabled for this adapter path.",
          },
        ],
        metadata: {
          readonlyCapability: "enforced",
          model: input.reviewer.model ?? defaultClaudeModel,
          preferredCaptureMode: "native-structured",
          authMode: runtime.authMode,
          executable: runtime.executable,
        },
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const { query } = await dependencies.loadSdk();
      const runtime = await dependencies.resolveRuntime(input.env);

      try {
        const structuredResult = await runClaudeQuery({
          query,
          input,
          runtime,
          outputFormat: true,
        });

        if (structuredResult.subtype === "success") {
          if (reviewResultSchema.safeParse(structuredResult.structured_output).success) {
            return buildClaudeOutput({
              input,
              result: structuredResult,
              runtime,
              captureMode: "native-structured",
              structured: structuredResult.structured_output,
            });
          }

          const textResult = await runClaudeQuery({
            query,
            input,
            runtime,
            outputFormat: false,
          });
          return buildClaudeTextOutput({
            input,
            result: textResult,
            runtime,
            fallbackReason: "invalid_structured_output",
            previousResult: structuredResult,
          });
        }

        if (structuredResult.subtype === "error_max_structured_output_retries") {
          const textResult = await runClaudeQuery({
            query,
            input,
            runtime,
            outputFormat: false,
          });
          return buildClaudeTextOutput({
            input,
            result: textResult,
            runtime,
            fallbackReason: structuredResult.subtype,
            previousResult: structuredResult,
          });
        }

        throw reviewerFailed(
          `Claude reviewer failed: ${formatClaudeResultError(structuredResult)}`,
        );
      } catch (error) {
        if (error instanceof DiffwardenError) {
          throw error;
        }

        const detail = error instanceof Error ? error.message : String(error);
        throw reviewerFailed(`Claude reviewer failed: ${detail}`);
      }
    },
  };
}

export const claudeAdapter = createClaudeAdapter();

type RunClaudeQueryInput = {
  query: ClaudeSdk["query"];
  input: ReviewAdapterInput;
  runtime: ClaudeRuntime;
  outputFormat: boolean;
};

type ClaudeSdk = {
  query(params: {
    prompt: string;
    options?: ClaudeQueryOptions;
  }): AsyncIterable<ClaudeSdkMessage>;
};

type ClaudeQueryOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  tools?: string[];
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  settingSources?: Array<"user" | "project" | "local">;
  persistSession?: boolean;
  maxTurns?: number;
  pathToClaudeCodeExecutable?: string;
  abortController?: AbortController;
  outputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  };
};

type ClaudeRuntime =
  | {
      authMode: "api-key";
      executable?: undefined;
    }
  | {
      authMode: "claude-code";
      executable: string;
    };

type ClaudeSdkMessage =
  | {
      type: "assistant";
      error?: string;
    }
  | ClaudeResultMessage
  | {
      type: string;
      [key: string]: unknown;
    };

type ClaudeResultMessage = {
  type: "result";
  subtype: string;
  result?: string;
  structured_output?: unknown;
  duration_ms?: number;
  total_cost_usd?: number;
  session_id?: string;
  errors?: string[];
};

async function runClaudeQuery(options: RunClaudeQueryInput): Promise<ClaudeResultMessage> {
  let result: ClaudeResultMessage | undefined;
  const abortBridge = createAbortBridge(options.input.signal);
  const queryOptions = buildClaudeQueryOptions(options, abortBridge.controller);

  try {
    for await (const message of options.query({
      prompt: options.input.prompt,
      options: queryOptions,
    })) {
      if (message.type === "assistant" && message.error === "authentication_failed") {
        throw missingAuth("Claude reviewer authentication failed");
      }

      if (isClaudeResultMessage(message)) {
        result = message;
      }
    }
  } finally {
    abortBridge.dispose();
  }

  if (!result) {
    throw reviewerFailed("Claude reviewer did not return a result");
  }

  return result;
}

function buildClaudeQueryOptions(
  options: RunClaudeQueryInput,
  abortController: AbortController | undefined,
): ClaudeQueryOptions {
  const queryOptions: ClaudeQueryOptions = {
    cwd: options.input.cwd,
    model: options.input.reviewer.model ?? defaultClaudeModel,
    tools: [],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    maxTurns: maxClaudeTurns,
  };

  if (abortController !== undefined) {
    queryOptions.abortController = abortController;
  }

  if (options.outputFormat) {
    queryOptions.outputFormat = {
      type: "json_schema",
      schema: reviewResultJsonSchema,
    };
  }

  if (options.input.env !== undefined) {
    queryOptions.env = options.input.env;
  }

  if (options.runtime.executable !== undefined) {
    queryOptions.pathToClaudeCodeExecutable = options.runtime.executable;
  }

  return queryOptions;
}

function createAbortBridge(signal: AbortSignal | undefined): {
  controller: AbortController | undefined;
  dispose: () => void;
} {
  if (signal === undefined) {
    return { controller: undefined, dispose: () => {} };
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);

  if (signal.aborted) {
    abort();
    return { controller, dispose: () => {} };
  }

  signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener("abort", abort),
  };
}

function buildClaudeTextOutput(options: {
  input: ReviewAdapterInput;
  result: ClaudeResultMessage;
  runtime: ClaudeRuntime;
  fallbackReason: string;
  previousResult?: ClaudeResultMessage;
}): ReviewAdapterOutput {
  if (options.result.subtype !== "success") {
    throw reviewerFailed(`Claude reviewer failed: ${formatClaudeResultError(options.result)}`);
  }

  const outputOptions: Parameters<typeof buildClaudeOutput>[0] = {
    input: options.input,
    result: options.result,
    runtime: options.runtime,
    captureMode: "text",
    text: options.result.result ?? "",
    fallbackReason: options.fallbackReason,
  };

  if (options.previousResult !== undefined) {
    outputOptions.previousResult = options.previousResult;
  }

  return buildClaudeOutput(outputOptions);
}

function buildClaudeOutput(options: {
  input: ReviewAdapterInput;
  result: ClaudeResultMessage;
  runtime: ClaudeRuntime;
  captureMode: "native-structured" | "text";
  structured?: unknown;
  text?: string;
  fallbackReason?: string;
  previousResult?: ClaudeResultMessage;
}): ReviewAdapterOutput {
  const output: ReviewAdapterOutput = {
    metadata: {
      captureMode: options.captureMode,
      sessionId: options.result.session_id,
      readonlyCapability: "enforced",
      model: options.input.reviewer.model ?? defaultClaudeModel,
      durationMs: sumKnownNumbers(options.previousResult?.duration_ms, options.result.duration_ms),
      totalCostUsd: sumKnownNumbers(
        options.previousResult?.total_cost_usd,
        options.result.total_cost_usd,
      ),
      authMode: options.runtime.authMode,
      executable: options.runtime.executable,
    },
  };

  if (options.fallbackReason !== undefined) {
    output.metadata = {
      ...output.metadata,
      fallbackReason: options.fallbackReason,
    };
  }

  if (options.structured !== undefined) {
    output.structured = options.structured;
  } else {
    output.text = options.text ?? "";
  }

  return output;
}

async function loadClaudeSdk(): Promise<ClaudeSdk> {
  try {
    return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeSdk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Failed to load @anthropic-ai/claude-agent-sdk: ${detail}`);
  }
}

async function resolveClaudeRuntime(env: NodeJS.ProcessEnv | undefined): Promise<ClaudeRuntime> {
  const apiKey = env?.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return {
      authMode: "api-key",
    };
  }

  if (await hasClaudeCodeAuth(env)) {
    return {
      authMode: "claude-code",
      executable: defaultClaudeExecutable,
    };
  }

  throw missingAuth(
    "Missing Claude auth: set ANTHROPIC_API_KEY or install and authenticate Claude Code",
  );
}

async function hasClaudeCodeAuth(env: NodeJS.ProcessEnv | undefined): Promise<boolean> {
  try {
    const options: { env?: NodeJS.ProcessEnv; timeout: number } = {
      timeout: 5_000,
    };

    if (env !== undefined) {
      options.env = env;
    }

    const { stdout } = await execFileAsync(
      defaultClaudeExecutable,
      ["auth", "status", "--json"],
      options,
    );
    return isLoggedInClaudeStatus(stdout);
  } catch {
    return false;
  }
}

function isLoggedInClaudeStatus(stdout: string): boolean {
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

function isClaudeResultMessage(message: ClaudeSdkMessage): message is ClaudeResultMessage {
  return message.type === "result" && "subtype" in message && typeof message.subtype === "string";
}

function formatClaudeResultError(result: ClaudeResultMessage): string {
  if (result.errors?.length) {
    return result.errors.join("; ");
  }

  return result.subtype;
}

function sumKnownNumbers(...values: Array<number | undefined>): number | undefined {
  const knownValues = values.filter((value): value is number => value !== undefined);
  if (!knownValues.length) {
    return undefined;
  }

  return knownValues.reduce((sum, value) => sum + value, 0);
}
