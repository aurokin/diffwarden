import { describe, expect, it } from "vitest";
import { resolveReviewerSelectionWithEnv } from "../src/core/env.js";

describe("resolveReviewerSelectionWithEnv", () => {
  it("lets explicit reviewers suppress env reviewer sets", () => {
    expect(
      resolveReviewerSelectionWithEnv({
        reviewers: ["pi"],
        reviewerSet: undefined,
        envOptions: { reviewerSet: "2" },
      }),
    ).toEqual({ reviewers: ["pi"] });
  });

  it("lets explicit reviewer sets suppress env reviewers", () => {
    expect(
      resolveReviewerSelectionWithEnv({
        reviewers: [],
        reviewerSet: "2",
        envOptions: { reviewers: ["pi"] },
      }),
    ).toEqual({ reviewerSet: "2" });
  });

  it("uses env reviewer defaults when no CLI reviewer selector is present", () => {
    expect(
      resolveReviewerSelectionWithEnv({
        reviewers: [],
        reviewerSet: undefined,
        envOptions: { reviewers: ["pi", "claude"] },
      }),
    ).toEqual({ reviewers: ["pi", "claude"] });
  });
});
