import { describe, expect, it } from "vitest";
import { buildReviewPrompt, buildReviewPromptParts } from "../src/core/prompt.js";
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

  it("builds focused diff prompts without dropping patch constraints", () => {
    const prompt = buildReviewPrompt(
      {
        kind: "uncommitted",
        repo_root: "/repo",
        diff_command: "git diff",
        changed_files: ["tracked.txt"],
      },
      "diff --git a/tracked.txt b/tracked.txt",
      { focus: "focus on state management" },
    );

    expect(prompt).toContain("Focus instructions:");
    expect(prompt).toContain("focus on state management");
    expect(prompt).toContain("Only report bugs introduced by this diff.");
    expect(prompt).toContain("directly relevant to the focus instructions");
    expect(prompt).toContain("override read-only behavior");
    expect(prompt).toContain("Patch provenance command:");
    expect(prompt).toContain("```diff");
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

describe("buildReviewPromptParts", () => {
  const target: ReviewTargetResolved = {
    kind: "uncommitted",
    repo_root: "/repo",
    diff_command: "git diff",
    changed_files: ["tracked.txt"],
  };
  const diff = "diff --git a/tracked.txt b/tracked.txt";

  it("splits the stable contract from the per-run engagement", () => {
    const parts = buildReviewPromptParts(target, diff);

    expect(parts.system).toContain("Review guidelines:");
    expect(parts.system).toContain("Return only a JSON object that matches this ReviewResult");
    expect(parts.system).not.toContain("Patch provenance command:");
    expect(parts.system).not.toContain(diff);

    expect(parts.user).toContain("Review the code changes in this repository.");
    expect(parts.user).toContain("Patch provenance command:");
    expect(parts.user).toContain("Only report bugs introduced by this diff.");
    expect(parts.user).toContain("```diff");
    expect(parts.user).toContain(diff);
    expect(parts.user).not.toContain("Review guidelines:");
    expect(parts.user).not.toContain("Return only a JSON object");
  });

  it("keeps the system contract byte-stable across runs with different patches", () => {
    const first = buildReviewPromptParts(target, diff, { tools: ["Read", "Grep", "Glob"] });
    const second = buildReviewPromptParts(
      { ...target, repo_root: "/other", diff_command: "git diff HEAD~1" },
      "diff --git a/other.ts b/other.ts",
      { tools: ["Read", "Grep", "Glob"] },
    );

    expect(first.system).toBe(second.system);
    expect(first.user).not.toBe(second.user);
  });

  it("describes read-only tools in the contract when provided", () => {
    const parts = buildReviewPromptParts(target, diff, { tools: ["Read", "Grep", "Glob"] });

    expect(parts.system).toContain("Available tools:");
    expect(parts.system).toContain(
      "You have read-only tools for this review: Read, Grep, and Glob.",
    );
    expect(parts.system).toContain("You cannot run commands, edit files, or access the network.");
    expect(parts.user).not.toContain("Available tools:");

    expect(buildReviewPromptParts(target, diff).system).not.toContain("Available tools:");
  });

  it("keeps focus instructions in the per-run engagement, never the contract", () => {
    const parts = buildReviewPromptParts(target, diff, {
      focus: "focus on state management",
      tools: ["Read"],
    });

    expect(parts.user).toContain("Focus instructions:");
    expect(parts.user).toContain("focus on state management");
    expect(parts.system).not.toContain("focus on state management");
    expect(parts.system).toContain("You have read-only tools for this review: Read.");
  });

  it("splits custom-instruction targets the same way", () => {
    const customTarget: ReviewTargetResolved = {
      kind: "custom",
      repo_root: "/repo",
      head_sha: "abc123",
      instructions: "Review the auth flow",
      diff_command: "custom instructions",
      changed_files: [],
    };

    const parts = buildReviewPromptParts(customTarget, "", { tools: ["Read", "Grep", "Glob"] });

    expect(parts.system).toContain("Review guidelines:");
    expect(parts.system).toContain("Available tools:");
    expect(parts.system).not.toContain("beyond the supplied patch");
    expect(parts.system).toContain("Return only a JSON object");
    expect(parts.user).toContain("Review this repository using the custom instructions below.");
    expect(parts.user).toContain("Review the auth flow");
    expect(parts.user).not.toContain("Review guidelines:");
  });

  it("concatenates to the same content as the single-prompt form", () => {
    const single = buildReviewPrompt(target, diff, { focus: "focus on state management" });
    const parts = buildReviewPromptParts(target, diff, { focus: "focus on state management" });

    // The split reorders the result instructions into the contract; every
    // piece of the single prompt must still exist in exactly one part.
    for (const piece of single.split("\n\n")) {
      expect(parts.system.includes(piece) || parts.user.includes(piece)).toBe(true);
    }
  });
});
