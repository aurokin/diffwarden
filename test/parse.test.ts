import { describe, expect, it } from "vitest";
import { parseReviewOutput } from "../src/core/parse.js";
import type { ReviewResult } from "../src/core/schema.js";

const validReviewResult: ReviewResult = {
  findings: [
    {
      title: "[P2] Guard empty response before reading body",
      body: "When the API returns 204, the response body is null and this branch throws before the retry path can run.",
      confidence_score: 0.82,
      priority: 2,
      code_location: {
        absolute_file_path: "/repo/src/client.ts",
        line_range: {
          start: 42,
          end: 42,
        },
      },
    },
  ],
  overall_correctness: "patch is incorrect",
  overall_explanation: "The patch introduces a null response crash in one retry path.",
  overall_confidence_score: 0.8,
};

describe("parseReviewOutput", () => {
  it("parses strict JSON text", () => {
    const parsed = parseReviewOutput({ text: JSON.stringify(validReviewResult) });

    expect(parsed.validation.parse_mode).toBe("strict-json");
    expect(parsed.validation.valid_schema).toBe(true);
    expect(parsed.result).toEqual(validReviewResult);
  });

  it("extracts JSON from surrounding text", () => {
    const parsed = parseReviewOutput({
      text: `Here is the review:\n${JSON.stringify(validReviewResult)}\nDone.`,
    });

    expect(parsed.validation.parse_mode).toBe("extracted-json");
    expect(parsed.validation.valid_schema).toBe(true);
    expect(parsed.result.findings).toHaveLength(1);
  });

  it("uses tool-output mode for structured adapter output", () => {
    const parsed = parseReviewOutput({ structured: validReviewResult });

    expect(parsed.validation.parse_mode).toBe("tool-output");
    expect(parsed.validation.valid_schema).toBe(true);
    expect(parsed.result.overall_correctness).toBe("patch is incorrect");
  });

  it("accepts findings with omitted priority", () => {
    const [findingWithPriority] = validReviewResult.findings;
    expect(findingWithPriority).toBeDefined();
    if (findingWithPriority === undefined) {
      throw new Error("test fixture must include a finding");
    }

    const { priority: _priority, ...findingWithoutPriority } = findingWithPriority;
    const parsed = parseReviewOutput({
      structured: {
        ...validReviewResult,
        findings: [findingWithoutPriority],
      },
    });

    expect(parsed.validation.parse_mode).toBe("tool-output");
    expect(parsed.validation.valid_schema).toBe(true);
    expect(parsed.result.findings[0]?.priority).toBeUndefined();
  });

  it("rejects unsupported overall correctness verdicts", () => {
    const parsed = parseReviewOutput({
      structured: {
        ...validReviewResult,
        overall_correctness: "looks fine",
      },
    });

    expect(parsed.validation.parse_mode).toBe("fallback-text");
    expect(parsed.validation.valid_schema).toBe(false);
  });

  it("falls back to preserving plain text", () => {
    const parsed = parseReviewOutput({ text: "No obvious correctness issues found." });

    expect(parsed.validation.parse_mode).toBe("fallback-text");
    expect(parsed.validation.valid_schema).toBe(false);
    expect(parsed.result.findings).toEqual([]);
    expect(parsed.result.overall_correctness).toBe("unknown");
    expect(parsed.result.overall_explanation).toBe("No obvious correctness issues found.");
  });

  it("rejects reversed line ranges as invalid schema", () => {
    const parsed = parseReviewOutput({
      structured: {
        ...validReviewResult,
        findings: [
          {
            ...validReviewResult.findings[0],
            code_location: {
              absolute_file_path: "/repo/src/client.ts",
              line_range: {
                start: 44,
                end: 42,
              },
            },
          },
        ],
      },
    });

    expect(parsed.validation.parse_mode).toBe("fallback-text");
    expect(parsed.validation.valid_schema).toBe(false);
  });

  it("safely preserves invalid structured output that cannot be JSON-stringified", () => {
    const parsed = parseReviewOutput({ structured: undefined });

    expect(parsed.validation.parse_mode).toBe("fallback-text");
    expect(parsed.result.overall_explanation).toBe("undefined");
  });

  it("safely preserves BigInt structured output", () => {
    const parsed = parseReviewOutput({ structured: 1n });

    expect(parsed.validation.parse_mode).toBe("fallback-text");
    expect(parsed.result.overall_explanation).toBe("1");
  });

  it("safely preserves circular structured output", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const parsed = parseReviewOutput({ structured: circular });

    expect(parsed.validation.parse_mode).toBe("fallback-text");
    expect(parsed.result.overall_explanation).toBe("[object Object]");
  });
});
