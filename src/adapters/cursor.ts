import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentOptions, ModelSelection, RunError } from "@cursor/sdk";
import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerEnvironmentFailed,
  reviewerFailed,
} from "../core/errors.js";
import { defaultReviewerTransport } from "./capabilities.js";
import { cliExecutable } from "./cli-helpers.js";
import { execCliFile, resolveExecutable } from "./cli-process.js";
import {
  cursorReviewAutoReview,
  cursorReviewMcpServers,
  cursorReviewMode,
  cursorReviewSandboxOptions,
  cursorReviewSettingSources,
  cursorReviewTools,
} from "./cursor-policy.js";
import {
  effortResolutionMetadata,
  modelResolutionMetadata,
  sdkOutputMetadata,
  sdkPreflightMetadata,
} from "./metadata.js";
import { activitySinkFromDebugOutput, boundedMarkerName } from "./reviewer-activity.js";
import type {
  ListModelsInput,
  ModelCatalogEntry,
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const defaultCursorModel = "composer-2.5";
const cursorSandboxUnsupportedReason = "cursor_sdk_sandbox_unsupported";
const cursorSandboxUnsupportedRecovery = [
  "Fix or remove Cursor's local sandbox config, for example ~/.cursor/sandbox.json.",
  "Run the Cursor reviewer on a host where Cursor SDK local sandboxing is supported.",
  "Temporarily disable the configured Cursor reviewer with enabled: false.",
] as const;

type CursorAdapterDependencies = {
  loadSdk: () => Promise<CursorSdk>;
};

const defaultCursorAdapterDependencies: CursorAdapterDependencies = {
  loadSdk: loadCursorSdk,
};

export function createCursorAdapter(
  dependencies: CursorAdapterDependencies = defaultCursorAdapterDependencies,
): ReviewAdapter {
  return {
    name: "cursor",
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      const apiKey = assertCursorAuth(input.env);
      const sdk = await dependencies.loadSdk();
      const model = input.reviewer.model ?? defaultCursorModel;
      const modelPreflight = await preflightCursorModel({
        sdk,
        apiKey,
        model,
      });

      return {
        checks: [
          {
            name: "auth",
            status: "passed",
            detail: "CURSOR_API_KEY is present.",
          },
          {
            name: "sdk",
            status: "passed",
            detail: "@cursor/sdk loaded successfully.",
          },
          {
            name: "model",
            status: "passed",
            detail:
              modelPreflight.alias === undefined
                ? `Cursor model is available: ${modelPreflight.canonicalModelId}.`
                : `Cursor model alias is available: ${modelPreflight.alias} -> ${modelPreflight.canonicalModelId}.`,
          },
          {
            name: "readonly",
            status: "passed",
            detail: "Cursor SDK tools are restricted to read, grep, glob, and ls.",
          },
        ],
        metadata: sdkPreflightMetadata("cursor", {
          cursorMode: cursorReviewMode,
          cursorTools: [...cursorReviewTools],
          cursorAutoReview: cursorReviewAutoReview,
          cursorSandboxEnabled: cursorReviewSandboxOptions.enabled,
          cursorSettingSources: cursorReviewSettingSources,
          cursorMcpServers: Object.keys(cursorReviewMcpServers),
          cursorStore: "jsonl-ephemeral",
          model,
          canonicalModel: modelPreflight.canonicalModelId,
          ...(modelPreflight.alias !== undefined ? { modelAlias: modelPreflight.alias } : {}),
          ...modelResolutionMetadata({
            requested: input.reviewer.model,
            resolved: modelPreflight.canonicalModelId,
            source:
              input.reviewer.model === undefined
                ? "adapter-default"
                : input.reviewer.model === modelPreflight.canonicalModelId
                  ? (input.reviewer.modelSource ?? "requested")
                  : "adapter-selection",
          }),
          ...(input.reviewer.effort !== undefined
            ? {
                effort: "ignored",
                ...effortResolutionMetadata({
                  requested: input.reviewer.effort,
                  source: "unsupported",
                }),
              }
            : {}),
        }),
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const apiKey = assertCursorAuth(input.env);
      const configuredModel = input.reviewer.model ?? defaultCursorModel;

      const { Agent, JsonlLocalAgentStore } = await dependencies.loadSdk();
      let agent: CursorAgent | undefined;
      let run: CursorRun | undefined;
      let removeAbortListener: (() => void) | undefined;
      const storeDirectory = await mkdtemp(path.join(tmpdir(), "diffwarden-cursor-sdk-"));

      // Step summaries deliberately feed the artifact's debug_output recorder
      // (mirroring the claude/droid/copilot/pi SDK adapters): raw
      // ConversationSteps embed thinking text and tool args/results (live
      // capture 2026-07-15: a read toolCall result carried the full file
      // body) the debug contract excludes. The SDK invokes onStep inside its
      // own stream loop — the same loop run.wait() already awaits — so the
      // result path gains no new await dependency, and a flag-off run keeps
      // the exact `send(prompt)` invocation (no options argument).
      const activity = activitySinkFromDebugOutput("cursor-sdk", input.debugOutput);

      try {
        const store = new JsonlLocalAgentStore(storeDirectory) as CursorLocalStore;
        agent = await Agent.create({
          apiKey,
          model: {
            id: configuredModel,
          },
          mode: cursorReviewMode,
          tools: [...cursorReviewTools],
          mcpServers: cursorReviewMcpServers,
          local: {
            cwd: input.cwd,
            autoReview: cursorReviewAutoReview,
            sandboxOptions: { ...cursorReviewSandboxOptions },
            settingSources: [...cursorReviewSettingSources],
            store,
          },
        });

        removeAbortListener = bindAbortSignal(input.signal, async () => {
          if (run !== undefined) {
            await cancelCursorRun(run);
            return;
          }

          await disposeCursorAgent(agent);
        });
        throwIfAborted(input.signal, "Cursor reviewer aborted before sending prompt");

        run =
          activity === undefined
            ? await agent.send(input.prompt)
            : await agent.send(input.prompt, {
                // The sink never throws, but the SDK awaits onStep inside its
                // stream loop, so a defensive catch keeps debug plumbing
                // structurally unable to perturb the run.
                onStep: ({ step }) => {
                  try {
                    activity.event(step);
                  } catch {
                    // Debug never fails the review.
                  }
                },
              });
        if (input.signal?.aborted) {
          await cancelCursorRun(run);
          throwIfAborted(input.signal, "Cursor reviewer aborted before waiting for result");
        }

        const result = await run.wait();
        // Adapter-synthesized terminal marker: onStep has no result event.
        activity?.note(
          `[result:${boundedMarkerName(result.status)}${
            result.durationMs !== undefined ? ` duration_ms=${result.durationMs}` : ""
          }]`,
        );

        if (result.status !== "finished") {
          const detail =
            result.error === undefined
              ? ""
              : `: ${result.error.message}${result.error.code === undefined ? "" : ` (${result.error.code})`}`;
          throw reviewerFailed(`Cursor reviewer finished with status: ${result.status}${detail}`);
        }

        const resolvedModel = result.model?.id ?? configuredModel;

        return {
          text: result.result ?? "",
          metadata: sdkOutputMetadata("cursor", {
            // Keyed on the opt-in itself: onStep capture is pure observation,
            // so there is no streaming gate to reflect.
            ...(input.debugOutput !== undefined ? { debugOutputMode: "event-summary" } : {}),
            agentId: agent.agentId,
            runId: run.id,
            cursorMode: cursorReviewMode,
            cursorTools: [...cursorReviewTools],
            cursorAutoReview: cursorReviewAutoReview,
            cursorSandboxEnabled: cursorReviewSandboxOptions.enabled,
            cursorSettingSources: cursorReviewSettingSources,
            cursorMcpServers: Object.keys(cursorReviewMcpServers),
            cursorStore: "jsonl-ephemeral",
            model: resolvedModel,
            ...modelResolutionMetadata({
              requested: input.reviewer.model,
              resolved: resolvedModel,
              source:
                result.model === undefined
                  ? input.reviewer.model === undefined
                    ? "adapter-default"
                    : (input.reviewer.modelSource ?? "requested")
                  : "provider-result",
            }),
            durationMs: result.durationMs,
            ...(input.reviewer.effort !== undefined
              ? {
                  effort: "ignored",
                  ...effortResolutionMetadata({
                    requested: input.reviewer.effort,
                    source: "unsupported",
                  }),
                }
              : {}),
          }),
        };
      } catch (error) {
        if (isCursorAuthenticationError(error)) {
          throw missingAuth(`Cursor reviewer authentication failed: ${error.message}`);
        }
        if (isCursorSandboxUnsupportedError(error)) {
          throw reviewerEnvironmentFailed(formatCursorSandboxUnsupportedError(error.message), {
            reason: cursorSandboxUnsupportedReason,
            recovery: cursorSandboxUnsupportedRecovery,
          });
        }
        if (isCursorSdkError(error)) {
          throw reviewerFailed(`Cursor reviewer failed: ${error.message}`);
        }
        throw error;
      } finally {
        // Success and throw paths both flush; the per-send onStep callback
        // needs no unsubscribe (it dies with the run), and debug teardown
        // never fails the review (sink methods swallow internally).
        activity?.end();
        removeAbortListener?.();
        await disposeCursorAgent(agent);
        await rm(storeDirectory, { force: true, recursive: true });
      }
    },
    async listModels(input: ListModelsInput): Promise<ModelCatalogEntry[]> {
      // Branch on the EFFECTIVE transport (same rule as the catalog session's cache key):
      // the transports genuinely diverge on auth — the SDK requires CURSOR_API_KEY while the
      // CLI carries its own delegated login — so listing must ride the reviewer's transport.
      const transport = input.reviewer.transport ?? defaultReviewerTransport("cursor") ?? "sdk";
      if (transport === "cli") {
        return await listCursorCliModels(input);
      }

      let apiKey: string;
      try {
        apiKey = assertCursorAuth(input.env);
      } catch {
        throw missingAuth("cursor is not authenticated — set CURSOR_API_KEY");
      }
      const sdk = await dependencies.loadSdk();
      try {
        throwIfAborted(input.signal, "Cursor model catalog fetch aborted");
        // models.list takes no signal, so racing the abort is the only cancellation lever;
        // there is no subprocess to tear down, so abandoning the in-flight call is safe.
        const models = await raceCursorAbort(
          sdk.Cursor.models.list({ apiKey }),
          input.signal,
          "Cursor model catalog fetch aborted",
        );
        return models.map(cursorCatalogEntry);
      } catch (error) {
        if (isCursorAuthenticationError(error)) {
          throw missingAuth("cursor is not authenticated — set CURSOR_API_KEY");
        }
        throw error;
      }
    },
  };
}

// No supportedEffortLevels and no default marking: cursor has no effort surface (effort
// variants live in the model id itself) and neither listing surface exposes a default.
function cursorCatalogEntry(model: CursorModel): ModelCatalogEntry {
  return {
    value: model.id,
    ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
    ...(model.description !== undefined ? { description: model.description } : {}),
  };
}

function raceCursorAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reviewerFailed(message));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function listCursorCliModels(input: ListModelsInput): Promise<ModelCatalogEntry[]> {
  // Resolve like every other CLI probe: execCliFile spawns without a shell, so a bare name
  // would miss Windows .cmd/.bat shims that PATHEXT resolution finds.
  const executable = await resolveExecutable(
    cliExecutable(input.reviewer, "cursor-agent"),
    input.env,
  );
  try {
    const { stdout } = await execCliFile(executable, ["models"], {
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      closeStdin: true,
    });
    return parseCursorCliModels(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not (logged|signed) in|unauthorized|unauthenticated|log ?in|authenticat/i.test(detail)) {
      throw missingAuth('cursor is not authenticated — run "cursor-agent login"');
    }
    throw error;
  }
}

