import { describe, expect, it } from "vitest";
import {
  buildRepairPrompt,
  evaluateRepairResponse,
  repairResponseJsonSchema,
} from "../src/core/repair.js";

function validReview() {
  return {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "No findings.",
    overall_confidence_score: 0.91,
  };
}

describe("buildRepairPrompt", () => {
  it("embeds the malformed material, the wrapper contract, and the review schema", () => {
    const prompt = buildRepairPrompt('{"findings": "oops"}');
    expect(prompt).toContain('{"findings": "oops"}');
    expect(prompt).toContain("fixable");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("overall_confidence_score");
    expect(prompt).toContain("Do NOT invent findings");
  });
});

describe("repairResponseJsonSchema", () => {
  it("requires the wrapper fields and allows a null review", () => {
    expect(repairResponseJsonSchema.required).toEqual(["fixable", "confidence", "review"]);
    const properties = repairResponseJsonSchema.properties as Record<string, unknown>;
    expect(properties.review).toMatchObject({ anyOf: expect.any(Array) });
  });
});

describe("evaluateRepairResponse", () => {
  it("accepts a fixable high/medium-confidence wrapper with a schema-valid review", () => {
    for (const confidence of ["high", "medium"] as const) {
      expect(
        evaluateRepairResponse({
          structured: { fixable: true, confidence, review: validReview() },
        }),
      ).toEqual({ review: validReview(), confidence });
    }
  });

  it("rejects low confidence even when the review is valid", () => {
    expect(
      evaluateRepairResponse({
        structured: { fixable: true, confidence: "low", review: validReview() },
      }),
    ).toBeUndefined();
  });

  it("rejects unfixable responses", () => {
    expect(
      evaluateRepairResponse({
        structured: { fixable: false, confidence: "high", review: null },
      }),
    ).toBeUndefined();
  });

  it("rejects wrappers whose review fails the schema", () => {
    expect(
      evaluateRepairResponse({
        structured: {
          fixable: true,
          confidence: "high",
          review: { ...validReview(), overall_confidence_score: 2 },
        },
      }),
    ).toBeUndefined();
  });

  it("rejects outputs that are not a wrapper at all", () => {
    // A bare review without the wrapper must not be accepted — meta fields are the contract.
    expect(evaluateRepairResponse({ structured: validReview() })).toBeUndefined();
    expect(evaluateRepairResponse({})).toBeUndefined();
    expect(evaluateRepairResponse({ text: "not json" })).toBeUndefined();
  });

  it("unwraps a wrapper delivered as JSON text", () => {
    const wrapper = { fixable: true, confidence: "high", review: validReview() };
    expect(evaluateRepairResponse({ text: JSON.stringify(wrapper) })).toEqual({
      review: validReview(),
      confidence: "high",
    });
  });

  it("extracts a wrapper embedded in surrounding prose", () => {
    const wrapper = { fixable: true, confidence: "medium", review: validReview() };
    const text = `Here is the repaired response:\n${JSON.stringify(wrapper)}\nDone.`;
    expect(evaluateRepairResponse({ text })).toEqual({
      review: validReview(),
      confidence: "medium",
    });
  });
});
