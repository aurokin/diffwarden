import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CreateSessionOptions,
  DroidResultMessage,
  ModelInfo,
  OutputFormat,
  ReasoningEffort,
  SessionSettings,
} from "@factory/droid-sdk/node";
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
  ListModelsInput,
  ModelCatalogEntry,
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerConfig,
} from "./types.js";

// Droid SDK 0.9 moved local subprocess sessions to the Node entrypoint.
const droidPackageName = "@factory/droid-sdk";
const defaultDroidExecutable = "droid";
const execFileAsync = promisify(execFile);

type DroidSdk = typeof import("@factory/droid-sdk/node");

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
          autoRejectPermissionRequests: true,
          disableBuiltinSkills: true,
          apiKey: requireDroidApiKey(input.env),
          tags: [droidSessionTag(input, "sdk")],
          ...(input.env !== undefined ? { env: stringEnv(droidProcessEnv(input.env)) } : {}),
          ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
          ...(input.reviewer.model !== undefined ? { specModeModelId: input.reviewer.model } : {}),
          ...(effort !== undefined ? { specModeReasoningEffort: effort } : {}),
        } satisfies CreateSessionOptions);
        try {
          const tools = await session.listTools();
          const allowed = new Set(droidSdkReviewAllowedToolList());
          // SDK 0.9.1 only exposes a denylist. Derive it from the runtime inventory,
          // then require the exact read-only tool set before sending any prompt.
          const disabledToolIds = tools
            .filter((tool) => !allowed.has(tool.id))
            .map((tool) => tool.id);
          if (disabledToolIds.length > 0) await session.updateSettings({ disabledToolIds });
          const actual = (await session.listTools())
            .filter((tool) => tool.allowed)
            .map((tool) => tool.id);
          if (
            actual.some((id) => !allowed.has(id)) ||
            [...allowed].some((id) => !actual.includes(id))
          ) {
            throw missingRequirement("Droid SDK runtime did not enforce the review tool allowlist");
          }
        } catch (error) {
          await session.close().catch(() => undefined);
          throw error;
        }
        resolvedSettings = resolveDroidSettings(session.settings);

        let appliedEffort = effort;
        if (input.reviewer.effort === "off") {
          try {
            const disable = droidDisableEffort(
              await listDroidModels(sdk, input, executable),
              resolvedSettings.model,
            );
            if (disable !== undefined) {
              await session.updateSettings({ specModeReasoningEffort: disable });
              appliedEffort = disable;
              resolvedSettings = { ...resolvedSettings, effort: disable };
            }
          } catch (error) {
            await session.close().catch(() => undefined);
            throw error;
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
    async listModels(input: ListModelsInput): Promise<ModelCatalogEntry[]> {
      const sdk = await dependencies.loadSdk();
      if (input.signal?.aborted) {
        throw reviewerFailed("Droid model catalog fetch aborted");
      }
      try {
        const models = await listDroidModels(sdk, input, droidExecutable(input.reviewer));
        return droidModelCatalogEntries(models, droidEffectiveTransport(input.reviewer));
      } catch (error) {
        if (error instanceof DiffwardenError) {
          throw error;
        }
        const detail = errorMessage(error);
        if (isDroidMissingAuth(detail)) {
          throw missingAuth("Droid SDK requires FACTORY_API_KEY");
        }
        if (isDroidMissingExecutable(detail)) {
          throw missingRequirement(`Droid executable is unavailable: ${detail}`);
        }
        throw reviewerFailed(`Droid model catalog fetch failed: ${detail}`);
      }
    },
  };
}

function droidEffectiveTransport(reviewer: ReviewReviewerConfig): "sdk" | "cli" {
  return reviewer.transport === "cli" ? "cli" : "sdk";
}

