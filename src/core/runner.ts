import { claudeAdapter } from "../adapters/claude.js";
import { createCliAdapter } from "../adapters/cli.js";
import { cursorAdapter } from "../adapters/cursor.js";
import { fakeAdapter } from "../adapters/fake.js";
import { piAdapter } from "../adapters/pi.js";
import type { ReviewAdapter, ReviewReviewerConfig } from "../adapters/types.js";
import type { DiffwardenConfig } from "./config.js";
import { parseChangedLineRanges } from "./diff.js";
import {
  DiffwardenError,
  invalidCli,
  parseFailed,
  reviewerFailed,
  timeoutError,
  validationFailed,
} from "./errors.js";
import type { ReviewErrorCode } from "./errors.js";
import type { ResolvedDiff } from "./git.js";
import { parseReviewOutput } from "./parse.js";
import { buildReviewPrompt } from "./prompt.js";
import { resolveReviewerConfigs } from "./reviewer.js";
import type {
  ParseMode,
  ReviewArtifact,
  ReviewArtifactResult,
  ReviewReviewerArtifact,
  ReviewValidation,
} from "./schema.js";
import { validateReviewResult } from "./validate.js";

export type RunReviewOptions = {
  cwd: string;
  resolved: ResolvedDiff;
  reviewer?: string;
  reviewers?: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeoutSeconds?: number;
  strict?: boolean;
  config?: DiffwardenConfig;
  env?: NodeJS.ProcessEnv;
  adapters?: Partial<Record<string, ReviewAdapter>>;
};

