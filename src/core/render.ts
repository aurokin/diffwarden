import type { ReviewArtifact, ReviewArtifactFinding, ReviewArtifactResult } from "./schema.js";

export type RenderMarkdownOptions = {
  verbose?: boolean;
};

export function renderMarkdown(
  artifact: ReviewArtifact,
  options: RenderMarkdownOptions = {},
): string {
  const sections = [
    "# Code Review",
    "",
    `Engine: ${renderEngine(artifact)}`,
    `Target: ${renderTarget(artifact.target.kind, artifact.target)}`,
    `Verdict: ${artifact.result.overall_correctness || "unknown"}`,
    `Confidence: ${formatConfidence(artifact.result.overall_confidence_score)}`,
    "",
    renderWarnings(artifact),
    "",
    renderFindings(artifact.result),
    "",
    "## Overall explanation",
    "",
    artifact.result.overall_explanation.trim() || "Reviewer did not provide an explanation.",
    "",
    options.verbose === true ? renderReviewerDetails(artifact) : "",
  ];

  return `${sections.join("\n").trimEnd()}\n`;
}

function renderWarnings(artifact: ReviewArtifact): string {
  if (artifact.warnings === undefined || artifact.warnings.length === 0) {
    return "";
  }

  return `## Warnings\n\n${artifact.warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function renderEngine(artifact: ReviewArtifact): string {
  if (artifact.engine !== undefined) {
    return artifact.engine;
  }

  if (artifact.reviewers !== undefined && artifact.reviewers.length > 1) {
    return artifact.reviewers.map((reviewer) => reviewer.id).join(", ");
  }

  return "unknown";
}

export function renderJson(artifact: ReviewArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function renderTarget(kind: string, target: ReviewArtifact["target"]): string {
  if (kind === "base" && target.base_ref) {
    return `base:${target.base_ref}`;
  }
  if (kind === "commit" && target.commit_sha) {
    return `commit:${target.commit_sha}`;
  }
  if (kind === "custom" && target.instructions) {
    return `custom:${target.instructions}`;
  }
  return kind;
}

function renderFindings(result: ReviewArtifactResult): string {
  if (result.findings.length === 0) {
    return "No findings.";
  }

  const findings = renderFindingList(result.findings, "###");
  return `## Findings\n\n${findings}`;
}

function renderReviewerDetails(artifact: ReviewArtifact): string {
  if (artifact.reviewers === undefined || artifact.reviewers.length === 0) {
    return "";
  }

  const reviewers = artifact.reviewers.map((reviewer) => {
    if (reviewer.status === "failed") {
      return [
        `### ${reviewer.id}`,
        "",
        "Status: failed",
        "",
        `Error: ${reviewer.error?.message ?? "Unknown error"}`,
      ].join("\n");
    }

    if (reviewer.result === undefined || reviewer.validation === undefined) {
      return [`### ${reviewer.id}`, "", "Status: unknown"].join("\n");
    }

    return [
      `### ${reviewer.id}`,
      "",
      "Status: success",
      `Verdict: ${reviewer.result.overall_correctness}`,
      `Confidence: ${formatConfidence(reviewer.result.overall_confidence_score)}`,
      `Parse mode: ${reviewer.validation.parse_mode}`,
      "",
      reviewer.result.findings.length === 0
        ? "No findings."
        : renderFindingList(reviewer.result.findings, "####"),
    ].join("\n");
  });

  return `## Reviewer details\n\n${reviewers.join("\n\n")}`;
}

function renderFindingList(findings: ReviewArtifactFinding[], heading: "###" | "####"): string {
  return [...findings]
    .sort(compareFindings)
    .map((finding) => renderFinding(finding, heading))
    .join("\n\n");
}

function renderFinding(finding: ReviewArtifactFinding, heading: "###" | "####"): string {
  const location = finding.code_location;
  const range = location.line_range;
  const attribution = renderAttribution(finding);

  return [
    `${heading} ${finding.title}`,
    "",
    `\`${location.absolute_file_path}:${range.start}-${range.end}\``,
    ...(attribution === undefined ? [] : ["", attribution]),
    "",
    finding.body,
  ].join("\n");
}

function renderAttribution(finding: ReviewArtifactFinding): string | undefined {
  if (finding.reviewer_ids === undefined || finding.reviewer_ids.length === 0) {
    return undefined;
  }

  return `Reported by: ${finding.reviewer_ids.join(", ")}`;
}

function formatConfidence(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "0.00";
}

function compareFindings(left: ReviewArtifactFinding, right: ReviewArtifactFinding): number {
  return (
    prioritySortValue(left) - prioritySortValue(right) ||
    left.code_location.absolute_file_path.localeCompare(right.code_location.absolute_file_path) ||
    left.code_location.line_range.start - right.code_location.line_range.start ||
    left.code_location.line_range.end - right.code_location.line_range.end ||
    left.title.localeCompare(right.title)
  );
}

function prioritySortValue(finding: ReviewArtifactFinding): number {
  return finding.priority ?? 4;
}
