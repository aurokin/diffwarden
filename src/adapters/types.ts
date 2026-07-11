import type { ReviewTargetResolved } from "../core/schema.js";

export type ReviewReviewerValueSource =
  | "adapter-default"
  | "config"
  | "diffwarden-default"
  | "env"
  | "requested";

export type ReviewAdapterInput = {
  cwd: string;
  reviewer: ReviewReviewerConfig;
  target: ReviewTargetResolved;
  diff: string;
  changedFiles: string[];
  prompt: string;
  /** Stable review contract delivered as the engine system prompt when the transport supports it. */
  systemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  readonly: boolean;
  env?: NodeJS.ProcessEnv;
  runContext?: unknown;
};

export type ReviewReviewerConfig = {
  id: string;
  sdk:
    | "fake"
    | "cursor"
    | "claude"
    | "pi"
    | "droid"
    | "copilot"
    | "codex"
    | "gemini"
    | "opencode"
    | "grok"
    | "antigravity";
  transport?: "sdk" | "cli" | "app-server";
  profile?: string;
  provider?: string;
  model?: string;
  modelSource?: ReviewReviewerValueSource;
  effort?: string;
  effortSource?: ReviewReviewerValueSource;
  /** Model the engine may switch to when the primary model is overloaded or unavailable. */
  fallbackModel?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  modelCatalog?: string[];
  effortCatalog?: string[];
  timeoutMs?: number;
  readonly: boolean;
  cliOptions?: Record<string, unknown>;
  appServerOptions?: Record<string, unknown>;
  sdkOptions?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
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
  repoRoot?: string;
  reviewer: ReviewReviewerConfig;
  signal?: AbortSignal;
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

export type ReviewAdapterPrepareResult = {
  preflight?: ReviewAdapterPreflightResult;
  runContext?: unknown;
};

/** One selectable model from an engine's live catalog. */
export type ModelCatalogEntry = {
  value: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
  /** True for the engine/diffwarden default model, when the catalog can tell. */
  default?: boolean;
};

/**
 * Input for `listModels`. The reviewer (usually a setup draft) rides along so
 * the fetch resolves auth per its settings (e.g. claude `sdkOptions.authMode`)
 * instead of probing blind.
 */
export type ListModelsInput = {
  cwd?: string;
  reviewer: ReviewReviewerConfig;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export interface ReviewAdapter {
  name: string;
  preflight?(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult>;
  prepare?(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPrepareResult>;
  run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput>;
  /** Live model catalog for interactive setup; only on engines whose capability declares supportsModelCatalog. */
  listModels?(input: ListModelsInput): Promise<ModelCatalogEntry[]>;
}