export async function runReview(options: RunReviewOptions): Promise<ReviewArtifact> {
  const reviewers = resolveReviewerConfigs({
    ...(options.reviewers !== undefined
      ? { reviewers: options.reviewers }
      : options.reviewer !== undefined
        ? { reviewers: [options.reviewer] }
        : {}),
    ...(options.reviewerSet !== undefined ? { reviewerSet: options.reviewerSet } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  const start = Date.now();
  const prompt = buildReviewPrompt(options.resolved.target, options.resolved.diff);
  const changedLineRanges = parseChangedLineRanges(options.resolved.diff);
  const env = options.env ?? process.env;
  const preflightOutcomes = await Promise.all(
    reviewers.map((reviewer) => preflightReviewerOutcome({ reviewer, options, env })),
  );
  const reviewerArtifacts = await Promise.all(
    preflightOutcomes.map((outcome) =>
      runReviewerOutcome({
        outcome,
        cwd: options.cwd,
        resolved: options.resolved,
        prompt,
        changedLineRanges,
        env,
      }),
    ),
  );
  const successfulReviewerArtifacts = reviewerArtifacts.filter(isSuccessfulReviewerArtifact);
  const failedReviewerArtifacts = reviewerArtifacts.filter(isFailedReviewerArtifact);

  if (
    successfulReviewerArtifacts.length === 0 ||
    (options.strict && failedReviewerArtifacts.length)
  ) {
    throwReviewerFailures(failedReviewerArtifacts, {
      strict: options.strict === true,
      reviewerCount: reviewerArtifacts.length,
    });
  }

  const timingMs = Date.now() - start;
  const result = buildTopLevelResult(successfulReviewerArtifacts, reviewerArtifacts.length);

  if (result === undefined) {
    throw invalidCli("No reviewers were selected");
  }

  const validation =
    reviewerArtifacts.length === 1 && successfulReviewerArtifacts.length === 1
      ? successfulReviewerArtifacts[0]?.validation
      : validateReviewResult({
          result,
          target: options.resolved.target,
          validation: aggregateValidationSeed(successfulReviewerArtifacts),
          changedLineRanges,
        });

  if (validation === undefined) {
    throw invalidCli("No reviewers were selected");
  }

  if (options.strict === true) {
    enforceStrictValidation(validation);
  }

  return {
    schema_version: 1,
    ...(reviewerArtifacts.length === 1 && successfulReviewerArtifacts.length === 1
      ? { sdk: successfulReviewerArtifacts[0]?.sdk }
      : {}),
    reviewers: reviewerArtifacts,
    cwd: options.cwd,
    target: options.resolved.target,
    result,
    ...(reviewerArtifacts.length === 1 && successfulReviewerArtifacts[0]?.raw_text !== undefined
      ? { raw_text: successfulReviewerArtifacts[0].raw_text }
      : {}),
    validation,
    ...(failedReviewerArtifacts.length > 0
      ? { warnings: failedReviewerArtifacts.map(formatReviewerFailureWarning) }
      : {}),
    timing_ms: timingMs,
  };
}

type SuccessfulReviewerArtifact = ReviewReviewerArtifact & {
  status?: "success";
  result: ReviewArtifactResult;
  validation: ReviewValidation;
};

type FailedReviewerArtifact = ReviewReviewerArtifact & {
  status: "failed";
  error: NonNullable<ReviewReviewerArtifact["error"]>;
};

type PreflightOutcome =
  | {
      type: "context";
      context: ReviewerContext;
    }
  | {
      type: "failure";
      artifact: FailedReviewerArtifact;
    };

async function preflightReviewerOutcome(options: {
  reviewer: ReviewReviewerConfig;
  options: RunReviewOptions;
  env: NodeJS.ProcessEnv;
}): Promise<PreflightOutcome> {
  const start = Date.now();
  try {
    return {
      type: "context",
      context: await preflightReviewer({
        cwd: options.options.cwd,
        reviewer: options.reviewer,
        env: options.env,
        ...(options.options.adapters !== undefined ? { adapters: options.options.adapters } : {}),
      }),
    };
  } catch (error) {
    return {
      type: "failure",
      artifact: createFailedReviewerArtifact(options.reviewer, error, start),
    };
  }
}

async function runReviewerOutcome(options: {
  outcome: PreflightOutcome;
  cwd: string;
  resolved: ResolvedDiff;
  prompt: string;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  env: NodeJS.ProcessEnv;
}): Promise<ReviewReviewerArtifact> {
  if (options.outcome.type === "failure") {
    return options.outcome.artifact;
  }

  const start = Date.now();
  const { context } = options.outcome;
  try {
    return await runSingleReviewer({
      cwd: options.cwd,
      resolved: options.resolved,
      reviewer: context.reviewer,
      adapter: context.adapter,
      ...(context.preflight !== undefined ? { preflight: context.preflight } : {}),
      ...(context.remainingTimeoutMs !== undefined
        ? { remainingTimeoutMs: context.remainingTimeoutMs }
        : {}),
      prompt: options.prompt,
      changedLineRanges: options.changedLineRanges,
      env: options.env,
    });
  } catch (error) {
    return createFailedReviewerArtifact(context.reviewer, error, start, context.preflight);
  }
}

type SingleReviewerOptions = {
  cwd: string;
  resolved: ResolvedDiff;
  reviewer: ReviewReviewerConfig;
  adapter: ReviewAdapter;
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>;
  remainingTimeoutMs?: number;
  prompt: string;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  env: NodeJS.ProcessEnv;
};

async function runSingleReviewer(options: SingleReviewerOptions): Promise<ReviewReviewerArtifact> {
  const start = Date.now();
  const abortController = new AbortController();
  const adapterInput = {
    cwd: options.cwd,
    reviewer: options.reviewer,
    target: options.resolved.target,
    diff: options.resolved.diff,
    changedFiles: options.resolved.target.changed_files,
    prompt: options.prompt,
    ...(options.remainingTimeoutMs !== undefined ? { timeoutMs: options.remainingTimeoutMs } : {}),
    signal: abortController.signal,
    readonly: true,
    env: options.env,
  };
  const output = await withTimeout(
    () => options.adapter.run(adapterInput),
    options.remainingTimeoutMs,
    abortController,
    options.reviewer.id,
    "run",
  );
  const parsed =
    output.structured !== undefined
      ? parseReviewOutput({ structured: output.structured })
      : parseReviewOutput({ text: output.text ?? "" });
  const validation = validateReviewResult({
    result: parsed.result,
    target: options.resolved.target,
    validation: parsed.validation,
    changedLineRanges: options.changedLineRanges,
  });
  const timingMs = Date.now() - start;
  const reviewerArtifact: ReviewReviewerArtifact = {
    id: options.reviewer.id,
    sdk: options.reviewer.sdk,
    status: "success",
    ...(options.reviewer.profile ? { profile: options.reviewer.profile } : {}),
    ...(options.reviewer.provider ? { provider: options.reviewer.provider } : {}),
    ...(options.reviewer.model ? { model: options.reviewer.model } : {}),
    ...(options.reviewer.effort ? { effort: options.reviewer.effort } : {}),
    result: parsed.result,
    validation,
    timing_ms: timingMs,
  };

  if (parsed.rawText !== undefined) {
    reviewerArtifact.raw_text = parsed.rawText;
  }

  if (options.preflight !== undefined) {
    reviewerArtifact.preflight = options.preflight;
  }

  if (output.metadata !== undefined) {
    reviewerArtifact.adapter_metadata = output.metadata;
  }

  return reviewerArtifact;
}

type ReviewerContext = {
  reviewer: ReviewReviewerConfig;
  adapter: ReviewAdapter;
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>;
  remainingTimeoutMs?: number;
};

async function preflightReviewer(options: {
  cwd: string;
  reviewer: ReviewReviewerConfig;
  env: NodeJS.ProcessEnv;
  adapters?: Partial<Record<string, ReviewAdapter>>;
}): Promise<ReviewerContext> {
  const adapter = getAdapter(options.reviewer, options.adapters);
  const abortController = new AbortController();
  const start = Date.now();
  const preflightAdapter = adapter.preflight;
  const preflight =
    preflightAdapter === undefined
      ? undefined
      : await withTimeout(
          () =>
            preflightAdapter({
              cwd: options.cwd,
              reviewer: options.reviewer,
              signal: abortController.signal,
              readonly: true,
              env: options.env,
            }),
          options.reviewer.timeoutMs,
          abortController,
          options.reviewer.id,
          "preflight",
        );
  const remainingTimeoutMs =
    options.reviewer.timeoutMs === undefined
      ? undefined
      : Math.max(0, options.reviewer.timeoutMs - (Date.now() - start));

  return {
    reviewer: options.reviewer,
    adapter,
    ...(preflight !== undefined ? { preflight } : {}),
    ...(remainingTimeoutMs !== undefined ? { remainingTimeoutMs } : {}),
  };
}

function createFailedReviewerArtifact(
  reviewer: ReviewReviewerConfig,
  error: unknown,
  start: number,
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>,
): FailedReviewerArtifact {
  return {
    id: reviewer.id,
    sdk: reviewer.sdk,
    status: "failed",
    ...(reviewer.profile ? { profile: reviewer.profile } : {}),
    ...(reviewer.provider ? { provider: reviewer.provider } : {}),
    ...(reviewer.model ? { model: reviewer.model } : {}),
    ...(reviewer.effort ? { effort: reviewer.effort } : {}),
    ...(preflight !== undefined ? { preflight } : {}),
    error: reviewerError(error),
    timing_ms: Date.now() - start,
  };
}

function reviewerError(error: unknown): FailedReviewerArtifact["error"] {
  if (error instanceof DiffwardenError) {
    return {
      code: error.code,
      message: error.message,
      exit_code: error.exitCode,
    };
  }

  return {
    code: "reviewer_failed",
    message: error instanceof Error ? error.message : String(error),
    exit_code: 3,
  };
}

function isSuccessfulReviewerArtifact(
  reviewer: ReviewReviewerArtifact,
): reviewer is SuccessfulReviewerArtifact {
  return (
    reviewer.status !== "failed" &&
    reviewer.result !== undefined &&
    reviewer.validation !== undefined
  );
}

function isFailedReviewerArtifact(
  reviewer: ReviewReviewerArtifact,
): reviewer is FailedReviewerArtifact {
  return reviewer.status === "failed" && reviewer.error !== undefined;
}

function throwReviewerFailures(
  failures: FailedReviewerArtifact[],
  options: { strict: boolean; reviewerCount: number },
): never {
  const [firstFailure] = failures;
  if (options.reviewerCount === 1 && firstFailure !== undefined) {
    const { error } = firstFailure;
    throw new DiffwardenError(error.code as ReviewErrorCode, error.message, error.exit_code ?? 3);
  }

  throw reviewerFailed(
    `${options.strict ? "Reviewer failed in strict mode" : "All reviewers failed"}: ${formatFailedReviewers(
      failures,
    )}`,
  );
}

function formatReviewerFailureWarning(reviewer: FailedReviewerArtifact): string {
  return `Reviewer ${reviewer.id} failed: ${reviewer.error.message}`;
}

function formatFailedReviewers(failures: FailedReviewerArtifact[]): string {
  return failures.map((reviewer) => `${reviewer.id}: ${reviewer.error.message}`).join("; ");
}

function enforceStrictValidation(validation: ReviewValidation): void {
  if (!validation.valid_schema || validation.parse_mode === "fallback-text") {
    throw parseFailed("Reviewer output could not be parsed as a valid review result");
  }

  if (!validation.valid_locations || !validation.findings_overlap_diff) {
    throw validationFailed("Reviewer output contains findings outside the reviewed diff");
  }
}

function buildTopLevelResult(
  reviewers: SuccessfulReviewerArtifact[],
  reviewerCount: number,
): ReviewArtifactResult | undefined {
  const [onlyReviewer] = reviewers;
  if (reviewerCount === 1 && onlyReviewer !== undefined) {
    return {
      ...onlyReviewer.result,
      findings: onlyReviewer.result.findings.map((finding) => ({
        ...finding,
        reviewer_ids: [onlyReviewer.id],
      })),
    };
  }

  return mergeReviewerResults(reviewers);
}

function mergeReviewerResults(reviewers: SuccessfulReviewerArtifact[]): ReviewArtifactResult {
  const findings = mergeReviewerFindings(reviewers);
  const incorrect = reviewers.some(
    (reviewer) =>
      reviewer.result.overall_correctness === "patch is incorrect" ||
      reviewer.result.findings.length > 0,
  );
  const unknown = reviewers.some((reviewer) => reviewer.result.overall_correctness === "unknown");
  const confidenceScores = reviewers.map((reviewer) => reviewer.result.overall_confidence_score);
  const confidence =
    confidenceScores.length === 0
      ? 0
      : confidenceScores.reduce((sum, score) => sum + score, 0) / confidenceScores.length;
  const explanations = reviewers.map(
    (reviewer) => `${reviewer.id}: ${reviewer.result.overall_explanation.trim()}`,
  );

  return {
    findings,
    overall_correctness: incorrect
      ? "patch is incorrect"
      : unknown
        ? "unknown"
        : "patch is correct",
    overall_explanation: explanations.join("\n\n"),
    overall_confidence_score: confidence,
  };
}

function mergeReviewerFindings(
  reviewers: SuccessfulReviewerArtifact[],
): ReviewArtifactResult["findings"] {
  const findingsByKey = new Map<string, ReviewArtifactResult["findings"][number]>();

  for (const reviewer of reviewers) {
    for (const finding of reviewer.result.findings) {
      const key = findingDeduplicationKey(finding);
      const existing = findingsByKey.get(key);
      if (existing === undefined) {
        findingsByKey.set(key, {
          ...finding,
          reviewer_ids: [reviewer.id],
        });
        continue;
      }

      existing.reviewer_ids = [...new Set([...(existing.reviewer_ids ?? []), reviewer.id])];
    }
  }

  return [...findingsByKey.values()];
}

function findingDeduplicationKey(finding: ReviewArtifactResult["findings"][number]): string {
  const range = finding.code_location.line_range;
  return [
    normalizeTitle(finding.title),
    normalizeBody(finding.body),
    finding.priority ?? "none",
    finding.code_location.absolute_file_path,
    range.start,
    range.end,
  ].join("\0");
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, " ");
}

function aggregateValidationSeed(reviewers: SuccessfulReviewerArtifact[]): ReviewValidation {
  return {
    parse_mode: aggregateParseMode(reviewers),
    valid_schema: reviewers.every((reviewer) => reviewer.validation.valid_schema),
    findings_overlap_diff: reviewers.every((reviewer) => reviewer.validation.findings_overlap_diff),
    valid_locations: reviewers.every((reviewer) => reviewer.validation.valid_locations),
    invalid_locations: [],
  };
}

function aggregateParseMode(reviewers: SuccessfulReviewerArtifact[]): ParseMode {
  const [firstReviewer] = reviewers;
  if (
    firstReviewer !== undefined &&
    reviewers.every(
      (reviewer) => reviewer.validation.parse_mode === firstReviewer.validation.parse_mode,
    )
  ) {
    return firstReviewer.validation.parse_mode;
  }

  return "tool-output";
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number | undefined,
  abortController: AbortController,
  reviewerId: string,
  phase: "preflight" | "run",
): Promise<T> {
  if (timeoutMs === undefined) {
    return operation();
  }

  if (timeoutMs <= 0) {
    const error = timeoutError(`Reviewer timed out during ${phase}: ${reviewerId}`);
    queueMicrotask(() => abortController.abort(error));
    throw error;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError(`Reviewer timed out during ${phase}: ${reviewerId}`);
          reject(error);
          queueMicrotask(() => abortController.abort(error));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function getAdapter(
  reviewer: ReviewReviewerConfig,
  overrides: Partial<Record<string, ReviewAdapter>> | undefined,
): ReviewAdapter {
  const adapterKey = reviewerAdapterKey(reviewer);
  const override = overrides?.[adapterKey] ?? overrides?.[reviewer.sdk];
  if (override !== undefined) {
    return override;
  }

  if (reviewer.transport === "cli") {
    if (reviewer.sdk === "fake") {
      throw invalidCli("Fake reviewer does not support CLI transport");
    }
    return createCliAdapter(reviewer.sdk);
  }

  if (reviewer.sdk === "fake") {
    return fakeAdapter;
  }

  if (reviewer.sdk === "cursor") {
    return cursorAdapter;
  }

  if (reviewer.sdk === "claude") {
    return claudeAdapter;
  }

  if (reviewer.sdk === "pi") {
    return piAdapter;
  }

  return createCliAdapter(reviewer.sdk);
}

function reviewerAdapterKey(reviewer: ReviewReviewerConfig): string {
  return `${reviewer.sdk}:${reviewer.transport ?? "sdk"}`;
}
