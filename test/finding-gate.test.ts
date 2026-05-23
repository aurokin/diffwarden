import { describe, expect, it } from "vitest";
import {
  hasFindingAtOrAbovePriority,
  parseFindingFailureThreshold,
} from "../src/core/finding-gate.js";
import type { ReviewArtifactResult, ReviewPriority } from "../src/core/schema.js";

describe("parseFindingFailureThreshold", () => {
  it("parses P0 through P3 thresholds", () => {
    expect(parseFindingFailureThreshold("P0")).toBe(0);
    expect(parseFindingFailureThreshold("p1")).toBe(1);
    expect(parseFindingFailureThreshold(" P2 ")).toBe(2);
    expect(parseFindingFailureThreshold("P3")).toBe(3);
  });

  it("rejects invalid thresholds", () => {
    expect(() => parseFindingFailureThreshold("0")).toThrow("Invalid --fail-on-findings value");
    expect(() => parseFindingFailureThreshold("P4")).toThrow("Invalid --fail-on-findings value");
  });
});

describe("hasFindingAtOrAbovePriority", () => {
  it("fails when a finding priority meets the threshold", () => {
    expect(hasFindingAtOrAbovePriority(reviewResult([2]), 2)).toBe(true);
    expect(hasFindingAtOrAbovePriority(reviewResult([1]), 2)).toBe(true);
  });

  it("does not fail when findings are below the threshold", () => {
    expect(hasFindingAtOrAbovePriority(reviewResult([3]), 2)).toBe(false);
  });

  it("ignores unprioritized findings", () => {
    expect(hasFindingAtOrAbovePriority(reviewResult([undefined]), 3)).toBe(false);
  });

  it("checks aggregated findings together", () => {
    expect(hasFindingAtOrAbovePriority(reviewResult([undefined, 3, 1]), 2)).toBe(true);
  });
});

function reviewResult(priorities: Array<ReviewPriority | undefined>): ReviewArtifactResult {
  return {
    findings: priorities.map((priority, index) => ({
      title: priority === undefined ? "Unprioritized issue" : `[P${priority}] Issue`,
      body: "Finding body.",
      confidence_score: 0.8,
      ...(priority === undefined ? {} : { priority }),
      reviewer_ids: index % 2 === 0 ? ["pi"] : ["claude"],
      code_location: {
        absolute_file_path: "/repo/src/client.ts",
        line_range: {
          start: index + 1,
          end: index + 1,
        },
      },
    })),
    overall_correctness: "patch is incorrect",
    overall_explanation: "Findings were reported.",
    overall_confidence_score: 0.8,
  };
}