/**
 * Map Droid model discovery results into catalog entries, narrowing each model's
 * effort levels to exactly what diffwarden can deliver over the effective transport:
 *
 * - keep native low/medium/high/xhigh verbatim (both delivery paths pass them through);
 * - drop native `none`/`off`/`minimal` from the passthrough — diffwarden translates its own
 *   vocabulary on delivery (off via updateSettings post-init, minimal → low), so the raw
 *   values would commit params the translation layer never produces;
 * - include "minimal" whenever "low" survives (delivery maps minimal → native low);
 * - include "off" only on the sdk transport, when the model advertises native `off` OR `none`
 *   (exactly droidDisableEffort's rule); the cli transport delivers off by OMITTING the
 *   effort flag, which runs the model default — not disabled — so cli emits no "off";
 * - keep native `max` on sdk (droidEffort delivers it verbatim), drop it on cli
 *   (`droidCliEffort` collapses max → xhigh, undeliverable for max-but-not-xhigh models);
 * - models whose deliverable set comes out empty (e.g. the none-only "auto" router on cli)
 *   stay un-narrowed rather than collapsing the effort menu to nothing.
 *
 * `deprecated: true` models stay selectable but are marked in the description.
 */
export function droidModelCatalogEntries(
  models: unknown,
  effectiveTransport: "sdk" | "cli",
): ModelCatalogEntry[] {
  if (!Array.isArray(models)) {
    return [];
  }
  const entries: ModelCatalogEntry[] = [];
  for (const item of models) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id === "") {
      continue;
    }
    const native = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.filter((level): level is string => typeof level === "string")
      : [];
    const efforts = native.filter(
      (level) =>
        level !== "none" &&
        level !== "off" &&
        level !== "minimal" &&
        (effectiveTransport === "sdk" || level !== "max"),
    );
    const offEligible =
      effectiveTransport === "sdk" && (native.includes("off") || native.includes("none"));
    const levels =
      efforts.length > 0 || offEligible
        ? [
            ...(offEligible ? ["off"] : []),
            ...(efforts.includes("low") ? ["minimal"] : []),
            ...efforts,
          ]
        : [];
    entries.push({
      value: item.id,
      ...(typeof item.displayName === "string" ? { displayName: item.displayName } : {}),
      ...(item.deprecated === true ? { description: "deprecated" } : {}),
      ...(levels.length > 0 ? { supportedEffortLevels: levels } : {}),
    });
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function prepareDroidAdapter(
  dependencies: DroidAdapterDependencies,
  input: ReviewAdapterPreflightInput,
): Promise<{ preflight: ReviewAdapterPreflightResult; runContext: DroidRunContext }> {
  const sdk = await dependencies.loadSdk();
  requireDroidApiKey(input.env);
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
          status: "passed",
          detail: "FACTORY_API_KEY is present.",
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
    return await import("@factory/droid-sdk/node");
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
 * model's default effort — not disabled. The discovery API supplies model capabilities, so "off" is applied post-init via updateSettings. Models advertising neither
 * value keep the session default (omission).
 */
function droidDisableEffort(
  availableModels: readonly ModelInfo[] | undefined,
  model: string,
): ReasoningEffort | undefined {
  const entry = availableModels?.find((candidate) => candidate.id === model);
  const supported = entry?.supportedReasoningEfforts;
  if (supported?.includes("off" as ReasoningEffort)) {
    return "off" as ReasoningEffort;
  }
  if (supported?.includes("none" as ReasoningEffort)) {
    return "none" as ReasoningEffort;
  }
  return undefined;
}

function requireDroidApiKey(env: NodeJS.ProcessEnv | undefined): string {
  const key = (env ?? process.env).FACTORY_API_KEY?.trim();
  if (!key) throw missingAuth("Droid SDK requires FACTORY_API_KEY");
  return key;
}

/** Own the client so cancellation rejects pending requests and clears their timers. */
async function listDroidModels(
  sdk: DroidSdk,
  input: Pick<ListModelsInput, "cwd" | "env" | "signal">,
  executable: string,
): Promise<ModelInfo[]> {
  input.signal?.throwIfAborted();
  const transport = new sdk.ProcessTransport({
    droidExecPath: executable,
    cwd: input.cwd ?? process.cwd(),
    env: {
      ...stringEnv(droidProcessEnv(input.env)),
      FACTORY_API_KEY: requireDroidApiKey(input.env),
    },
  });
  const client = new sdk.DroidClient({ transport });
  const abort = () => {
    void client.close().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await transport.connect();
    input.signal?.throwIfAborted();
    const response = await client.listModels();
    if (response.error !== undefined) throw new Error(response.error.message);
    // Droid validates successful model payloads, but its error union leaves result unknown.
    return (response.result as { models: ModelInfo[] }).models;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await client.close().catch(() => undefined);
  }
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
