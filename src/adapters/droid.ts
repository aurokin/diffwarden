import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OutputFormat, ReasoningEffort, RunOptions } from "@factory/droid-sdk";
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
  ReviewReviewerConfig,
} from "./types.js";

const droidPackageName = "@factory/droid-sdk";
const defaultDroidExecutable = "droid";
const execFileAsync = promisify(execFile);

type DroidSdk = typeof import("@factory/droid-sdk");

type DroidAdapterDependencies = {
  loadSdk: () => Promise<DroidSdk>;
  checkExecutable: (
    executable: string,
    env: NodeJS.ProcessEnv | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<string>;
};

const defaultDroidAdapterDependencies: DroidAdapterDependencies = {
  loadSdk: loadDroidSdk,
  checkExecutable: checkDroidExecutable,
};

export function createDroidAdapter(
  dependencies: DroidAdapterDependencies = defaultDroidAdapterDependencies,
): ReviewAdapter {
  return {
    name: "droid",
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      const sdk = await dependencies.loadSdk();
      const executable = droidExecutable(input.reviewer);
      const resolvedExecutable = await dependencies.checkExecutable(
        executable,
        droidProcessEnv(input.env),
        input.signal,
      );
      const effort = droidEffort(input.reviewer.effort);

      return {
        checks: [
          {
            name: "sdk",
            status: "passed",
            detail: `${droidPackageName} loaded successfully.`,
          },
          {
            name: "executable",
            status: "passed",
            detail: `Using ${resolvedExecutable}.`,
          },
          {
            name: "auth",
            status: hasFactoryApiKey(input.env) ? "passed" : "warning",
            detail: hasFactoryApiKey(input.env)
              ? "FACTORY_API_KEY is present."
              : "FACTORY_API_KEY is absent; local Droid auth may still work.",
          },
          {
            name: "readonly",
            status: "passed",
            detail: "Droid runs in spec interaction mode for read-only review operations.",
          },
          {
            name: "model",
            status: input.reviewer.model === undefined ? "skipped" : "passed",
            detail:
              input.reviewer.model === undefined
                ? "Using Droid's default model."
                : `Passing model override to Droid: ${input.reviewer.model}.`,
          },
          {
            name: "effort",
            status: effort === undefined ? "skipped" : "passed",
            detail:
              effort === undefined
                ? "No effort override was requested."
                : `Passing reasoning effort to Droid: ${effort}.`,
          },
        ],
        metadata: {
          readonlyCapability: "enforced",
          preferredCaptureMode: "native-structured",
          executable: resolvedExecutable,
          transport: "sdk",
          ...(input.reviewer.model !== undefined ? { model: input.reviewer.model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          sdkVersion: sdk.SDK_VERSION,
        },
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const sdk = await dependencies.loadSdk();
      const executable = droidExecutable(input.reviewer);
      const effort = droidEffort(input.reviewer.effort);

      try {
        const result = await sdk.run(input.prompt, {
          cwd: input.cwd,
          execPath: executable,
          interactionMode: sdk.DroidInteractionMode.Spec,
          autonomyLevel: sdk.AutonomyLevel.Off,
          outputFormat: {
            type: sdk.OutputFormatType.JsonSchema,
            schema: reviewResultJsonSchema as Record<string, unknown>,
          } as OutputFormat,
          ...(input.env !== undefined ? { env: stringEnv(droidProcessEnv(input.env)) } : {}),
          ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
          ...(input.reviewer.model !== undefined ? { specModeModelId: input.reviewer.model } : {}),
          ...(effort !== undefined ? { specModeReasoningEffort: effort } : {}),
        } satisfies RunOptions);

        if (result.error !== null || !result.success) {
          throw reviewerFailed(`Droid reviewer failed: ${droidResultError(result)}`);
        }

        const structured = reviewResultSchema.safeParse(result.structuredOutput);
        if (structured.success) {
          return {
            structured: structured.data,
            usage: result.tokenUsage ?? undefined,
            metadata: droidOutputMetadata(input.reviewer, result, executable, effort, {
              captureMode: "native-structured",
            }),
          };
        }

        const text = result.text.trim();
        if (text.length > 0) {
          return {
            text,
            usage: result.tokenUsage ?? undefined,
            metadata: droidOutputMetadata(input.reviewer, result, executable, effort, {
              captureMode: "text",
              fallbackReason: "invalid_structured_output",
            }),
          };
        }

        throw reviewerFailed("Droid reviewer returned neither valid structured output nor text");
      } catch (error) {
        if (error instanceof DiffwardenError) {
          throw error;
        }

        const detail = errorMessage(error);
        if (isDroidMissingAuth(detail)) {
          throw missingAuth(`Droid authentication failed: ${detail}`);
        }
        if (isDroidMissingExecutable(detail)) {
          throw missingRequirement(`Droid executable is unavailable: ${detail}`);
        }
        throw reviewerFailed(`Droid reviewer failed: ${detail}`);
      }
    },
  };
}

export const droidAdapter = createDroidAdapter();

async function loadDroidSdk(): Promise<DroidSdk> {
  try {
    return await import("@factory/droid-sdk");
  } catch (error) {
    throw missingRequirement(`Failed to load ${droidPackageName}: ${errorMessage(error)}`);
  }
}

async function checkDroidExecutable(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    await execFileAsync(executable, ["--version"], { env, signal });
    return executable;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw missingRequirement(`Droid executable not found: ${executable}`);
    }
    throw reviewerFailed(`Droid executable check failed: ${errorMessage(error)}`);
  }
}

function droidExecutable(reviewer: ReviewReviewerConfig): string {
  const executable = reviewer.cliOptions?.executable ?? reviewer.sdkOptions?.executable;
  return typeof executable === "string" && executable.trim() ? executable : defaultDroidExecutable;
}

function droidEffort(effort: string | undefined): ReasoningEffort | undefined {
  if (effort === undefined || effort === "off") {
    return undefined;
  }
  return (effort === "minimal" ? "low" : effort) as ReasoningEffort;
}

function hasFactoryApiKey(env: NodeJS.ProcessEnv | undefined): boolean {
  const source = env ?? process.env;
  return (source.FACTORY_API_KEY ?? "").trim().length > 0;
}

function droidProcessEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  if (env === undefined) {
    return process.env;
  }

  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...env,
  };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function droidOutputMetadata(
  reviewer: ReviewReviewerConfig,
  result: { sessionId: string; durationMs: number; turnCount: number },
  executable: string,
  effort: ReasoningEffort | undefined,
  extra: NonNullable<ReviewAdapterOutput["metadata"]>,
): NonNullable<ReviewAdapterOutput["metadata"]> {
  return {
    ...extra,
    readonlyCapability: "enforced",
    transport: "sdk",
    executable,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    turnCount: result.turnCount,
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

function droidResultError(result: { error: unknown }): string {
  if (result.error === null || result.error === undefined) {
    return "Droid run did not complete successfully";
  }
  if (typeof result.error === "string") {
    return result.error;
  }
  if (typeof result.error === "object" && "message" in result.error) {
    return String(result.error.message);
  }
  return String(result.error);
}

function isDroidMissingAuth(detail: string): boolean {
  return /\b(auth|authentication|login|logged in|api key|FACTORY_API_KEY|unauthorized|401|403)\b/i.test(
    detail,
  );
}

function isDroidMissingExecutable(detail: string): boolean {
  return /\b(ENOENT|command not found|executable (?:not found|is unavailable|is missing)|no such file or directory)\b/i.test(
    detail,
  );
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
