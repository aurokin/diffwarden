import { claudeAdapter } from "../adapters/claude.js";
import { cursorAdapter } from "../adapters/cursor.js";
import { fakeAdapter } from "../adapters/fake.js";
import { piAdapter } from "../adapters/pi.js";
import type { ReviewAdapter, ReviewReviewerConfig } from "../adapters/types.js";
import type { DiffwardenConfig } from "./config.js";
import { parseChangedLineRanges } from "./diff.js";
import { invalidCli } from "./errors.js";
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
  config?: DiffwardenConfig;
  env?: NodeJS.ProcessEnv;
  adapters?: Partial<Record<ReviewReviewerConfig["sdk"], ReviewAdapter>>;
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
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  const start = Date.now();
  const prompt = buildReviewPrompt(options.resolved.target, options.resolved.diff);
  const changedLineRanges = parseChangedLineRanges(options.resolved.diff);
  const reviewerContexts = await Promise.all(
    reviewers.map((reviewer) =>
      preflightReviewer({
        cwd: options.cwd,
        reviewer,
        env: options.env ?? process.env,
        ...(options.adapters !== undefined ? { adapters: options.adapters } : {}),
      }),
    ),
  );
  const reviewerArtifacts: ReviewReviewerArtifact[] = [];

  for (const context of reviewerContexts) {
    reviewerArtifacts.push(
      await runSingleReviewer({
        cwd: options.cwd,
        resolved: options.resolved,
        reviewer: context.reviewer,
        adapter: context.adapter,
        ...(context.preflight !== undefined ? { preflight: context.preflight } : {}),
        prompt,
        changedLineRanges,
        env: options.env ?? process.env,
      }),
    );
  }

  const timingMs = Date.now() - start;
  const result =
    reviewerArtifacts.length === 1
      ? reviewerArtifacts[0]?.result
      : mergeReviewerResults(reviewerArtifacts);

  if (result === undefined) {
    throw invalidCli("No reviewers were selected");
  }

  const validation =
    reviewerArtifacts.length === 1
      ? reviewerArtifacts[0]?.validation
      : validateReviewResult({
          result,
          target: options.resolved.target,
          validation: aggregateValidationSeed(reviewerArtifacts),
          changedLineRanges,
        });

  if (validation === undefined) {
    throw invalidCli("No reviewers were selected");
  }

  return {
    schema_version: 1,
    ...(reviewerArtifacts.length === 1 ? { sdk: reviewerArtifacts[0]?.sdk } : {}),
    reviewers: reviewerArtifacts,
    cwd: options.cwd,
    target: options.resolved.target,
    result,
    ...(reviewerArtifacts.length === 1 && reviewerArtifacts[0]?.raw_text !== undefined
      ? { raw_text: reviewerArtifacts[0].raw_text }
      : {}),
    validation,
    timing_ms: timingMs,
  };
}

type SingleReviewerOptions = {
  cwd: string;
  resolved: ResolvedDiff;
  reviewer: ReviewReviewerConfig;
  adapter: ReviewAdapter;
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>;
  prompt: string;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  env: NodeJS.ProcessEnv;
};

async function runSingleReviewer(options: SingleReviewerOptions): Promise<ReviewReviewerArtifact> {
  const start = Date.now();
  const adapterInput = {
    cwd: options.cwd,
    reviewer: options.reviewer,
    target: options.resolved.target,
    diff: options.resolved.diff,
    changedFiles: options.resolved.target.changed_files,
    prompt: options.prompt,
    ...(options.reviewer.timeoutMs !== undefined ? { timeoutMs: options.reviewer.timeoutMs } : {}),
    readonly: true,
    env: options.env,
  };
  const output = await options.adapter.run(adapterInput);
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
};

async function preflightReviewer(options: {
  cwd: string;
  reviewer: ReviewReviewerConfig;
  env: NodeJS.ProcessEnv;
  adapters?: Partial<Record<ReviewReviewerConfig["sdk"], ReviewAdapter>>;
}): Promise<ReviewerContext> {
  const adapter = getAdapter(options.reviewer.sdk, options.adapters);
  const preflight = await adapter.preflight?.({
    cwd: options.cwd,
    reviewer: options.reviewer,
    readonly: true,
    env: options.env,
  });

  return {
    reviewer: options.reviewer,
    adapter,
    ...(preflight !== undefined ? { preflight } : {}),
  };
}

function mergeReviewerResults(reviewers: ReviewReviewerArtifact[]): ReviewArtifactResult {
  const findings = reviewers.flatMap((reviewer) => reviewer.result.findings);
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

function aggregateValidationSeed(reviewers: ReviewReviewerArtifact[]): ReviewValidation {
  return {
    parse_mode: aggregateParseMode(reviewers),
    valid_schema: reviewers.every((reviewer) => reviewer.validation.valid_schema),
    findings_overlap_diff: reviewers.every((reviewer) => reviewer.validation.findings_overlap_diff),
    valid_locations: reviewers.every((reviewer) => reviewer.validation.valid_locations),
    invalid_locations: [],
  };
}

function aggregateParseMode(reviewers: ReviewReviewerArtifact[]): ParseMode {
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

function getAdapter(
  sdk: ReviewReviewerConfig["sdk"],
  overrides: Partial<Record<ReviewReviewerConfig["sdk"], ReviewAdapter>> | undefined,
): ReviewAdapter {
  const override = overrides?.[sdk];
  if (override !== undefined) {
    return override;
  }

  if (sdk === "fake") {
    return fakeAdapter;
  }

  if (sdk === "cursor") {
    return cursorAdapter;
  }

  if (sdk === "claude") {
    return claudeAdapter;
  }

  if (sdk === "pi") {
    return piAdapter;
  }

  throw invalidCli(`Reviewer is not implemented yet: ${sdk}`);
}
