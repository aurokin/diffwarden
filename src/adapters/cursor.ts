import type { AgentOptions, SDKAgent } from "@cursor/sdk";
import { missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const defaultCursorModel = "composer-2";

export const cursorAdapter: ReviewAdapter = {
  name: "cursor",
  async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
    assertCursorAuth(input.env);
    await loadCursorSdk();

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
      },
    };
  },
  async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
    const apiKey = assertCursorAuth(input.env);

    const { Agent } = await loadCursorSdk();
    let agent: SDKAgent | undefined;

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

      const run = await agent.send(input.prompt);
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
        },
      };
    } catch (error) {
      if (isCursorSdkError(error)) {
        throw reviewerFailed(`Cursor reviewer failed: ${error.message}`);
      }
      throw error;
    } finally {
      await agent?.[Symbol.asyncDispose]();
    }
  },
};

type CursorSdk = {
  Agent: {
    create(options: AgentOptions): Promise<SDKAgent>;
  };
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
