import { fakeAdapter } from "../adapters/fake.js";
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
};

export async function runReview(options: RunReviewOptions): Promise<ReviewArtifact> {
  const reviewer = resolveReviewer(options.reviewer);
  const adapter = getAdapter(reviewer.sdk);
  const start = Date.now();
  const prompt = buildReviewPrompt(options.resolved.target, options.resolved.diff);
  const output = await adapter.run({
    cwd: options.cwd,
    reviewer,
    target: options.resolved.target,
    diff: options.resolved.diff,
    changedFiles: options.resolved.target.changed_files,
    prompt,
    readonly: true,
    env: process.env,
  });
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
    result: parsed.result,
    validation,
    timing_ms: timingMs,
  };

  if (parsed.rawText !== undefined) {
    reviewerArtifact.raw_text = parsed.rawText;
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

function resolveReviewer(spec: string): ReviewReviewerConfig {
  if (spec !== "fake") {
    throw invalidCli(`Reviewer is not implemented yet: ${spec}`);
  }

  return {
    id: "fake",
    sdk: "fake",
    readonly: true,
  };
}

function getAdapter(sdk: ReviewReviewerConfig["sdk"]): ReviewAdapter {
  if (sdk === "fake") {
    return fakeAdapter;
  }

  throw invalidCli(`Reviewer is not implemented yet: ${sdk}`);
}
