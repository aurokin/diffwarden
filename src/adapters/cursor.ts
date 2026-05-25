import type { AgentOptions } from "@cursor/sdk";
import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import {
  effortResolutionMetadata,
  modelResolutionMetadata,
  sdkOutputMetadata,
  sdkPreflightMetadata,
} from "./metadata.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const defaultCursorModel = "composer-2.5";

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
            status: "warning",
            detail:
              "Cursor local mode is constrained by prompt instructions, not tool-level enforcement.",
          },
        ],
        metadata: sdkPreflightMetadata("cursor", {
          model,
          canonicalModel: modelPreflight.canonicalModelId,
          ...(modelPreflight.alias !== undefined ? { modelAlias: modelPreflight.alias } : {}),
          ...modelResolutionMetadata({
            requested: input.reviewer.model,
            resolved: modelPreflight.canonicalModelId,
            source: input.reviewer.model === undefined ? "adapter-default" : "adapter-selection",
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

      const { Agent } = await dependencies.loadSdk();
      let agent: CursorAgent | undefined;
      let run: CursorRun | undefined;
      let removeAbortListener: (() => void) | undefined;

      try {
        agent = await Agent.create({
          apiKey,
          model: {
            id: configuredModel,
          },
          local: {
            cwd: input.cwd,
            settingSources: [],
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

        run = await agent.send(input.prompt);
        if (input.signal?.aborted) {
          await cancelCursorRun(run);
          throwIfAborted(input.signal, "Cursor reviewer aborted before waiting for result");
        }

        const result = await run.wait();

        if (result.status !== "finished") {
          throw reviewerFailed(`Cursor reviewer finished with status: ${result.status}`);
        }

        return {
          text: result.result ?? "",
          metadata: sdkOutputMetadata("cursor", {
            agentId: agent.agentId,
            runId: run.id,
            model: result.model ?? configuredModel,
            ...modelResolutionMetadata({
              requested: input.reviewer.model,
              resolved: result.model ?? configuredModel,
              source:
                result.model === undefined
                  ? input.reviewer.model === undefined
                    ? "adapter-default"
                    : "requested"
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
        if (isCursorSdkError(error)) {
          throw reviewerFailed(`Cursor reviewer failed: ${error.message}`);
        }
        throw error;
      } finally {
        removeAbortListener?.();
        await disposeCursorAgent(agent);
      }
    },
  };
}

export const cursorAdapter = createCursorAdapter();

type CursorSdk = {
  Agent: {
    create(options: AgentOptions): Promise<CursorAgent>;
  };
  Cursor: {
    models: {
      list(options?: { apiKey?: string }): Promise<CursorModel[]>;
    };
  };
};

type CursorModel = {
  id: string;
  aliases?: string[];
};

type CursorAgent = {
  agentId: string;
  send(prompt: string): Promise<CursorRun>;
  [Symbol.asyncDispose](): Promise<void>;
};

type CursorRun = {
  id: string;
  wait(): Promise<{
    status: string;
    result?: string;
    model?: string;
    durationMs?: number;
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
