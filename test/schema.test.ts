import { describe, expect, it } from "vitest";
import {
  reviewArtifactSchema,
  reviewResultJsonSchema,
  reviewResultStrictJsonSchema,
} from "../src/core/schema.js";

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

describe("reviewArtifactSchema", () => {
  it("rejects removed v1 sdk artifacts", () => {
    expect(() =>
      reviewArtifactSchema.parse({
        schema_version: 1,
        sdk: "pi",
        reviewers: [
          {
            id: "pi-default",
            sdk: "pi",
            transport: "sdk",
            result: reviewResult(),
            validation: validation(),
          },
        ],
        cwd: "/repo",
        target: target(),
        result: reviewResult(),
        validation: validation(),
      }),
    ).toThrow();
  });

  it("rejects removed reviewer sdk artifacts", () => {
    expect(() =>
      reviewArtifactSchema.parse({
        schema_version: 2,
        reviewers: [
          {
            id: "pi-default",
            sdk: "pi",
            transport: "sdk",
            result: reviewResult(),
            validation: validation(),
          },
        ],
        cwd: "/repo",
        target: target(),
        result: reviewResult(),
        validation: validation(),
      }),
    ).toThrow();
  });

  it("rejects removed top-level sdk artifacts", () => {
    expect(() =>
      reviewArtifactSchema.parse({
        schema_version: 2,
        sdk: "pi",
        cwd: "/repo",
        target: target(),
        result: reviewResult(),
        validation: validation(),
      }),
    ).toThrow();
  });

  it("accepts v2 engine artifacts", () => {
    const parsed = reviewArtifactSchema.parse({
      schema_version: 2,
      engine: "pi",
      reviewers: [
        {
          id: "pi-default",
          engine: "pi",
          transport: "native",
          result: reviewResult(),
          validation: validation(),
        },
      ],
      cwd: "/repo",
      target: target(),
      result: reviewResult(),
      validation: validation(),
    });

    expect(parsed).toMatchObject({
      schema_version: 2,
      engine: "pi",
      reviewers: [
        {
          id: "pi-default",
          engine: "pi",
          transport: "native",
        },
      ],
    });
  });

  it("accepts app-server as a v2 artifact transport", () => {
    const parsed = reviewArtifactSchema.parse({
      schema_version: 2,
      engine: "codex",
      reviewers: [
        {
          id: "codex-app-server",
          engine: "codex",
          transport: "app-server",
          result: reviewResult(),
          validation: validation(),
        },
      ],
      cwd: "/repo",
      target: target(),
      result: reviewResult(),
      validation: validation(),
    });

    expect(parsed.reviewers?.[0]?.transport).toBe("app-server");
  });
});

function reviewResult() {
  return {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "No issues.",
    overall_confidence_score: 0.8,
  };
}

function validation() {
  return {
    parse_mode: "strict-json",
    valid_schema: true,
    findings_overlap_diff: true,
    valid_locations: true,
    invalid_locations: [],
  };
}

function target() {
  return {
    kind: "uncommitted",
    repo_root: "/repo",
    diff_command: "git diff",
    changed_files: [],
  };
}
