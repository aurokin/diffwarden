import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AvailableModelConfig,
  CreateSessionOptions,
  DroidResultMessage,
  OutputFormat,
  ReasoningEffort,
  SessionSettings,
} from "@factory/droid-sdk";
import { normalizeStructuredOrTextAdapterOutput } from "../core/adapter-output.js";
import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import { reviewResultJsonSchema } from "../core/schema.js";
import { resolveExecutable } from "./cli-process.js";
import { droidSessionTag } from "./droid-session.js";
import {
  droidSdkReviewAllowedToolList,
  droidSdkReviewPolicyMetadata,
} from "./droid-tool-policy.js";
import {
  effortResolutionMetadata,
  modelResolutionMetadata,
  sdkOutputMetadata,
  sdkPreflightMetadata,
} from "./metadata.js";
import { activitySinkFromDebugOutput } from "./reviewer-activity.js";
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

type DroidRunContext = {
  kind: "droid";
  resolvedExecutable: string;
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
      return (await prepareDroidAdapter(dependencies, input)).preflight;
    },
    async prepare(input: ReviewAdapterPreflightInput) {
      return prepareDroidAdapter(dependencies, input);
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const sdk = await dependencies.loadSdk();
      const executable =
        droidRunContext(input.runContext)?.resolvedExecutable ?? droidExecutable(input.reviewer);
      const effort = droidEffort(input.reviewer.effort);
      const machineId = droidMachineId(input.reviewer);
      let resolvedSettings: ResolvedDroidSettings | undefined;

      try {
        const session = await sdk.createSession({
          cwd: input.cwd,
          ...(machineId !== undefined ? { machineId } : {}),
          execPath: executable,
          interactionMode: sdk.DroidInteractionMode.Spec,
          autonomyLevel: sdk.AutonomyLevel.Off,
          enabledToolIds: droidSdkReviewAllowedToolList(),
          tags: [droidSessionTag(input, "sdk")],
          ...(input.env !== undefined ? { env: stringEnv(droidProcessEnv(input.env)) } : {}),
          ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
          ...(input.reviewer.model !== undefined ? { specModeModelId: input.reviewer.model } : {}),
          ...(effort !== undefined ? { specModeReasoningEffort: effort } : {}),
        } satisfies CreateSessionOptions);
        resolvedSettings = resolveDroidSettings(session.initResult.settings);

        let appliedEffort = effort;
        if (input.reviewer.effort === "off") {
          const disable = droidDisableEffort(
            session.initResult.availableModels,
            resolvedSettings.model,
          );
          if (disable !== undefined) {
            try {
              await session.updateSettings({ specModeReasoningEffort: disable });
            } catch (error) {
              // The session-closing finally below only wraps the stream loop; a
              // failed settings update must not leak the session subprocess.
              await session.close().catch(() => undefined);
              throw error;
            }
            appliedEffort = disable;
            resolvedSettings = { ...resolvedSettings, effort: disable };
          }
        }

        let result: DroidResultMessage | undefined;
        // Event summaries deliberately feed both the live debug events and the
        // artifact's debug_output recorder (mirroring
        // createCliStreamDebugCapture): raw SDK messages embed reasoning
        // content the debug contract excludes. Observation only — the stream
        // invocation is identical either way, and the default non-partial
        // overload (includePartialMessages off) never emits thinking events.
        const activity = activitySinkFromDebugOutput("droid-sdk", input.debugOutput);
        try {
          for await (const message of session.stream(input.prompt, {
            outputFormat: {
              type: sdk.OutputFormatType.JsonSchema,
              schema: reviewResultJsonSchema as Record<string, unknown>,
            } as OutputFormat,
            ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
          })) {
            activity?.event(message);
            if (message.type === sdk.DroidMessageType.Result) {
              result = message;
            }
          }
        } finally {
          activity?.end();
          await session.close().catch(() => undefined);
        }

        if (result === undefined) {
          throw reviewerFailed("Droid reviewer did not return a result");
        }

        if (result.error !== null || !result.success) {
          throw reviewerFailed(`Droid reviewer failed: ${droidResultError(result)}`);
        }

        const output = normalizeStructuredOrTextAdapterOutput({
          structured: result.structuredOutput,
          text: result.text,
          usage: result.tokenUsage ?? undefined,
          fallbackReason: "invalid_structured_output",
          metadata: droidOutputMetadata(
            input.reviewer,
            result,
            executable,
            appliedEffort,
            machineId,
            resolvedSettings,
            {
              captureMode: "native-structured",
              // Keyed on the opt-in itself: SDK debug capture is pure
              // observation, so there is no streaming gate to reflect.
              ...(input.debugOutput !== undefined ? { debugOutputMode: "event-summary" } : {}),
            },
          ),
        });
        if (output !== undefined) {
          return output;
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

async function prepareDroidAdapter(
  dependencies: DroidAdapterDependencies,
  input: ReviewAdapterPreflightInput,
): Promise<{ preflight: ReviewAdapterPreflightResult; runContext: DroidRunContext }> {
  const sdk = await dependencies.loadSdk();
  const executable = droidExecutable(input.reviewer);
  const resolvedExecutable = await dependencies.checkExecutable(
    executable,
    droidProcessEnv(input.env),
    input.signal,
  );
  const effort = droidEffort(input.reviewer.effort);
  const machineId = droidMachineId(input.reviewer);

  return {
    preflight: {
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
          detail:
            "Droid runs in spec interaction mode with autonomy off for read-only review operations.",
        },
        {
          name: "tools",
          status: "passed",
          detail: "Droid SDK review tools are explicitly allowlisted.",
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
        {
          name: "machine",
          status: machineId === undefined ? "skipped" : "passed",
          detail:
            machineId === undefined
              ? "Using Droid's default machine selection."
              : `Passing Droid machine override: ${machineId}.`,
        },
      ],
      metadata: sdkPreflightMetadata("droid", {
        ...droidSdkReviewPolicyMetadata(),
        executable: resolvedExecutable,
        ...(input.reviewer.model !== undefined ? { model: input.reviewer.model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(machineId !== undefined ? { machineId } : {}),
        sdkVersion: sdk.SDK_VERSION,
      }),
    },
    runContext: {
      kind: "droid",
      resolvedExecutable,
    },
  };
}

function droidRunContext(value: unknown): DroidRunContext | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "droid" ||
    !("resolvedExecutable" in value) ||
    typeof value.resolvedExecutable !== "string"
  ) {
    return undefined;
  }

  return value as DroidRunContext;
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
  if (signal?.aborted) {
    throw reviewerFailed("Droid executable check aborted");
  }

  const resolvedExecutable = await resolveExecutable(executable, env);
  try {
    await execFileAsync(resolvedExecutable, ["--version"], { env, signal });
    return resolvedExecutable;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw missingRequirement(`Droid executable not found: ${resolvedExecutable}`);
    }
    throw reviewerFailed(`Droid executable check failed: ${errorMessage(error)}`);
  }
}

function droidExecutable(reviewer: ReviewReviewerConfig): string {
  const sdkExecutable = reviewer.sdkOptions?.executable;
  if (typeof sdkExecutable === "string" && sdkExecutable.trim()) {
    return sdkExecutable;
  }

  const cliExecutable = reviewer.cliOptions?.executable;
  if (typeof cliExecutable === "string" && cliExecutable.trim()) {
    return cliExecutable;
  }

  return defaultDroidExecutable;
}

function droidMachineId(reviewer: ReviewReviewerConfig): string | undefined {
  const machineId = reviewer.sdkOptions?.machineId;
  return typeof machineId === "string" && machineId.trim() ? machineId : undefined;
}

function droidEffort(effort: string | undefined): ReasoningEffort | undefined {
  if (effort === undefined || effort === "off") {
    return undefined;
  }
  return (effort === "minimal" ? "low" : effort) as ReasoningEffort;
}

/**
 * Droid models advertise different native disable values ("off" for the claude/glm families,
 * "none" for the auto router and gpt-5.6 family), and omitting the effort param runs the
 * model's default effort — not disabled. availableModels only arrives in the createSession
 * init result, so "off" is applied post-init via updateSettings. Models advertising neither
 * value keep the session default (omission).
 */
function droidDisableEffort(
  availableModels: readonly AvailableModelConfig[] | undefined,
  model: string,
): ReasoningEffort | undefined {
  const entry = availableModels?.find(
    (candidate) => candidate.id === model || candidate.modelId === model,
  );
  const supported = entry?.supportedReasoningEfforts;
  if (supported?.includes("off" as ReasoningEffort)) {
    return "off" as ReasoningEffort;
  }
  if (supported?.includes("none" as ReasoningEffort)) {
    return "none" as ReasoningEffort;
  }
  return undefined;
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
  machineId: string | undefined,
  resolvedSettings: ResolvedDroidSettings | undefined,
  extra: NonNullable<ReviewAdapterOutput["metadata"]>,
): NonNullable<ReviewAdapterOutput["metadata"]> {
  return sdkOutputMetadata("droid", {
    ...extra,
    ...droidSdkReviewPolicyMetadata(),
    executable,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    turnCount: result.turnCount,
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...modelResolutionMetadata({
      requested: reviewer.model,
      resolved: resolvedSettings?.model,
      source: "provider-init",
    }),
    ...(effort !== undefined ? { effort } : {}),
    ...effortResolutionMetadata({
      requested: reviewer.effort,
      resolved: resolvedSettings?.effort,
      source: "provider-init",
    }),
    ...(machineId !== undefined ? { machineId } : {}),
  });
}

type ResolvedDroidSettings = {
  model: string;
  effort: string;
};

function resolveDroidSettings(settings: SessionSettings): ResolvedDroidSettings {
  return {
    model: settings.specModeModelId ?? settings.modelId,
    effort: settings.specModeReasoningEffort ?? settings.reasoningEffort,
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
