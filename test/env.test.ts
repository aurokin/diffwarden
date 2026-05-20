import { describe, expect, it } from "vitest";
import { resolveReviewEnvOptions } from "../src/core/env.js";

describe("resolveReviewEnvOptions", () => {
  it("parses reviewer and override environment defaults", () => {
    expect(
      resolveReviewEnvOptions({
        DIFFWARDEN_REVIEWERS: "cursor, claude, pi:openrouter-high",
        DIFFWARDEN_MODEL: "anthropic/claude-sonnet",
        DIFFWARDEN_EFFORT: "high",
      }),
    ).toEqual({
      reviewers: ["cursor", "claude", "pi:openrouter-high"],
      model: "anthropic/claude-sonnet",
      effort: "high",
    });
  });

  it("parses reviewer set environment defaults", () => {
    expect(resolveReviewEnvOptions({ DIFFWARDEN_REVIEWER_SET: " 2 " })).toEqual({
      reviewerSet: "2",
    });
  });

  it("ignores empty environment values", () => {
    expect(
      resolveReviewEnvOptions({
        DIFFWARDEN_REVIEWERS: " ",
        DIFFWARDEN_REVIEWER_SET: "",
        DIFFWARDEN_MODEL: " ",
        DIFFWARDEN_EFFORT: "",
      }),
    ).toEqual({});
  });

  it("rejects malformed reviewer lists", () => {
    expect(() => resolveReviewEnvOptions({ DIFFWARDEN_REVIEWERS: "pi,,claude" })).toThrow(
      "Invalid DIFFWARDEN_REVIEWERS value",
    );
  });
});
