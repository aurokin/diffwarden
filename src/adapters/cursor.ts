import type { AgentOptions } from "@cursor/sdk";
import { missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const defaultCursorModel = "composer-2";

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
      assertCursorAuth(input.env);
      await dependencies.loadSdk();

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
            status: "skipped",
            detail: "Cursor model-list preflight is not implemented yet.",
          },
          {
            name: "readonly",
            status: "warning",
            detail:
              "Cursor local mode is constrained by prompt instructions, not tool-level enforcement.",
          },
        ],
        metadata: {
          readonlyCapability: "prompt-only",
          model: input.reviewer.model ?? defaultCursorModel,
          ...(input.reviewer.effort !== undefined
            ? {
                effort: "ignored",
                requestedEffort: input.reviewer.effort,
              }
            : {}),
        },
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const apiKey = assertCursorAuth(input.env);

      const { Agent } = await dependencies.loadSdk();
      let agent: CursorAgent | undefined;
      let run: CursorRun | undefined;
      let removeAbortListener: (() => void) | undefined;

      try {
        agent = await Agent.create({
          apiKey,
          model: {
            id: input.reviewer.model ?? defaultCursorModel,
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
          metadata: {
            captureMode: "text",
            agentId: agent.agentId,
            runId: run.id,
            readonlyCapability: "prompt-only",
            model: result.model,
            durationMs: result.durationMs,
            ...(input.reviewer.effort !== undefined
              ? {
                  effort: "ignored",
                  requestedEffort: input.reviewer.effort,
                }
              : {}),
          },
        };
      } catch (error) {
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