/**
 * Parse `cursor-agent models` output: one `<id> - <Display Name>` line per model. Lines that
 * do not match (banners, blank lines) are skipped, so an empty result means no models — the
 * catalog session degrades that to "unavailable" rather than showing an empty picker.
 */
export function parseCursorCliModels(stdout: string): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+-\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.push({ value: match[1], displayName: match[2] });
    }
  }
  return entries;
}

export const cursorAdapter = createCursorAdapter();

type CursorSdk = {
  Agent: {
    create(options: AgentOptions): Promise<CursorAgent>;
  };
  JsonlLocalAgentStore: new (rootDir: string) => unknown;
  Cursor: {
    models: {
      list(options?: { apiKey?: string }): Promise<CursorModel[]>;
    };
  };
};

type CursorLocalStore = NonNullable<NonNullable<AgentOptions["local"]>["store"]>;

type CursorModel = {
  id: string;
  aliases?: string[];
  displayName?: string;
  description?: string;
};

type CursorAgent = {
  agentId: string;
  send(prompt: string, options?: CursorSendOptions): Promise<CursorRun>;
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Structural subset of the SDK's SendOptions: only the onStep callback is
 * used, receiving each synthesized ConversationStep (typed unknown here; the
 * cursor-sdk dialect renderer re-validates every field it reads).
 */
type CursorSendOptions = {
  onStep: (args: { step: unknown }) => void | Promise<void>;
};

type CursorRun = {
  id: string;
  wait(): Promise<{
    status: string;
    result?: string;
    model?: ModelSelection;
    durationMs?: number;
    error?: RunError;
  }>;
  cancel?(): Promise<void> | void;
};

async function loadCursorSdk(): Promise<CursorSdk> {
  try {
    return await import("@cursor/sdk");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Failed to load @cursor/sdk: ${detail}`);
  }
}

async function preflightCursorModel(options: {
  sdk: CursorSdk;
  apiKey: string;
  model: string;
}): Promise<{ canonicalModelId: string; alias?: string }> {
  try {
    const models = await options.sdk.Cursor.models.list({ apiKey: options.apiKey });
    const match = models.find(
      (model) => model.id === options.model || model.aliases?.includes(options.model),
    );

    if (match === undefined) {
      throw new DiffwardenError(
        "invalid_model",
        `Cursor model is not available: ${options.model}`,
        2,
      );
    }

    return {
      canonicalModelId: match.id,
      ...(match.id === options.model ? {} : { alias: options.model }),
    };
  } catch (error) {
    if (error instanceof DiffwardenError) {
      throw error;
    }

    if (isCursorAuthenticationError(error)) {
      throw missingAuth(`Cursor model preflight authentication failed: ${error.message}`);
    }

    if (isCursorSdkError(error)) {
      throw reviewerFailed(`Cursor model preflight failed: ${error.message}`);
    }

    throw error;
  }
}

function assertCursorAuth(env: NodeJS.ProcessEnv | undefined): string {
  const apiKey = env?.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw missingAuth("Missing CURSOR_API_KEY for Cursor reviewer");
  }
  return apiKey;
}

function isCursorSdkError(error: unknown): error is Error & { isRetryable?: boolean } {
  return error instanceof Error && ("isRetryable" in error || error.name.includes("Cursor"));
}

function isCursorSandboxUnsupportedError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (
    message.includes("local sdk sandboxing was requested") &&
    message.includes("sandboxing is not supported")
  ) {
    return true;
  }

  return (
    error.name === "ConfigurationError" &&
    message.includes("sandbox") &&
    (message.includes("not supported") ||
      message.includes("unsupported") ||
      message.includes("missing dependency"))
  );
}

function formatCursorSandboxUnsupportedError(sdkMessage: string): string {
  return [
    "Cursor reviewer environment failure: local SDK sandboxing is enabled, but Cursor reported sandboxing is not supported in this environment.",
    "Diffwarden keeps Cursor sandboxing enabled by default and did not retry unsandboxed.",
    "Fix or remove Cursor's local sandbox config, run on a host with Cursor sandbox support, or disable the configured Cursor reviewer temporarily.",
    `Cursor SDK error: ${sdkMessage}`,
  ].join(" ");
}

function isCursorAuthenticationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "AuthenticationError" ||
      ("status" in error && error.status === 401) ||
      ("code" in error && error.code === "unauthenticated"))
  );
}

function bindAbortSignal(
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void> | void,
): () => void {
  if (signal === undefined) {
    return () => {};
  }

  const abort = (): void => {
    try {
      void Promise.resolve(onAbort()).catch(() => undefined);
    } catch {
      // Cancellation is best-effort; the core timeout error remains authoritative.
    }
  };

  if (signal.aborted) {
    abort();
    return () => {};
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

async function cancelCursorRun(run: unknown): Promise<void> {
  if (!hasCursorRunCancel(run)) {
    return;
  }

  await run.cancel();
}

async function disposeCursorAgent(agent: CursorAgent | undefined): Promise<void> {
  await agent?.[Symbol.asyncDispose]();
}

function hasCursorRunCancel(value: unknown): value is { cancel(): Promise<void> | void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "cancel" in value &&
    typeof value.cancel === "function"
  );
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw reviewerFailed(message);
}
