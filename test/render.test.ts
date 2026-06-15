import { describe, expect, it } from "vitest";
import {
  renderAgentReviewSummary,
  renderHumanReviewArtifact,
  renderHumanReviewEvent,
  renderHumanReviewSummary,
  shouldUseHumanColor,
} from "../src/core/human-render.js";
import type { ReviewArtifact, ReviewArtifactFinding } from "../src/core/schema.js";

const artifact: ReviewArtifact = {
  schema_version: 2,
  engine: "fake",
  cwd: "/repo",
  target: {
    kind: "uncommitted",
    repo_root: "/repo",
    diff_command: "git diff",
    changed_files: ["src/client.ts"],
  },
  result: {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "The reviewed patch does not appear to introduce correctness issues.",
    overall_confidence_score: 0.76,
  },
  validation: {
    parse_mode: "tool-output",
    valid_schema: true,
    findings_overlap_diff: false,
    valid_locations: false,
    invalid_locations: [],
  },
};

describe("human review rendering", () => {
  it("renders run events without ANSI by default", () => {
    const output = renderHumanReviewEvent({
      schema_version: 2,
      type: "run_started",
      cwd: "/repo",
      target: artifact.target,
      reviewers: [{ id: "fake", engine: "fake" }],
    });

    expect(output).toContain("diffwarden review");
    expect(output).toContain("Target: uncommitted");
    expect(output).toContain("Reviewers: fake");
    expect(output).not.toContain("\u001B[");
  });

  it("renders findings, warnings, and failed reviewers in the summary", () => {
    const summary = renderHumanReviewSummary({
      ...artifact,
      warnings: ["Reviewer claude failed: missing auth"],
      reviewers: [
        {
          id: "fake",
          engine: "fake",
          transport: "native",
          status: "success",
          result: artifact.result,
          validation: artifact.validation,
        },
        {
          id: "claude",
          engine: "claude",
          transport: "native",
          status: "failed",
          error: {
            code: "missing_auth",
            message: "missing auth",
            exit_code: 3,
          },
        },
      ],
      result: {
        ...artifact.result,
        findings: [finding("[P2] Human finding", 2, "/repo/src/client.ts", 10)],
        overall_correctness: "patch is incorrect",
      },
    });

    expect(summary).toContain("Result");
    expect(summary).toContain("Verdict: patch is incorrect");
    expect(summary).toContain("Findings: 1 (P2 1)");
    expect(summary).toContain("Warnings");
    expect(summary).toContain("Failed reviewers");
    expect(summary).toContain("[P2] Human finding");
  });

  it("renders a complete saved artifact view", () => {
    const output = renderHumanReviewArtifact(artifact);

    expect(output).toContain("diffwarden review");
    expect(output).toContain("Target: uncommitted");
    expect(output).toContain("Reviewers: fake");
    expect(output).toContain("Result");
    expect(output).toContain("Verdict: patch is correct");
  });

  it("renders plain agent output without ANSI", () => {
    const output = renderAgentReviewSummary({
      ...artifact,
      result: {
        ...artifact.result,
        findings: [finding("[P2] Agent finding", 2, "/repo/src/client.ts", 10)],
        overall_correctness: "patch is incorrect",
      },
    });

    expect(output).toContain("Diffwarden Review");
    expect(output).toContain("Verdict: patch is incorrect");
    expect(output).toContain("Findings: 1 (P2 1)");
    expect(output).toContain("1. P2 [P2] Agent finding");
    expect(output).toContain("File: /repo/src/client.ts:10-10");
    expect(output).not.toContain("\u001B[");
  });

  it("disables human color outside capable TTYs", () => {
    expect(shouldUseHumanColor({ env: {}, stream: { isTTY: false } })).toBe(false);
    expect(shouldUseHumanColor({ env: { TERM: "dumb" }, stream: { isTTY: true } })).toBe(false);
    expect(shouldUseHumanColor({ env: { NO_COLOR: "1" }, stream: { isTTY: true } })).toBe(false);
    expect(shouldUseHumanColor({ env: {}, stream: { isTTY: true } })).toBe(true);
  });
});

function finding(
  title: string,
  priority: ReviewArtifactFinding["priority"] | undefined,
  absoluteFilePath: string,
  line: number,
): ReviewArtifactFinding {
  const reviewFinding: ReviewArtifactFinding = {
    title,
    body: "Finding body.",
    confidence_score: 0.8,
    code_location: {
      absolute_file_path: absoluteFilePath,
      line_range: {
        start: line,
        end: line,
      },
    },
  };

  if (priority !== undefined) {
    reviewFinding.priority = priority;
  }

  return reviewFinding;
}
