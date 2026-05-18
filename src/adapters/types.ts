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

export type ReviewAdapterPreflightInput = {
  cwd: string;
  reviewer: ReviewReviewerConfig;
  readonly: boolean;
  env?: NodeJS.ProcessEnv;
};

export type ReviewAdapterPreflightCheck = {
  name: string;
  status: "passed" | "skipped" | "warning";
  detail?: string;
};

export type ReviewAdapterPreflightResult = {
  checks: ReviewAdapterPreflightCheck[];
  metadata?: {
    readonlyCapability?: "enforced" | "tool-restricted" | "prompt-only";
    model?: string;
    effort?: string;
    [key: string]: unknown;
  };
};

export interface ReviewAdapter {
  name: ReviewReviewerConfig["sdk"];
  preflight?(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult>;
  run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput>;
}
