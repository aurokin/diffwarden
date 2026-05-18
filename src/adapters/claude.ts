import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const defaultClaudeModel = "claude-sonnet-4-6";

export const claudeAdapter: ReviewAdapter = {
  name: "claude",
  async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
    assertClaudeAuth(input.env);
    await loadClaudeSdk();

    return {
      checks: [
        {
          name: "auth",
          status: "passed",
          detail: "ANTHROPIC_API_KEY is present.",
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
        captureMode: "text",
      },
    };
  },
  async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
    assertClaudeAuth(input.env);
    const { query } = await loadClaudeSdk();

    try {
      let result: ClaudeResultMessage | undefined;
      const options: ClaudeQueryOptions = {
        cwd: input.cwd,
        model: input.reviewer.model ?? defaultClaudeModel,
        tools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
      };

      if (input.env !== undefined) {
        options.env = input.env;
      }

      for await (const message of query({
        prompt: input.prompt,
        options,
      })) {
        if (message.type === "assistant" && message.error === "authentication_failed") {
          throw missingAuth("Claude reviewer authentication failed");
        }

        if (isClaudeResultMessage(message)) {
          result = message;
        }
      }

      if (!result) {
        throw reviewerFailed("Claude reviewer did not return a result");
      }

      if (result.subtype !== "success") {
        throw reviewerFailed(`Claude reviewer failed: ${formatClaudeResultError(result)}`);
      }

      return {
        text: result.result ?? "",
        metadata: {
          captureMode: "text",
          sessionId: result.session_id,
          readonlyCapability: "enforced",
          model: input.reviewer.model ?? defaultClaudeModel,
          durationMs: result.duration_ms,
          totalCostUsd: result.total_cost_usd,
        },
      };
    } catch (error) {
      if (error instanceof DiffwardenError) {
        throw error;
      }

      const detail = error instanceof Error ? error.message : String(error);
      throw reviewerFailed(`Claude reviewer failed: ${detail}`);
    }
  },
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
  duration_ms?: number;
  total_cost_usd?: number;
  session_id?: string;
  errors?: string[];
};

async function loadClaudeSdk(): Promise<ClaudeSdk> {
  try {
    return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeSdk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Failed to load @anthropic-ai/claude-agent-sdk: ${detail}`);
  }
}

function assertClaudeAuth(env: NodeJS.ProcessEnv | undefined): string {
  const apiKey = env?.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw missingAuth("Missing ANTHROPIC_API_KEY for Claude reviewer");
  }
  return apiKey;
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
