import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/core/render.js";
import type { ReviewArtifact, ReviewArtifactFinding } from "../src/core/schema.js";

const artifact: ReviewArtifact = {
  schema_version: 1,
  sdk: "fake",
  cwd: "/repo",
  target: {
    kind: "uncommitted",
    repo_root: "/repo",
    diff_command: "git diff",
    changed_files: ["src/client.ts"],
  },
  result: {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "The reviewed patch does not appear to introduce correctness issues.",
    overall_confidence_score: 0.76,
  },
  validation: {
    parse_mode: "tool-output",
    valid_schema: true,
    findings_overlap_diff: false,
    valid_locations: false,
    invalid_locations: [],
  },
};

describe("renderMarkdown", () => {
  it("renders a no-findings review", () => {
    const markdown = renderMarkdown(artifact);

    expect(markdown).toContain("# Code Review");
    expect(markdown).toContain("Engine: fake");
    expect(markdown).toContain("Target: uncommitted");
    expect(markdown).toContain("No findings.");
    expect(markdown).toContain("Confidence: 0.76");
  });

  it("renders unknown verdicts for fallback artifacts", () => {
    const markdown = renderMarkdown({
      ...artifact,
      result: {
        findings: [],
        overall_correctness: "unknown",
        overall_explanation: "Reviewer returned plain text.",
        overall_confidence_score: 0,
      },
    });

    expect(markdown).toContain("Verdict: unknown");
  });

  it("renders multi-reviewer engine labels", () => {
    const markdown = renderMarkdown({
      ...artifact,
      sdk: undefined,
      reviewers: [
        {
          id: "pi",
          sdk: "pi",
          result: artifact.result,
          validation: artifact.validation,
        },
        {
          id: "claude-deep",
          sdk: "claude",
          result: artifact.result,
          validation: artifact.validation,
        },
      ],
    });

    expect(markdown).toContain("Engine: pi, claude-deep");
  });

  it("renders warnings for partial multi-reviewer results", () => {
    const markdown = renderMarkdown({
      ...artifact,
      warnings: ["Reviewer claude failed: missing auth"],
    });

    expect(markdown).toContain("## Warnings");
    expect(markdown).toContain("- Reviewer claude failed: missing auth");
  });

  it("renders finding reviewer attribution", () => {
    const attributedFinding = finding("[P2] Attributed issue", 2, "/repo/src/client.ts", 4);
    attributedFinding.reviewer_ids = ["pi", "claude"];

    const markdown = renderMarkdown({
      ...artifact,
      result: {
        ...artifact.result,
        findings: [attributedFinding],
      },
    });

    expect(markdown).toContain("Reported by: pi, claude");
  });

  it("renders verbose reviewer details", () => {
    const markdown = renderMarkdown(
      {
        ...artifact,
        sdk: undefined,
        reviewers: [
          {
            id: "pi",
            sdk: "pi",
            status: "success",
            result: artifact.result,
            validation: artifact.validation,
          },
          {
            id: "claude",
            sdk: "claude",
            status: "failed",
            error: {
              code: "missing_auth",
              message: "missing auth",
              exit_code: 3,
            },
          },
        ],
      },
      { verbose: true },
    );

    expect(markdown).toContain("## Reviewer details");
    expect(markdown).toContain("### pi");
    expect(markdown).toContain("Parse mode: tool-output");
    expect(markdown).toContain("### claude");
    expect(markdown).toContain("Status: failed");
    expect(markdown).toContain("Error: missing auth");
  });

  it("sorts findings by priority and location", () => {
    const p1Finding = finding("[P1] Earlier serious issue", 1, "/repo/src/a.ts", 8);
    const p2EarlierFinding = finding("[P2] Earlier normal issue", 2, "/repo/src/a.ts", 3);
    const p2LaterFinding = finding("[P2] Later normal issue", 2, "/repo/src/b.ts", 2);
    const unknownPriorityFinding = finding("Unprioritized issue", undefined, "/repo/src/a.ts", 1);
    const markdown = renderMarkdown({
      ...artifact,
      result: {
        ...artifact.result,
        findings: [unknownPriorityFinding, p2LaterFinding, p2EarlierFinding, p1Finding],
      },
    });

    expect(markdown.indexOf(p1Finding.title)).toBeLessThan(
      markdown.indexOf(p2EarlierFinding.title),
    );
    expect(markdown.indexOf(p2EarlierFinding.title)).toBeLessThan(
      markdown.indexOf(p2LaterFinding.title),
    );
    expect(markdown.indexOf(p2LaterFinding.title)).toBeLessThan(
      markdown.indexOf(unknownPriorityFinding.title),
    );
  });
});

function finding(
  title: string,
  priority: ReviewArtifactFinding["priority"] | undefined,
  absoluteFilePath: string,
  line: number,
): ReviewArtifactFinding {
  const reviewFinding: ReviewArtifactFinding = {
    title,
    body: "Finding body.",
    confidence_score: 0.8,
    code_location: {
      absolute_file_path: absoluteFilePath,
      line_range: {
        start: line,
        end: line,
      },
    },
  };

  if (priority !== undefined) {
    reviewFinding.priority = priority;
  }

  return reviewFinding;
}
