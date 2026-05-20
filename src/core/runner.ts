import { claudeAdapter } from "../adapters/claude.js";
import { cursorAdapter } from "../adapters/cursor.js";
import { fakeAdapter } from "../adapters/fake.js";
import { piAdapter } from "../adapters/pi.js";
import type { ReviewAdapter, ReviewReviewerConfig } from "../adapters/types.js";
import { parseChangedLineRanges } from "./diff.js";
import { invalidCli } from "./errors.js";
import type { ResolvedDiff } from "./git.js";
import { parseReviewOutput } from "./parse.js";
import { buildReviewPrompt } from "./prompt.js";
import type { ReviewArtifact, ReviewReviewerArtifact } from "./schema.js";
import { validateReviewResult } from "./validate.js";

export type RunReviewOptions = {
  cwd: string;
  resolved: ResolvedDiff;
  reviewer: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  adapters?: Partial<Record<ReviewReviewerConfig["sdk"], ReviewAdapter>>;
};

export async function runReview(options: RunReviewOptions): Promise<ReviewArtifact> {
  const reviewer = resolveReviewer(options.reviewer, options.model);
  const adapter = getAdapter(reviewer.sdk, options.adapters);
  const start = Date.now();
  const prompt = buildReviewPrompt(options.resolved.target, options.resolved.diff);
  const adapterInput = {
    cwd: options.cwd,
    reviewer,
    target: options.resolved.target,
    diff: options.resolved.diff,
    changedFiles: options.resolved.target.changed_files,
    prompt,
    readonly: true,
    env: options.env ?? process.env,
  };
  const preflight = await adapter.preflight?.({
    cwd: adapterInput.cwd,
    reviewer: adapterInput.reviewer,
    readonly: adapterInput.readonly,
    env: adapterInput.env,
  });
  const output = await adapter.run(adapterInput);
  const parsed =
    output.structured !== undefined
      ? parseReviewOutput({ structured: output.structured })
      : parseReviewOutput({ text: output.text ?? "" });
  const validation = validateReviewResult({
    result: parsed.result,
    target: options.resolved.target,
    validation: parsed.validation,
    changedLineRanges: parseChangedLineRanges(options.resolved.diff),
  });
  const timingMs = Date.now() - start;
  const reviewerArtifact: ReviewReviewerArtifact = {
    id: reviewer.id,
    sdk: reviewer.sdk,
    ...(reviewer.profile ? { profile: reviewer.profile } : {}),
    ...(reviewer.provider ? { provider: reviewer.provider } : {}),
    ...(reviewer.model ? { model: reviewer.model } : {}),
    ...(reviewer.effort ? { effort: reviewer.effort } : {}),
    result: parsed.result,
    validation,
    timing_ms: timingMs,
  };

  if (parsed.rawText !== undefined) {
    reviewerArtifact.raw_text = parsed.rawText;
  }

  if (preflight !== undefined) {
    reviewerArtifact.preflight = preflight;
  }

  if (output.metadata !== undefined) {
    reviewerArtifact.adapter_metadata = output.metadata;
  }

  return {
    schema_version: 1,
    sdk: reviewer.sdk,
    reviewers: [reviewerArtifact],
    cwd: options.cwd,
    target: options.resolved.target,
    result: parsed.result,
    raw_text: parsed.rawText,
    validation,
    timing_ms: timingMs,
  };
}

function resolveReviewer(spec: string, model: string | undefined): ReviewReviewerConfig {
  if (spec === "fake") {
    return {
      id: "fake",
      sdk: "fake",
      ...(model ? { model } : {}),
      readonly: true,
    };
  }

  if (spec === "cursor") {
    return {
      id: "cursor",
      sdk: "cursor",
      model: model ?? "composer-2",
      readonly: true,
    };
  }

  if (spec === "claude") {
    return {
      id: "claude",
      sdk: "claude",
      model: model ?? "claude-sonnet-4-6",
      readonly: true,
    };
  }

  if (spec === "pi") {
    return {
      id: "pi",
      sdk: "pi",
      ...(model ? { model } : {}),
      readonly: true,
    };
  }

  throw invalidCli(`Reviewer is not implemented yet: ${spec}`);
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
