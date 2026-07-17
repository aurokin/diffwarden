import { describe, expect, it } from "vitest";
import { createLiveReviewProgress } from "../src/core/live-progress.js";
import type {
  ReviewReviewerArtifact,
  ReviewTargetResolved,
  ReviewerError,
} from "../src/core/schema.js";
import { asciiGlyphs } from "../src/core/terminal-caps.js";

const target: ReviewTargetResolved = {
  kind: "base",
  base_ref: "main",
  repo_root: "/repo",
  diff_command: "git diff main",
  changed_files: ["src/notify.ts"],
};

function fakeStream(columns = 100): { output: () => string; stream: never } {
  let buffer = "";
  const stream = {
    columns,
    rows: 40,
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
  };
  return { output: () => buffer, stream: stream as never };
}

function reviewerArtifact(overrides: Partial<ReviewReviewerArtifact> = {}): ReviewReviewerArtifact {
  return {
    id: "codex",
    engine: "codex",
    status: "success",
    result: {
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "fine",
      overall_confidence_score: 0.94,
    },
    validation: {
      parse_mode: "tool-output",
      valid_schema: true,
      findings_overlap_diff: false,
      valid_locations: false,
      invalid_locations: [],
    },
    timing_ms: 10_700,
    ...overrides,
  };
}

const failure: ReviewerError = {
  code: "missing_auth",
  message: "not authenticated\nstack",
  exit_code: 3,
};

function makeProgress(stream: never, now: () => number) {
  return createLiveReviewProgress({
    stream,
    color: false,
    glyphs: asciiGlyphs,
    now,
    // A long interval: tests drive frames through events + finish(), never timers.
    intervalMs: 60_000,
  });
}

describe("createLiveReviewProgress", () => {
  it("commits one row per reviewer with its verdict, vocabulary matching the banner", () => {
    const { output, stream } = fakeStream();
    const progress = makeProgress(stream, () => 1_000);
    progress.handleEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target,
      reviewers: [
        { id: "codex", engine: "codex" },
        { id: "claude", engine: "claude" },
      ],
    });
    progress.handleEvent({
      schema_version: 2,
      type: "reviewer_result",
      reviewer_id: "codex",
      provisional: true,
      artifact: reviewerArtifact(),
    });
    progress.handleEvent({
      schema_version: 2,
      type: "reviewer_result",
      reviewer_id: "claude",
      provisional: true,
      artifact: reviewerArtifact({
        id: "claude",
        engine: "claude",
        result: {
          findings: [],
          overall_correctness: "patch is incorrect",
          overall_explanation: "bug",
          overall_confidence_score: 0.97,
        },
        timing_ms: 12_100,
      }),
    });
    progress.finish();

    const text = output();
    expect(text).toContain("diffwarden");
    expect(text).toContain("base:main");
    expect(text).toContain("2 reviewers");
    expect(text).toContain("+ codex        correct   11s · 0 findings · conf 0.94");
    expect(text).toContain("x claude       flagged   12s · 0 findings · conf 0.97");
  });

  it("commits a failed reviewer with the first error line only", () => {
    const { output, stream } = fakeStream();
    const progress = makeProgress(stream, () => 0);
    progress.handleEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target,
      reviewers: [{ id: "cursor", engine: "cursor" }],
    });
    progress.handleEvent({
      schema_version: 2,
      type: "reviewer_failed",
      reviewer_id: "cursor",
      error: failure,
      timing_ms: 8_200,
    });
    progress.finish();

    expect(output()).toContain("x cursor       failed   8.2s · not authenticated");
    expect(output()).not.toContain("stack");
  });

  it("erases exactly the volatile block on redraw, never committed lines", () => {
    const { output, stream } = fakeStream();
    const progress = makeProgress(stream, () => 5_000);
    progress.handleEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target,
      reviewers: [
        { id: "codex", engine: "codex" },
        { id: "claude", engine: "claude" },
      ],
    });
    // First paint happened immediately (blank-terminal exception): header + 2 volatile rows.
    const first = output();
    expect(first).toContain("codex");
    expect(first).toContain("claude");

    progress.handleEvent({
      schema_version: 2,
      type: "reviewer_result",
      reviewer_id: "codex",
      provisional: true,
      artifact: reviewerArtifact(),
    });
    progress.finish();

    // The redraw erased the 2-row volatile block (cursor up 2 + erase down), then committed.
    expect(output()).toContain("\u001B[2A\u001B[0J");
    // finish() leaves no volatile rows behind; claude's unfinished row commits as pending.
    expect(output()).toContain("- claude       waiting");
  });

  it("commits exactly one row when preflight fails (reviewer_failed follows it)", () => {
    const { output, stream } = fakeStream();
    const progress = makeProgress(stream, () => 0);
    progress.handleEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target,
      reviewers: [{ id: "cursor", engine: "cursor" }],
    });
    // The runner emits BOTH events for a failed preflight; only reviewer_failed may commit.
    progress.handleEvent({
      schema_version: 2,
      type: "preflight_finished",
      reviewer_id: "cursor",
      ok: false,
      timing_ms: 300,
    });
    progress.handleEvent({
      schema_version: 2,
      type: "reviewer_failed",
      reviewer_id: "cursor",
      error: failure,
      timing_ms: 300,
    });
    progress.finish();
    const failedRows = output()
      .split("\n")
      .filter((line) => line.includes("cursor") && line.includes("failed"));
    expect(failedRows).toHaveLength(1);
  });

  it("abandons the volatile block on resize instead of erasing a reflowed region", () => {
    const { output, stream } = fakeStream();
    const progress = makeProgress(stream, () => 0);
    progress.handleEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target,
      reviewers: [{ id: "codex", engine: "codex" }],
    });
    const beforeResize = output();
    expect(beforeResize).toContain("codex");
    process.emit("SIGWINCH");
    progress.finish();
    // finish() after the resize must NOT cursor-up over the abandoned block.
    const afterResize = output().slice(beforeResize.length);
    expect(afterResize).not.toContain("[1A");
  });

  it("stays quiet after finish and never throws on late events", () => {
    const { output, stream } = fakeStream();
    const progress = makeProgress(stream, () => 0);
    progress.finish();
    const settled = output();
    progress.handleEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target,
      reviewers: [{ id: "codex", engine: "codex" }],
    });
    progress.finish();
    expect(output()).toBe(settled);
  });

  it("self-times reviewing rows from reviewer_started using the injected clock", () => {
    let clock = 0;
    const { output, stream } = fakeStream();
    const progress = makeProgress(stream, () => clock);
    progress.handleEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target,
      reviewers: [{ id: "codex", engine: "codex" }],
    });
    progress.handleEvent({ schema_version: 2, type: "reviewer_started", reviewer_id: "codex" });
    clock = 14_000;
    progress.finish();
    // finish() commits the still-running row; elapsed came from the clock seam.
    expect(output()).toContain("codex");
    expect(output()).toContain("reviewing");
  });
});
