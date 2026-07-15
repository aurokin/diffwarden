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
  /**
   * Present only when the run opted into --debug-reviewer-output. Transports
   * that can observe raw incremental output call onChunk per chunk; transports
   * that cannot simply ignore it, so absence of debug output is well-defined.
   */
  debugOutput?: {
    onChunk: (stream: "stdout" | "stderr", text: string) => void;
    /**
     * True when a live consumer is attached (--ndjson). Only then may a
     * transport switch the engine to its native stream output mode; without
     * it invocations must stay identical to a run with no debug capture.
     */
    streaming?: boolean;
  };
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
    /** "repaired" is set by the core repair stage, never by adapters themselves. */
    captureMode?: "native-structured" | "tool-call" | "text" | "repaired";
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

/**
 * Input for a one-shot structured request outside the main review run (e.g. the core repair
 * stage). The schema is the response contract; engines with native structured output enforce it
 * natively, engines without describe it in the prompt and return text for core to unwrap.
 */
export type RunStructuredInput = {
  cwd: string;
  reviewer: ReviewReviewerConfig;
  prompt: string;
  schema: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  runContext?: unknown;
};

export type RunStructuredOutput = {
  structured?: unknown;
  text?: string;
  metadata?: Record<string, unknown>;
};

export interface ReviewAdapter {
  name: string;
  preflight?(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult>;
  prepare?(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPrepareResult>;
  run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput>;
  /** Live model catalog for interactive setup; only on engines whose capability declares supportsModelCatalog. */
  listModels?(input: ListModelsInput): Promise<ModelCatalogEntry[]>;
  /**
   * One-shot schema-constrained request with the most restricted invocation the engine supports
   * (no tools). Used by the core structured-output repair stage; never triggers review logic.
   */
  runStructured?(input: RunStructuredInput): Promise<RunStructuredOutput>;
}
