import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ReviewArtifactResult,
  ReviewTargetResolved,
  ReviewValidation,
} from "../src/core/schema.js";
import { validateReviewResult } from "../src/core/validate.js";

const target: ReviewTargetResolved = {
  kind: "uncommitted",
  repo_root: "/repo",
  diff_command: "git diff",
  changed_files: ["src/client.ts"],
};

const validation: ReviewValidation = {
  parse_mode: "tool-output",
  valid_schema: true,
  findings_overlap_diff: false,
  valid_locations: false,
  invalid_locations: [],
};

describe("validateReviewResult", () => {
  it("accepts relative finding paths that match changed files", () => {
    const result = reviewResult("src/client.ts");

    const nextValidation = validateReviewResult({ result, target, validation });

    expect(nextValidation.valid_locations).toBe(true);
    expect(nextValidation.invalid_locations).toEqual([]);
  });

  it("accepts absolute finding paths under the repo root", () => {
    const result = reviewResult("/repo/src/client.ts");

    const nextValidation = validateReviewResult({ result, target, validation });

    expect(nextValidation.valid_locations).toBe(true);
    expect(nextValidation.invalid_locations).toEqual([]);
  });

  it("reports finding paths outside changed files", () => {
    const result = reviewResult("/repo/src/other.ts");

    const nextValidation = validateReviewResult({ result, target, validation });

    expect(nextValidation.valid_locations).toBe(false);
    expect(nextValidation.invalid_locations).toEqual([
      {
        index: 0,
        reason: "Finding path is not in changed files: /repo/src/other.ts",
      },
    ]);
  });

  it("accepts findings that overlap changed lines", () => {
    const result = reviewResult("/repo/src/client.ts", 12);

    const nextValidation = validateReviewResult({
      result,
      target,
      validation,
      changedLineRanges: {
        "src/client.ts": [{ start: 10, end: 12 }],
      },
    });

    expect(nextValidation.valid_locations).toBe(true);
    expect(nextValidation.findings_overlap_diff).toBe(true);
    expect(nextValidation.invalid_locations).toEqual([]);
  });

  it("reports findings that do not overlap changed lines", () => {
    const result = reviewResult("/repo/src/client.ts", 20);

    const nextValidation = validateReviewResult({
      result,
      target,
      validation,
      changedLineRanges: {
        "src/client.ts": [{ start: 10, end: 12 }],
      },
    });

    expect(nextValidation.valid_locations).toBe(false);
    expect(nextValidation.findings_overlap_diff).toBe(false);
    expect(nextValidation.invalid_locations).toEqual([
      {
        index: 0,
        reason: "Finding line range does not overlap changed lines: /repo/src/client.ts",
      },
    ]);
  });

  it("does not require diff overlap for custom targets", () => {
    const repo = createCustomRepo();
    const result = reviewResult("src/other.ts", 20);

    try {
      const nextValidation = validateReviewResult({
        result,
        target: customTarget(repo),
        validation,
        changedLineRanges: {},
      });

      expect(nextValidation.valid_locations).toBe(true);
      expect(nextValidation.findings_overlap_diff).toBe(true);
      expect(nextValidation.invalid_locations).toEqual([]);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("accepts absolute custom finding paths inside the repo", () => {
    const repo = createCustomRepo();
    const result = reviewResult(path.join(repo, "src/other.ts"), 20);

    try {
      const nextValidation = validateReviewResult({
        result,
        target: customTarget(repo),
        validation,
      });

      expect(nextValidation.valid_locations).toBe(true);
      expect(nextValidation.findings_overlap_diff).toBe(true);
      expect(nextValidation.invalid_locations).toEqual([]);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("reports custom finding paths outside the repo", () => {
    const repo = createCustomRepo();
    const outsideFile = path.join(tmpdir(), "outside.ts");
    writeFileSync(outsideFile, "outside\n");
    const result = reviewResult(outsideFile, 1);

    try {
      const nextValidation = validateReviewResult({
        result,
        target: customTarget(repo),
        validation,
      });

      expect(nextValidation.valid_locations).toBe(false);
      expect(nextValidation.findings_overlap_diff).toBe(true);
      expect(nextValidation.invalid_locations).toEqual([
        {
          index: 0,
          reason: `Finding path is outside the repository: ${outsideFile}`,
        },
      ]);
    } finally {
      rmSync(repo, { force: true, recursive: true });
      rmSync(outsideFile, { force: true });
    }
  });

  it("reports custom finding paths that do not exist", () => {
    const repo = createCustomRepo();
    const result = reviewResult("src/missing.ts", 1);

    try {
      const nextValidation = validateReviewResult({
        result,
        target: customTarget(repo),
        validation,
      });

      expect(nextValidation.valid_locations).toBe(false);
      expect(nextValidation.findings_overlap_diff).toBe(true);
      expect(nextValidation.invalid_locations).toEqual([
        {
          index: 0,
          reason: "Finding path does not exist: src/missing.ts",
        },
      ]);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });
});

function createCustomRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-validate-"));
  const src = path.join(repo, "src");
  mkdirSync(src);
  writeFileSync(path.join(repo, "README.md"), "repo\n");
  writeFileSync(path.join(repo, "tracked.ts"), "tracked\n");
  writeFileSync(path.join(src, "other.ts"), "other\n");
  return repo;
}

function customTarget(repoRoot: string): ReviewTargetResolved {
  return {
    kind: "custom",
    repo_root: repoRoot,
    head_sha: "abc123",
    instructions: "Review auth paths",
    diff_command: "custom instructions",
    changed_files: [],
  };
}

function reviewResult(filePath: string, line = 1): ReviewArtifactResult {
  return {
    findings: [
      {
        title: "[P2] Example issue",
        body: "Example body.",
        confidence_score: 0.8,
        priority: 2,
        code_location: {
          absolute_file_path: filePath,
          line_range: {
            start: line,
            end: line,
          },
        },
      },
    ],
    overall_correctness: "patch is incorrect",
    overall_explanation: "Example explanation.",
    overall_confidence_score: 0.8,
  };
}
