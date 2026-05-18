import { describe, expect, it } from "vitest";
import type {
  ReviewArtifactResult,
  ReviewTargetResolved,
  ReviewValidation,
} from "../src/core/schema.js";
import { validateReviewResult } from "../src/core/validate.js";

const target: ReviewTargetResolved = {
  kind: "uncommitted",
  repo_root: "/repo",
  diff_command: "git diff",
  changed_files: ["src/client.ts"],
};

const validation: ReviewValidation = {
  parse_mode: "tool-output",
  valid_schema: true,
  findings_overlap_diff: false,
  valid_locations: false,
  invalid_locations: [],
};

describe("validateReviewResult", () => {
  it("accepts relative finding paths that match changed files", () => {
    const result = reviewResult("src/client.ts");

    const nextValidation = validateReviewResult({ result, target, validation });

    expect(nextValidation.valid_locations).toBe(true);
    expect(nextValidation.invalid_locations).toEqual([]);
  });

  it("accepts absolute finding paths under the repo root", () => {
    const result = reviewResult("/repo/src/client.ts");

    const nextValidation = validateReviewResult({ result, target, validation });

    expect(nextValidation.valid_locations).toBe(true);
    expect(nextValidation.invalid_locations).toEqual([]);
  });

  it("reports finding paths outside changed files", () => {
    const result = reviewResult("/repo/src/other.ts");

    const nextValidation = validateReviewResult({ result, target, validation });

    expect(nextValidation.valid_locations).toBe(false);
    expect(nextValidation.invalid_locations).toEqual([
      {
        index: 0,
        reason: "Finding path is not in changed files: /repo/src/other.ts",
      },
    ]);
  });

  it("accepts findings that overlap changed lines", () => {
    const result = reviewResult("/repo/src/client.ts", 12);

    const nextValidation = validateReviewResult({
      result,
      target,
      validation,
      changedLineRanges: {
        "src/client.ts": [{ start: 10, end: 12 }],
      },
    });

    expect(nextValidation.valid_locations).toBe(true);
    expect(nextValidation.findings_overlap_diff).toBe(true);
    expect(nextValidation.invalid_locations).toEqual([]);
  });

  it("reports findings that do not overlap changed lines", () => {
    const result = reviewResult("/repo/src/client.ts", 20);

    const nextValidation = validateReviewResult({
      result,
      target,
      validation,
      changedLineRanges: {
        "src/client.ts": [{ start: 10, end: 12 }],
      },
    });

    expect(nextValidation.valid_locations).toBe(false);
    expect(nextValidation.findings_overlap_diff).toBe(false);
    expect(nextValidation.invalid_locations).toEqual([
      {
        index: 0,
        reason: "Finding line range does not overlap changed lines: /repo/src/client.ts",
      },
    ]);
  });
});

function reviewResult(filePath: string, line = 1): ReviewArtifactResult {
  return {
    findings: [
      {
        title: "[P2] Example issue",
        body: "Example body.",
        confidence_score: 0.8,
        priority: 2,
        code_location: {
          absolute_file_path: filePath,
          line_range: {
            start: line,
            end: line,
          },
        },
      },
    ],
    overall_correctness: "patch is incorrect",
    overall_explanation: "Example explanation.",
    overall_confidence_score: 0.8,
  };
}
