import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../src/core/prompt.js";
import type { ReviewTargetResolved } from "../src/core/schema.js";

describe("buildReviewPrompt", () => {
  it("builds diff prompts for diff-backed targets", () => {
    const prompt = buildReviewPrompt(
      {
        kind: "uncommitted",
        repo_root: "/repo",
        diff_command: "git diff",
        changed_files: ["tracked.txt"],
      },
      "diff --git a/tracked.txt b/tracked.txt",
    );

    expect(prompt).toContain("Review guidelines:");
    expect(prompt).toContain("The original author would likely fix it if they knew about it.");
    expect(prompt).toContain("make the range overlap the diff");
    expect(prompt).toContain("[P0], [P1], [P2], or [P3]");
    expect(prompt).toContain(
      '"patch is correct" only when existing code and tests should continue',
    );
    expect(prompt).toContain(
      "The patch to review is included below. Use it as the source of truth.",
    );
    expect(prompt).toContain("Patch provenance command:");
    expect(prompt).toContain("Only report bugs introduced by this diff.");
    expect(prompt).toContain("Patch:");
    expect(prompt).toContain("diff --git a/tracked.txt b/tracked.txt");
  });

  it("builds custom prompts without diff-only instructions", () => {
    const target: ReviewTargetResolved = {
      kind: "custom",
      repo_root: "/repo",
      head_sha: "abc123",
      instructions: "Review the auth flow",
      diff_command: "custom instructions",
      changed_files: [],
    };

    const prompt = buildReviewPrompt(target, "");

    expect(prompt).toContain("Review this repository using the custom instructions below.");
    expect(prompt).toContain("custom:Review the auth flow");
    expect(prompt).toContain("Review the auth flow");
    expect(prompt).toContain("directly within the custom review scope");
    expect(prompt).toContain("keep locations inside the repository");
    expect(prompt).not.toContain("Only report bugs introduced by this diff.");
    expect(prompt).not.toContain("make the range overlap the diff");
    expect(prompt).not.toContain("Patch:");
  });
});
