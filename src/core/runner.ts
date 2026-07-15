import { reviewerSystemPromptSupport } from "../adapters/capabilities.js";
import { claudeAdapter } from "../adapters/claude.js";
import { createCliAdapter } from "../adapters/cli.js";
import { createCodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { copilotAdapter } from "../adapters/copilot.js";
import { cursorAdapter } from "../adapters/cursor.js";
import { droidAdapter } from "../adapters/droid.js";
import { fakeAdapter } from "../adapters/fake.js";
import { piAdapter } from "../adapters/pi.js";
import type {
  ReviewAdapter,
  ReviewAdapterPrepareResult,
  ReviewReviewerConfig,
} from "../adapters/types.js";
import type { DiffwardenConfig } from "./config.js";
import { type DebugOutputRecorder, createDebugOutputRecorder } from "./debug-output.js";
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
import { tryGetRepoRoot } from "./git.js";
import { parseReviewOutput } from "./parse.js";
import { buildReviewPrompt, buildReviewPromptParts } from "./prompt.js";
import {
  type RepairEvaluation,
  buildRepairPrompt,
  evaluateRepairResponse,
  repairResponseJsonSchema,
} from "./repair.js";
import { type ReviewerOverrideSource, resolveReviewerConfigs } from "./reviewer.js";
import type {
  ParseMode,
  ReviewArtifact,
  ReviewArtifactResult,
  ReviewBatchArtifact,
  ReviewBatchArtifactResult,
  ReviewBatchLaneArtifact,
  ReviewEvent,
  ReviewLane,
  ReviewPlan,
  ReviewReviewerArtifact,
  ReviewTargetResolved,
  ReviewValidation,
  ReviewerError,
} from "./schema.js";
import { validateReviewResult } from "./validate.js";

export type RunReviewOptions = {
  cwd: string;
  resolved: ResolvedDiff;
  reviewer?: string;
  reviewers?: string[];
  reviewerSet?: string;
  model?: string;
  modelSource?: ReviewerOverrideSource;
  effort?: string;
  effortSource?: ReviewerOverrideSource;
  fallbackModel?: string;
  timeoutSeconds?: number;
  strict?: boolean;
  config?: DiffwardenConfig;
  env?: NodeJS.ProcessEnv;
  adapters?: Partial<Record<string, ReviewAdapter>>;
  promptFocus?: string;
  /** Opt-in bounded raw transport capture (--debug-reviewer-output). */
  debugReviewerOutput?: boolean;
};

export type RunReviewBatchOptions = RunReviewOptions & {
  plan: ReviewPlan;
};

export type ReviewerPreflightArtifact = {
  id: string;
  engine: ReviewReviewerConfig["sdk"];
  status: "passed" | "failed";
  profile?: string;
  provider?: string;
  transport?: "native" | "cli" | "app-server";
  model?: string;
  effort?: string;
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>;
  error?: NonNullable<ReviewReviewerArtifact["error"]>;
  timing_ms: number;
};

export type ReviewerPreflightReport = {
  schema_version: 2;
  cwd: string;
  reviewers: ReviewerPreflightArtifact[];
  timing_ms: number;
};

/**
 * Run a review, emitting a typed event stream as work progresses.
 *
 * The stream starts with `run_started`, then per-reviewer preflight/run
 * lifecycle events (emitted as each reviewer settles, so out of completion
 * order under concurrency), and always terminates with exactly one of
 * `final_result` (authoritative aggregated artifact) or `error` (an expected
 * terminal failure such as all reviewers failing or a strict-mode violation).
 *
 * The generator's return value is the final `ReviewArtifact`, or `undefined`
 * when it terminated with an `error` event. Reviewer-selection errors thrown
 * by `resolveReviewerConfigs()` happen before `run_started` and propagate as
 * thrown `DiffwardenError`s; the terminal-frame guarantee applies only once
 * `run_started` has been emitted.
 */
export async function* runReviewEvents(
  options: RunReviewOptions,
): AsyncGenerator<ReviewEvent, ReviewArtifact | undefined, void> {
  const reviewers = resolveRunReviewers(options);
  const start = Date.now();
  const changedLineRanges = parseChangedLineRanges(options.resolved.diff);
  const env = options.env ?? process.env;

  yield event({
    type: "run_started",
    cwd: options.cwd,
    target: options.resolved.target,
    reviewers: reviewers.map((reviewer) => ({ id: reviewer.id, engine: reviewer.sdk })),
  });

  const reviewerArtifacts = new Array<ReviewReviewerArtifact>(reviewers.length);

  try {
    const preflightOutcomes = yield* preflightPhase({ reviewers, options, env });
    yield* runPhase({
      reviewers,
      preflightOutcomes,
      reviewerArtifacts,
      options,
      changedLineRanges,
      env,
    });

    const artifact = finalizeArtifact({ reviewerArtifacts, options, changedLineRanges, start });
    yield event({ type: "final_result", artifact });
    return artifact;
  } catch (error) {
    if (error instanceof DiffwardenError) {
      yield event({ type: "error", error: diffwardenEventError(error) });
      return undefined;
    }
    throw error;
  }
}

/**
 * Stable, non-streaming review API. Drains `runReviewEvents()` and returns the
 * final artifact, throwing the corresponding `DiffwardenError` when the stream
 * terminates with an `error` event so existing callers keep their exit codes.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewArtifact> {
  const stream = runReviewEvents(options);
  let terminalError: ReviewerError | undefined;
  let next = await stream.next();
  while (next.done !== true) {
    if (next.value.type === "error") {
      terminalError = next.value.error;
    }
    next = await stream.next();
  }

  if (terminalError !== undefined) {
    throw diffwardenErrorFromReviewerError(terminalError);
  }

  if (next.value === undefined) {
    throw reviewerFailed("Review produced no result");
  }

  return next.value;
}

export async function* runReviewBatchEvents(
  options: RunReviewBatchOptions,
): AsyncGenerator<ReviewEvent, ReviewBatchArtifact | undefined, void> {
  const reviewers = resolveRunReviewers(options);
  const start = Date.now();
  const queue = new AsyncEventQueue<ReviewEvent>();
  const laneArtifacts = new Array<ReviewBatchLaneArtifact>(options.plan.lanes.length);

  yield event({
    type: "batch_started",
    cwd: options.cwd,
    target: options.resolved.target,
    reviewers: reviewers.map((reviewer) => ({ id: reviewer.id, engine: reviewer.sdk })),
    plan: options.plan,
  });

  const laneRuns = options.plan.lanes.map((lane, index) =>
    runBatchLane({
      lane,
      options,
      queue,
    })
      .then((artifact) => {
        laneArtifacts[index] = artifact;
      })
      .catch((error) => {
        laneArtifacts[index] = failedLaneArtifact(lane, reviewerError(error), 0);
      }),
  );

  void Promise.all(laneRuns).finally(() => queue.close());

  for await (const reviewEvent of queue) {
    yield reviewEvent;
  }

  await Promise.all(laneRuns);

  try {
    const artifact = finalizeBatchArtifact({
      laneArtifacts,
      options,
      changedLineRanges: parseChangedLineRanges(options.resolved.diff),
      start,
    });
    yield event({ type: "final_result", artifact });
    return artifact;
  } catch (error) {
    if (error instanceof DiffwardenError) {
      yield event({ type: "error", error: diffwardenEventError(error) });
      return undefined;
    }
    throw error;
  }
}

function resolveRunReviewers(options: RunReviewOptions): ReviewReviewerConfig[] {
  return resolveReviewerConfigs({
    ...(options.reviewers !== undefined
      ? { reviewers: options.reviewers }
      : options.reviewer !== undefined
        ? { reviewers: [options.reviewer] }
        : {}),
    ...(options.reviewerSet !== undefined ? { reviewerSet: options.reviewerSet } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.effortSource !== undefined ? { effortSource: options.effortSource } : {}),
    ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
}

async function runBatchLane(options: {
  lane: ReviewLane;
  options: RunReviewBatchOptions;
  queue: AsyncEventQueue<ReviewEvent>;
}): Promise<ReviewBatchLaneArtifact> {
  const start = Date.now();
  let artifact: ReviewArtifact | undefined;
  let terminalError: ReviewerError | undefined;

  try {
    const stream = runReviewEvents({
      ...options.options,
      ...(options.lane.focus !== undefined ? { promptFocus: options.lane.focus } : {}),
    });
    let next = await stream.next();
    while (next.done !== true) {
      const reviewEvent = next.value;
      if (reviewEvent.type === "final_result") {
        if ("kind" in reviewEvent.artifact && reviewEvent.artifact.kind === "batch") {
          throw reviewerFailed("Batch lanes must produce single review artifacts");
        }
        artifact = reviewEvent.artifact;
      } else if (reviewEvent.type === "error") {
        terminalError = reviewEvent.error;
      } else {
        options.queue.push(addLaneId(reviewEvent, options.lane.id));
      }
      next = await stream.next();
    }

    const timingMs = Date.now() - start;
    if (terminalError !== undefined || artifact === undefined) {
      const error = terminalError ?? reviewerError(reviewerFailed("Lane produced no result"));
      options.queue.push(
        event({
          type: "lane_failed",
          lane_id: options.lane.id,
          error,
          timing_ms: timingMs,
        }),
      );
      return failedLaneArtifact(options.lane, error, timingMs);
    }

    options.queue.push(
      event({
        type: "lane_finished",
        lane_id: options.lane.id,
        artifact,
        timing_ms: timingMs,
      }),
    );
    return {
      ...options.lane,
      status: "success",
      artifact,
      timing_ms: timingMs,
    };
  } catch (error) {
    const timingMs = Date.now() - start;
    const reviewerArtifactError = reviewerError(error);
    options.queue.push(
      event({
        type: "lane_failed",
        lane_id: options.lane.id,
        error: reviewerArtifactError,
        timing_ms: timingMs,
      }),
    );
    return failedLaneArtifact(options.lane, reviewerArtifactError, timingMs);
  }
}

function addLaneId(reviewEvent: ReviewEvent, laneId: string): ReviewEvent {
  return {
    ...reviewEvent,
    lane_id: laneId,
  } as ReviewEvent;
}

function failedLaneArtifact(
  lane: ReviewLane,
  error: ReviewerError,
  timingMs: number,
): ReviewBatchLaneArtifact {
  return {
    ...lane,
    status: "failed",
    error,
    timing_ms: timingMs,
  };
}

function finalizeBatchArtifact(params: {
  laneArtifacts: ReviewBatchLaneArtifact[];
  options: RunReviewBatchOptions;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  start: number;
}): ReviewBatchArtifact {
  const { laneArtifacts, options, changedLineRanges, start } = params;
  const successfulLanes = laneArtifacts.filter(isSuccessfulLaneArtifact);
  const failedLanes = laneArtifacts.filter(isFailedLaneArtifact);

  if (successfulLanes.length === 0) {
    throw reviewerFailed(`All lanes failed: ${formatFailedLanes(failedLanes)}`);
  }

  if (options.strict === true && failedLanes.length > 0) {
    throw reviewerFailed(`Lane failed in strict mode: ${formatFailedLanes(failedLanes)}`);
  }

  const result = mergeLaneResults(successfulLanes);
  const validation = validateReviewResult({
    result,
    target: options.resolved.target,
    validation: aggregateLaneValidationSeed(successfulLanes),
    changedLineRanges,
  });

  if (options.strict === true) {
    enforceStrictValidation(validation);
  }

  const warnings = batchWarnings(successfulLanes, failedLanes);

  return {
    schema_version: 2,
    kind: "batch",
    cwd: options.cwd,
    target: options.resolved.target,
    plan: options.plan,
    result,
    validation,
    ...(warnings.length > 0 ? { warnings } : {}),
    timing_ms: Date.now() - start,
    lanes: laneArtifacts,
  };
}

/**
 * Preflight every reviewer concurrently, emitting lifecycle events as each
 * settles. All preflights complete before the run phase begins. Preflight
 * failures emit `reviewer_failed` here and never enter the run phase.
 */
async function* preflightPhase(params: {
  reviewers: ReviewReviewerConfig[];
  options: RunReviewOptions;
  env: NodeJS.ProcessEnv;
}): AsyncGenerator<ReviewEvent, PreflightOutcome[], void> {
  const { reviewers, options, env } = params;
  for (const reviewer of reviewers) {
    yield event({ type: "preflight_started", reviewer_id: reviewer.id });
  }

  const outcomes = new Array<PreflightOutcome>(reviewers.length);
  const settled = settleInCompletionOrder(
    reviewers.map((reviewer) => preflightReviewerOutcome({ reviewer, options, env })),
  );
  for await (const { index, value: outcome } of settled) {
    outcomes[index] = outcome;
    const reviewerId = reviewers[index]?.id ?? "unknown";
    yield event({
      type: "preflight_finished",
      reviewer_id: reviewerId,
      ok: outcome.type !== "failure",
      timing_ms: preflightOutcomeTiming(outcome),
    });
    if (outcome.type === "failure") {
      yield event({
        type: "reviewer_failed",
        reviewer_id: reviewerId,
        error: outcome.artifact.error,
        timing_ms: outcome.artifact.timing_ms ?? 0,
      });
    }
  }

  return outcomes;
}

/**
 * Run every reviewer that passed preflight, concurrently, emitting
 * `reviewer_started` up front and `reviewer_result`/`reviewer_failed` as each
 * settles. Results are written back into `reviewerArtifacts` at their original
 * index so aggregation order is preserved.
 */
async function* runPhase(params: {
  reviewers: ReviewReviewerConfig[];
  preflightOutcomes: PreflightOutcome[];
  reviewerArtifacts: ReviewReviewerArtifact[];
  options: RunReviewOptions;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  env: NodeJS.ProcessEnv;
}): AsyncGenerator<ReviewEvent, void, void> {
  const { reviewers, preflightOutcomes, reviewerArtifacts, options, changedLineRanges, env } =
    params;

  const runnable: Array<{ index: number; outcome: PreflightOutcome }> = [];
  preflightOutcomes.forEach((outcome, index) => {
    if (outcome.type === "failure") {
      reviewerArtifacts[index] = outcome.artifact;
    } else {
      runnable.push({ index, outcome });
    }
  });

  for (const { index } of runnable) {
    yield event({ type: "reviewer_started", reviewer_id: reviewers[index]?.id ?? "unknown" });
  }

  // A queue rather than settleInCompletionOrder: opt-in debug chunks arrive
  // *while* reviewers run, so lifecycle events and debug events merge into one
  // stream. Settlement events keep completion order exactly as before.
  const queue = new AsyncEventQueue<ReviewEvent>();
  const runs = runnable.map(({ index, outcome }) => {
    const reviewerId = reviewers[index]?.id ?? "unknown";
    const debug =
      options.debugReviewerOutput === true ? reviewerDebugCapture(reviewerId, queue) : undefined;
    return runReviewerOutcome({
      outcome,
      cwd: options.cwd,
      resolved: options.resolved,
      ...(options.promptFocus !== undefined ? { promptFocus: options.promptFocus } : {}),
      changedLineRanges,
      env,
      ...(debug !== undefined ? { debug } : {}),
    }).then((artifact) => {
      reviewerArtifacts[index] = artifact;
      if (isFailedReviewerArtifact(artifact)) {
        queue.push(
          event({
            type: "reviewer_failed",
            reviewer_id: reviewerId,
            error: artifact.error,
            timing_ms: artifact.timing_ms ?? 0,
          }),
        );
      } else {
        queue.push(
          event({
            type: "reviewer_result",
            reviewer_id: reviewerId,
            provisional: true,
            artifact,
          }),
        );
      }
    });
  });
  void Promise.all(runs).finally(() => queue.close());

  for await (const reviewEvent of queue) {
    yield reviewEvent;
  }

  await Promise.all(runs);
}

type ReviewerDebugCapture = {
  recorder: DebugOutputRecorder;
  onChunk: (stream: "stdout" | "stderr", text: string) => void;
};

/**
 * One recorder per reviewer: bounds the persisted transcript and fans bounded
 * reviewer_debug_output events into the run-phase queue as chunks arrive.
 */
function reviewerDebugCapture(
  reviewerId: string,
  queue: AsyncEventQueue<ReviewEvent>,
): ReviewerDebugCapture {
  const recorder = createDebugOutputRecorder();
  return {
    recorder,
    onChunk(stream, text) {
      for (const chunk of recorder.record(stream, text)) {
        queue.push(
          event({
            type: "reviewer_debug_output",
            reviewer_id: reviewerId,
            stream: chunk.stream,
            text: chunk.text,
            truncated: chunk.truncated,
          }),
        );
      }
    },
  };
}

/**
 * Aggregate, deduplicate, and validate reviewer artifacts into the final
 * artifact. Throws `DiffwardenError` for terminal failures (all reviewers
 * failed, strict-mode violations); callers turn those into `error` events.
 */
function finalizeArtifact(params: {
  reviewerArtifacts: ReviewReviewerArtifact[];
  options: RunReviewOptions;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  start: number;
}): ReviewArtifact {
  const { reviewerArtifacts, options, changedLineRanges, start } = params;
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
    schema_version: 2,
    ...(reviewerArtifacts.length === 1 && successfulReviewerArtifacts.length === 1
      ? { engine: successfulReviewerArtifacts[0]?.engine }
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

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function event(payload: DistributiveOmit<ReviewEvent, "schema_version">): ReviewEvent {
  return { schema_version: 2, ...payload } as ReviewEvent;
}

function diffwardenEventError(error: DiffwardenError): ReviewerError {
  return serializedDiffwardenError(error);
}

function preflightOutcomeTiming(outcome: PreflightOutcome): number {
  return outcome.type === "failure"
    ? (outcome.artifact.timing_ms ?? 0)
    : Math.max(0, Date.now() - outcome.startedAt);
}

/**
 * Race an array of promises, yielding each result paired with its original
 * index as it settles. The input promises must not reject (reviewer outcome
 * helpers already convert failures into artifacts).
 */
async function* settleInCompletionOrder<T>(
  promises: Array<Promise<T>>,
): AsyncGenerator<{ index: number; value: T }, void, void> {
  const pending = new Map<number, Promise<{ index: number; value: T }>>();
  promises.forEach((promise, index) => {
    pending.set(
      index,
      promise.then((value) => ({ index, value })),
    );
  });
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.index);
    yield settled;
  }
}

export async function runReviewerPreflightReport(
  options: Omit<RunReviewOptions, "resolved" | "strict">,
): Promise<ReviewerPreflightReport> {
  const reviewers = resolveReviewerConfigs({
    ...(options.reviewers !== undefined
      ? { reviewers: options.reviewers }
      : options.reviewer !== undefined
        ? { reviewers: [options.reviewer] }
        : {}),
    ...(options.reviewerSet !== undefined ? { reviewerSet: options.reviewerSet } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.effortSource !== undefined ? { effortSource: options.effortSource } : {}),
    ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  const env = options.env ?? process.env;
  const repoRoot = await tryGetRepoRoot(options.cwd);
  const started = Date.now();
  const artifacts = await Promise.all(
    reviewers.map((reviewer) =>
      runSingleReviewerPreflight({
        cwd: options.cwd,
        ...(repoRoot !== undefined ? { repoRoot } : {}),
        reviewer,
        env,
        ...(options.adapters !== undefined ? { adapters: options.adapters } : {}),
      }),
    ),
  );

  return {
    schema_version: 2,
    cwd: options.cwd,
    reviewers: artifacts,
    timing_ms: Date.now() - started,
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

type SuccessfulLaneArtifact = ReviewBatchLaneArtifact & {
  status: "success";
  artifact: ReviewArtifact;
};

type FailedLaneArtifact = ReviewBatchLaneArtifact & {
  status: "failed";
  error: ReviewerError;
};

type PreflightOutcome =
  | {
      type: "context";
      context: ReviewerContext;
      startedAt: number;
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
        repoRoot: options.options.resolved.target.repo_root,
        reviewer: options.reviewer,
        env: options.env,
        ...(options.options.adapters !== undefined ? { adapters: options.options.adapters } : {}),
      }),
      startedAt: start,
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
  promptFocus?: string;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  env: NodeJS.ProcessEnv;
  debug?: ReviewerDebugCapture;
}): Promise<ReviewReviewerArtifact> {
  if (options.outcome.type === "failure") {
    return options.outcome.artifact;
  }

  const { context } = options.outcome;
  try {
    const artifact = await runSingleReviewer({
      cwd: options.cwd,
      resolved: options.resolved,
      reviewer: context.reviewer,
      adapter: context.adapter,
      ...(context.preflight !== undefined ? { preflight: context.preflight } : {}),
      ...(context.runContext !== undefined ? { runContext: context.runContext } : {}),
      ...(context.remainingTimeoutMs !== undefined
        ? { remainingTimeoutMs: context.remainingTimeoutMs }
        : {}),
      promptSelection: reviewerPromptSelection(
        context.reviewer,
        options.resolved,
        options.promptFocus,
      ),
      changedLineRanges: options.changedLineRanges,
      env: options.env,
      ...(options.debug !== undefined ? { onDebugChunk: options.debug.onChunk } : {}),
    });
    return withDebugOutput(
      {
        ...artifact,
        timing_ms: Date.now() - options.outcome.startedAt,
      },
      options.debug,
    );
  } catch (error) {
    // Failed runs keep their captured transcript: debugging failures is the
    // primary use case for --debug-reviewer-output.
    return withDebugOutput(
      createFailedReviewerArtifact(
        context.reviewer,
        error,
        options.outcome.startedAt,
        context.preflight,
      ),
      options.debug,
    );
  }
}

function withDebugOutput<T extends ReviewReviewerArtifact>(
  artifact: T,
  debug: ReviewerDebugCapture | undefined,
): T {
  const debugOutput = debug?.recorder.finalize();
  return debugOutput === undefined ? artifact : { ...artifact, debug_output: debugOutput };
}

type ReviewerPromptSelection = {
  prompt: string;
  systemPrompt?: string;
};

/**
 * Pick the prompt shape for one reviewer: transports that support a system
 * prompt get the stable diffwarden contract as `systemPrompt` and only the
 * per-run engagement as `prompt`; everything else gets today's single
 * concatenated prompt unchanged.
 */
function reviewerPromptSelection(
  reviewer: ReviewReviewerConfig,
  resolved: ResolvedDiff,
  promptFocus: string | undefined,
): ReviewerPromptSelection {
  const focusOptions = promptFocus !== undefined ? { focus: promptFocus } : {};
  const support = reviewerSystemPromptSupport(reviewer.sdk, reviewer.transport);
  if (support === undefined) {
    return { prompt: buildReviewPrompt(resolved.target, resolved.diff, focusOptions) };
  }

  const parts = buildReviewPromptParts(resolved.target, resolved.diff, {
    ...focusOptions,
    ...(support.tools !== undefined ? { tools: support.tools } : {}),
  });
  return { prompt: parts.user, systemPrompt: parts.system };
}

type SingleReviewerOptions = {
  cwd: string;
  resolved: ResolvedDiff;
  reviewer: ReviewReviewerConfig;
  adapter: ReviewAdapter;
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>;
  runContext?: unknown;
  remainingTimeoutMs?: number;
  promptSelection: ReviewerPromptSelection;
  changedLineRanges: ReturnType<typeof parseChangedLineRanges>;
  env: NodeJS.ProcessEnv;
  onDebugChunk?: (stream: "stdout" | "stderr", text: string) => void;
};

/**
 * Attempt-aware review pipeline. Attempt 1 runs the review; on schema-parse failure the pipeline
 * first tries a short REPAIR request against the same engine (only when raw material survived and
 * the adapter exposes runStructured), then falls back to ONE full re-run explicitly labeled as a
 * retry. Repair triggers on schema-parse failure ONLY — semantic validation failures (findings
 * outside changed ranges) are never "repaired", since fixing line numbers is fabrication.
 */
async function runSingleReviewer(options: SingleReviewerOptions): Promise<ReviewReviewerArtifact> {
  const start = Date.now();
  const first = await runReviewerAttempt(options, options.remainingTimeoutMs);
  if (first.parsed.validation.valid_schema) {
    return buildReviewerArtifact(options, first, Date.now() - start);
  }

  const failureReason = attemptFailureReason(first.output);
  const material = repairMaterial(first.output);
  if (material !== undefined && options.adapter.runStructured !== undefined) {
    const repaired = await tryStructuredRepair({
      options,
      material,
      remainingTimeoutMs: remainingAfter(options, start),
    });
    if (repaired !== undefined) {
      return buildRepairedReviewerArtifact({
        options,
        attempt: first,
        material,
        repaired: repaired.evaluation,
        ...(repaired.metadata !== undefined ? { repairMetadata: repaired.metadata } : {}),
        failureReason,
        timingMs: Date.now() - start,
      });
    }
  }

  // Labeled full re-run: attempt 1 failed schema parsing and could not be repaired. The label
  // (attempts/firstAttemptFailureReason) is the signal that the engine/model is not reliably
  // producing valid output — a silent second run would hide exactly that.
  const second = await runReviewerAttempt(options, remainingAfter(options, start));
  return buildReviewerArtifact(options, second, Date.now() - start, {
    ...summedInvocationMetadata(first.output.metadata, second.output.metadata),
    attempts: 2,
    firstAttemptFailureReason: failureReason,
  });
}

type ReviewerAttempt = {
  output: Awaited<ReturnType<ReviewAdapter["run"]>>;
  parsed: ReturnType<typeof parseReviewOutput>;
};

async function runReviewerAttempt(
  options: SingleReviewerOptions,
  remainingTimeoutMs: number | undefined,
): Promise<ReviewerAttempt> {
  const abortController = new AbortController();
  const adapterInput = {
    cwd: options.cwd,
    reviewer: options.reviewer,
    target: options.resolved.target,
    diff: options.resolved.diff,
    changedFiles: options.resolved.target.changed_files,
    prompt: options.promptSelection.prompt,
    ...(options.promptSelection.systemPrompt !== undefined
      ? { systemPrompt: options.promptSelection.systemPrompt }
      : {}),
    ...(remainingTimeoutMs !== undefined ? { timeoutMs: remainingTimeoutMs } : {}),
    signal: abortController.signal,
    readonly: true,
    env: options.env,
    ...(options.runContext !== undefined ? { runContext: options.runContext } : {}),
    // Both attempts share the reviewer's recorder, so a retried run's transcript
    // includes the failing first attempt under the same per-stream budget.
    ...(options.onDebugChunk !== undefined
      ? { debugOutput: { onChunk: options.onDebugChunk } }
      : {}),
  };
  const output = await withTimeout(
    () => options.adapter.run(adapterInput),
    remainingTimeoutMs,
    abortController,
    options.reviewer.id,
    "run",
  );
  const parsed =
    output.structured !== undefined
      ? parseReviewOutput({ structured: output.structured })
      : parseReviewOutput({ text: output.text ?? "" });
  return { output, parsed };
}

function attemptFailureReason(output: ReviewerAttempt["output"]): string {
  const adapterReason = output.metadata?.fallbackReason;
  if (typeof adapterReason === "string" && adapterReason !== "") {
    return adapterReason;
  }
  if (output.structured !== undefined) {
    return "invalid_structured_output";
  }
  return output.text?.trim() ? "unparseable_text_output" : "empty_output";
}

/** Raw material a repair request can transcribe; undefined means nothing survived to repair. */
function repairMaterial(output: ReviewerAttempt["output"]): string | undefined {
  if (output.structured !== undefined) {
    try {
      return JSON.stringify(output.structured);
    } catch {
      return undefined;
    }
  }
  const text = output.text?.trim();
  return text ? text : undefined;
}

async function tryStructuredRepair(input: {
  options: SingleReviewerOptions;
  material: string;
  remainingTimeoutMs: number | undefined;
}): Promise<{ evaluation: RepairEvaluation; metadata?: Record<string, unknown> } | undefined> {
  const runStructured = input.options.adapter.runStructured;
  if (runStructured === undefined) {
    return undefined;
  }
  const abortController = new AbortController();
  try {
    const output = await withTimeout(
      () =>
        runStructured({
          cwd: input.options.cwd,
          reviewer: input.options.reviewer,
          prompt: buildRepairPrompt(input.material),
          schema: repairResponseJsonSchema,
          ...(input.remainingTimeoutMs !== undefined
            ? { timeoutMs: input.remainingTimeoutMs }
            : {}),
          signal: abortController.signal,
          env: input.options.env,
          ...(input.options.runContext !== undefined
            ? { runContext: input.options.runContext }
            : {}),
        }),
      input.remainingTimeoutMs,
      abortController,
      input.options.reviewer.id,
      "run",
    );
    const evaluation = evaluateRepairResponse(output);
    if (evaluation === undefined) {
      return undefined;
    }
    return {
      evaluation,
      ...(output.metadata !== undefined ? { metadata: output.metadata } : {}),
    };
  } catch {
    // A failed repair request is never fatal; the labeled re-run is the recovery path.
    return undefined;
  }
}

/**
 * Engine-reported spend summed across every invocation the pipeline made, so a repaired or
 * retried artifact reports the reviewer's full cost instead of only the last invocation's.
 */
function summedInvocationMetadata(
  ...sources: (Record<string, unknown> | undefined)[]
): Record<string, unknown> {
  const summed: Record<string, unknown> = {};
  for (const key of ["durationMs", "totalCostUsd"]) {
    const values = sources
      .map((source) => source?.[key])
      .filter((value): value is number => typeof value === "number");
    if (values.length > 0) {
      summed[key] = values.reduce((total, value) => total + value, 0);
    }
  }
  return summed;
}

function remainingAfter(options: SingleReviewerOptions, start: number): number | undefined {
  return options.remainingTimeoutMs === undefined
    ? undefined
    : Math.max(0, options.remainingTimeoutMs - (Date.now() - start));
}

function buildReviewerArtifact(
  options: SingleReviewerOptions,
  attempt: ReviewerAttempt,
  timingMs: number,
  attemptMetadata?: Record<string, unknown>,
): ReviewReviewerArtifact {
  const validation = validateReviewResult({
    result: attempt.parsed.result,
    target: options.resolved.target,
    validation: attempt.parsed.validation,
    changedLineRanges: options.changedLineRanges,
  });
  const metadata =
    attemptMetadata !== undefined
      ? { ...attempt.output.metadata, ...attemptMetadata }
      : attempt.output.metadata;
  const reviewerArtifact: ReviewReviewerArtifact = {
    ...reviewerArtifactBase(options),
    result: attempt.parsed.result,
    validation,
    timing_ms: timingMs,
  };

  if (attempt.parsed.rawText !== undefined) {
    reviewerArtifact.raw_text = attempt.parsed.rawText;
  }

  if (options.preflight !== undefined) {
    reviewerArtifact.preflight = options.preflight;
  }

  if (metadata !== undefined) {
    reviewerArtifact.adapter_metadata = metadata;
  }

  if (attempt.output.usage !== undefined) {
    reviewerArtifact.usage = attempt.output.usage;
  }

  return reviewerArtifact;
}

function buildRepairedReviewerArtifact(input: {
  options: SingleReviewerOptions;
  attempt: ReviewerAttempt;
  material: string;
  repaired: RepairEvaluation;
  repairMetadata?: Record<string, unknown>;
  failureReason: string;
  timingMs: number;
}): ReviewReviewerArtifact {
  const parsed = parseReviewOutput({ structured: input.repaired.review });
  const validation = validateReviewResult({
    result: parsed.result,
    target: input.options.resolved.target,
    validation: parsed.validation,
    changedLineRanges: input.options.changedLineRanges,
  });
  const reviewerArtifact: ReviewReviewerArtifact = {
    ...reviewerArtifactBase(input.options),
    result: parsed.result,
    validation,
    timing_ms: input.timingMs,
    // The malformed original stays on the artifact so a repair is auditable.
    raw_text: input.material,
    adapter_metadata: {
      ...input.attempt.output.metadata,
      ...summedInvocationMetadata(input.attempt.output.metadata, input.repairMetadata),
      captureMode: "repaired",
      repairConfidence: input.repaired.confidence,
      repairFailureReason: input.failureReason,
    },
  };

  if (input.options.preflight !== undefined) {
    reviewerArtifact.preflight = input.options.preflight;
  }

  if (input.attempt.output.usage !== undefined) {
    reviewerArtifact.usage = input.attempt.output.usage;
  }

  return reviewerArtifact;
}

function reviewerArtifactBase(
  options: SingleReviewerOptions,
): Omit<ReviewReviewerArtifact, "result" | "validation" | "timing_ms"> & { status: "success" } {
  return {
    id: options.reviewer.id,
    engine: options.reviewer.sdk,
    status: "success",
    ...reviewerArtifactTransport(options.reviewer),
    ...(options.reviewer.profile ? { profile: options.reviewer.profile } : {}),
    ...(options.reviewer.provider ? { provider: options.reviewer.provider } : {}),
    ...(options.reviewer.model ? { model: options.reviewer.model } : {}),
    ...(options.reviewer.effort ? { effort: options.reviewer.effort } : {}),
  };
}

type ReviewerContext = {
  reviewer: ReviewReviewerConfig;
  adapter: ReviewAdapter;
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>;
  runContext?: unknown;
  remainingTimeoutMs?: number;
};

async function preflightReviewer(options: {
  cwd: string;
  repoRoot?: string;
  reviewer: ReviewReviewerConfig;
  env: NodeJS.ProcessEnv;
  adapters?: Partial<Record<string, ReviewAdapter>>;
}): Promise<ReviewerContext> {
  const adapter = getAdapter(options.reviewer, options.adapters);
  const abortController = new AbortController();
  const start = Date.now();
  const preflightInput = {
    cwd: options.cwd,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    reviewer: options.reviewer,
    signal: abortController.signal,
    readonly: true,
    env: options.env,
  };
  const prepared: ReviewAdapterPrepareResult =
    adapter.prepare !== undefined
      ? await withTimeout(
          () => adapter.prepare?.(preflightInput) ?? Promise.resolve({}),
          options.reviewer.timeoutMs,
          abortController,
          options.reviewer.id,
          "preflight",
        )
      : adapter.preflight === undefined
        ? {}
        : await withTimeout(
            () =>
              adapter.preflight?.(preflightInput).then((preflight) => ({ preflight })) ??
              Promise.resolve({}),
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
    ...(prepared.preflight !== undefined ? { preflight: prepared.preflight } : {}),
    ...(prepared.runContext !== undefined ? { runContext: prepared.runContext } : {}),
    ...(remainingTimeoutMs !== undefined ? { remainingTimeoutMs } : {}),
  };
}

async function runSingleReviewerPreflight(options: {
  cwd: string;
  repoRoot?: string;
  reviewer: ReviewReviewerConfig;
  env: NodeJS.ProcessEnv;
  adapters?: Partial<Record<string, ReviewAdapter>>;
}): Promise<ReviewerPreflightArtifact> {
  const start = Date.now();
  try {
    const context = await preflightReviewer(options);
    return {
      id: context.reviewer.id,
      engine: context.reviewer.sdk,
      status: "passed",
      ...reviewerArtifactTransport(context.reviewer),
      ...(context.reviewer.profile ? { profile: context.reviewer.profile } : {}),
      ...(context.reviewer.provider ? { provider: context.reviewer.provider } : {}),
      ...(context.reviewer.model ? { model: context.reviewer.model } : {}),
      ...(context.reviewer.effort ? { effort: context.reviewer.effort } : {}),
      ...(context.preflight !== undefined ? { preflight: context.preflight } : {}),
      timing_ms: Date.now() - start,
    };
  } catch (error) {
    return {
      id: options.reviewer.id,
      engine: options.reviewer.sdk,
      status: "failed",
      ...reviewerArtifactTransport(options.reviewer),
      ...(options.reviewer.profile ? { profile: options.reviewer.profile } : {}),
      ...(options.reviewer.provider ? { provider: options.reviewer.provider } : {}),
      ...(options.reviewer.model ? { model: options.reviewer.model } : {}),
      ...(options.reviewer.effort ? { effort: options.reviewer.effort } : {}),
      error: reviewerError(error),
      timing_ms: Date.now() - start,
    };
  }
}

function createFailedReviewerArtifact(
  reviewer: ReviewReviewerConfig,
  error: unknown,
  start: number,
  preflight?: Awaited<ReturnType<NonNullable<ReviewAdapter["preflight"]>>>,
): FailedReviewerArtifact {
  return {
    id: reviewer.id,
    engine: reviewer.sdk,
    status: "failed",
    ...reviewerArtifactTransport(reviewer),
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
    return serializedDiffwardenError(error);
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

function isSuccessfulLaneArtifact(lane: ReviewBatchLaneArtifact): lane is SuccessfulLaneArtifact {
  return lane.status === "success";
}

function isFailedLaneArtifact(lane: ReviewBatchLaneArtifact): lane is FailedLaneArtifact {
  return lane.status === "failed";
}

function throwReviewerFailures(
  failures: FailedReviewerArtifact[],
  options: { strict: boolean; reviewerCount: number },
): never {
  const [firstFailure] = failures;
  if (options.reviewerCount === 1 && firstFailure !== undefined) {
    throw diffwardenErrorFromReviewerError(firstFailure.error);
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

function serializedDiffwardenError(error: DiffwardenError): ReviewerError {
  return {
    code: error.code,
    message: error.message,
    exit_code: error.exitCode,
    ...(error.reason !== undefined ? { reason: error.reason } : {}),
    ...(error.recovery !== undefined ? { recovery: [...error.recovery] } : {}),
  };
}

export function diffwardenErrorFromReviewerError(error: ReviewerError): DiffwardenError {
  return new DiffwardenError(error.code as ReviewErrorCode, error.message, error.exit_code ?? 3, {
    ...(error.reason !== undefined ? { reason: error.reason } : {}),
    ...(error.recovery !== undefined ? { recovery: error.recovery } : {}),
  });
}

function enforceStrictValidation(validation: ReviewValidation): void {
  if (!validation.valid_schema || validation.parse_mode === "fallback-text") {
    throw parseFailed("Reviewer output could not be parsed as a valid review result");
  }

  if (!validation.valid_locations || !validation.findings_overlap_diff) {
    throw validationFailed("Reviewer output contains findings outside the reviewed diff");
  }
}

function mergeLaneResults(lanes: SuccessfulLaneArtifact[]): ReviewBatchArtifactResult {
  const findings = mergeLaneFindings(lanes);
  const incorrect = lanes.some(
    (lane) =>
      lane.artifact.result.overall_correctness === "patch is incorrect" ||
      lane.artifact.result.findings.length > 0,
  );
  const unknown = lanes.some((lane) => lane.artifact.result.overall_correctness === "unknown");
  const confidenceScores = lanes.map((lane) => lane.artifact.result.overall_confidence_score);
  const confidence =
    confidenceScores.length === 0
      ? 0
      : confidenceScores.reduce((sum, score) => sum + score, 0) / confidenceScores.length;
  const explanations = lanes.map((lane) => {
    const label = lane.kind === "overview" ? "overview" : `${lane.id} (${lane.focus})`;
    return `${label}: ${lane.artifact.result.overall_explanation.trim()}`;
  });

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

function mergeLaneFindings(lanes: SuccessfulLaneArtifact[]): ReviewBatchArtifactResult["findings"] {
  const findingsByKey = new Map<string, ReviewBatchArtifactResult["findings"][number]>();

  for (const lane of lanes) {
    for (const finding of lane.artifact.result.findings) {
      const key = findingDeduplicationKey(finding);
      const existing = findingsByKey.get(key);
      if (existing === undefined) {
        findingsByKey.set(key, {
          ...finding,
          reviewer_ids: finding.reviewer_ids ?? [],
          lane_ids: [lane.id],
        });
        continue;
      }

      existing.reviewer_ids = [
        ...new Set([...(existing.reviewer_ids ?? []), ...(finding.reviewer_ids ?? [])]),
      ];
      existing.lane_ids = [...new Set([...existing.lane_ids, lane.id])];
    }
  }

  return [...findingsByKey.values()];
}

function aggregateLaneValidationSeed(lanes: SuccessfulLaneArtifact[]): ReviewValidation {
  return {
    parse_mode: aggregateLaneParseMode(lanes),
    valid_schema: lanes.every((lane) => lane.artifact.validation.valid_schema),
    findings_overlap_diff: lanes.every((lane) => lane.artifact.validation.findings_overlap_diff),
    valid_locations: lanes.every((lane) => lane.artifact.validation.valid_locations),
    invalid_locations: [],
  };
}

function aggregateLaneParseMode(lanes: SuccessfulLaneArtifact[]): ParseMode {
  const [firstLane] = lanes;
  if (
    firstLane !== undefined &&
    lanes.every(
      (lane) => lane.artifact.validation.parse_mode === firstLane.artifact.validation.parse_mode,
    )
  ) {
    return firstLane.artifact.validation.parse_mode;
  }

  return "tool-output";
}

function batchWarnings(
  successfulLanes: SuccessfulLaneArtifact[],
  failedLanes: FailedLaneArtifact[],
): string[] {
  return [
    ...failedLanes.map((lane) => `Lane ${lane.id} failed: ${lane.error.message}`),
    ...successfulLanes.flatMap((lane) =>
      (lane.artifact.warnings ?? []).map((warning) => `Lane ${lane.id}: ${warning}`),
    ),
  ];
}

function formatFailedLanes(lanes: FailedLaneArtifact[]): string {
  return lanes.map((lane) => `${lane.id}: ${lane.error.message}`).join("; ");
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

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private closed = false;
  private waiting: ((result: IteratorResult<T>) => void) | undefined;

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }

      if (this.closed) {
        return;
      }

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done === true) {
        return;
      }
      yield next.value;
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

  // Transport-specific branches must stay before SDK-specific branches for dual-path engines.
  if (reviewer.transport === "cli") {
    if (reviewer.sdk === "fake") {
      throw invalidCli("Fake reviewer does not support CLI transport");
    }
    return createCliAdapter(reviewer.sdk);
  }

  if (reviewer.transport === "app-server") {
    if (reviewer.sdk !== "codex") {
      throw invalidCli(`${reviewer.sdk} app-server transport is not supported`);
    }
    return createCodexAppServerAdapter();
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

  if (reviewer.sdk === "droid") {
    return droidAdapter;
  }

  if (reviewer.sdk === "copilot") {
    return copilotAdapter;
  }

  return createCliAdapter(reviewer.sdk);
}

function reviewerAdapterKey(reviewer: ReviewReviewerConfig): string {
  return `${reviewer.sdk}:${reviewer.transport ?? "sdk"}`;
}

function reviewerArtifactTransport(
  reviewer: ReviewReviewerConfig,
): { transport: "native" | "cli" | "app-server" } | Record<string, never> {
  if (reviewer.sdk === "fake" && reviewer.transport === undefined) {
    return {};
  }

  if (reviewer.transport === "cli" || reviewer.transport === "app-server") {
    return { transport: reviewer.transport };
  }

  return { transport: "native" };
}
