import { describe, expect, it } from "vitest";
import { reviewResultJsonSchema, reviewResultStrictJsonSchema } from "../src/core/schema.js";

describe("reviewResultJsonSchema", () => {
  it("describes the normalized review result contract", () => {
    expect(reviewResultJsonSchema).toMatchObject({
      type: "object",
      required: [
        "findings",
        "overall_correctness",
        "overall_explanation",
        "overall_confidence_score",
      ],
      properties: {
        findings: {
          type: "array",
        },
        overall_correctness: {
          enum: ["patch is correct", "patch is incorrect"],
        },
      },
    });
  });

  it("keeps priority optional for Codex-style findings without a known priority", () => {
    const findingSchema = reviewResultJsonSchema.properties.findings.items;

    expect(findingSchema.required).not.toContain("priority");
    expect(findingSchema.properties.priority).toMatchObject({
      type: "integer",
      enum: [0, 1, 2, 3],
    });
  });

  it("provides a strict provider schema for CLIs that require all properties", () => {
    const findingSchema = reviewResultStrictJsonSchema.properties.findings.items;

    expect(findingSchema.required).toContain("priority");
    expect(reviewResultJsonSchema.properties.findings.items.required).not.toContain("priority");
  });

  it("rejects additional properties in reviewer output", () => {
    const findingSchema = reviewResultJsonSchema.properties.findings.items;

    expect(reviewResultJsonSchema.additionalProperties).toBe(false);
    expect(findingSchema.additionalProperties).toBe(false);
    expect(findingSchema.properties.code_location.additionalProperties).toBe(false);
    expect(findingSchema.properties.code_location.properties.line_range.additionalProperties).toBe(
      false,
    );
  });
});
