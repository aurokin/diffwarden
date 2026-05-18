import type { ReviewTargetResolved } from "../core/schema.js";

export type ReviewAdapterInput = {
  cwd: string;
  reviewer: ReviewReviewerConfig;
  target: ReviewTargetResolved;
  diff: string;
  changedFiles: string[];
  prompt: string;
  timeoutMs?: number;
  readonly: boolean;
  env?: NodeJS.ProcessEnv;
};

export type ReviewReviewerConfig = {
  id: string;
  sdk: "fake" | "cursor";
  profile?: string;
  model?: string;
  effort?: string;
  readonly: boolean;
};

export type ReviewAdapterOutput = {
  text?: string;
  structured?: unknown;
  usage?: unknown;
  metadata?: {
    captureMode?: "native-structured" | "tool-call" | "text";
    agentId?: string;
    runId?: string;
    readonlyCapability?: "enforced" | "tool-restricted" | "prompt-only";
    [key: string]: unknown;
  };
};

export interface ReviewAdapter {
  name: ReviewReviewerConfig["sdk"];
  run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput>;
}
