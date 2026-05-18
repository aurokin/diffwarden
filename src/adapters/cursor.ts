import type { AgentOptions, SDKAgent } from "@cursor/sdk";
import { missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
import type { ReviewAdapter, ReviewAdapterInput, ReviewAdapterOutput } from "./types.js";

const defaultCursorModel = "composer-2";

export const cursorAdapter: ReviewAdapter = {
  name: "cursor",
  async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
    const apiKey = input.env?.CURSOR_API_KEY?.trim();
    if (!apiKey) {
      throw missingAuth("Missing CURSOR_API_KEY for Cursor reviewer");
    }

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

function isCursorSdkError(error: unknown): error is Error & { isRetryable?: boolean } {
  return error instanceof Error && ("isRetryable" in error || error.name.includes("Cursor"));
}
