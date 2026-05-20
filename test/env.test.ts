import { describe, expect, it } from "vitest";
import { resolveReviewEnvOptions, resolveReviewEnvOptionsWithSettings } from "../src/core/env.js";

describe("resolveReviewEnvOptions", () => {
  it("parses reviewer and override environment defaults", () => {
    expect(
      resolveReviewEnvOptions({
        DIFFWARDEN_REVIEWERS: "cursor, claude, pi:openrouter-high",
        DIFFWARDEN_MODEL: "anthropic/claude-sonnet",
        DIFFWARDEN_EFFORT: "high",
        DIFFWARDEN_TIMEOUT_SECONDS: "30",
      }),
    ).toEqual({
      reviewers: ["cursor", "claude", "pi:openrouter-high"],
      model: "anthropic/claude-sonnet",
      effort: "high",
      timeoutSeconds: 30,
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

  it("rejects invalid timeout values", () => {
    expect(() => resolveReviewEnvOptions({ DIFFWARDEN_TIMEOUT_SECONDS: "0" })).toThrow(
      "Invalid DIFFWARDEN_TIMEOUT_SECONDS value: 0",
    );
  });

  it("can skip env timeout parsing when an explicit CLI timeout wins", () => {
    expect(
      resolveReviewEnvOptionsWithSettings(
        {
          DIFFWARDEN_TIMEOUT_SECONDS: "not-a-number",
          DIFFWARDEN_MODEL: "sonnet",
        },
        { includeTimeout: false },
      ),
    ).toEqual({
      model: "sonnet",
    });
  });
});
