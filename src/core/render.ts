import type { ReviewArtifact, ReviewArtifactResult, ReviewFinding } from "./schema.js";

export function renderMarkdown(artifact: ReviewArtifact): string {
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
  if (artifact.sdk !== undefined) {
    return artifact.sdk;
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
  return kind;
}

function renderFindings(result: ReviewArtifactResult): string {
  if (result.findings.length === 0) {
    return "No findings.";
  }

  const findings = [...result.findings].sort(compareFindings).map(renderFinding).join("\n\n");
  return `## Findings\n\n${findings}`;
}

function renderFinding(finding: ReviewFinding): string {
  const location = finding.code_location;
  const range = location.line_range;

  return [
    `### ${finding.title}`,
    "",
    `\`${location.absolute_file_path}:${range.start}-${range.end}\``,
    "",
    finding.body,
  ].join("\n");
}

function formatConfidence(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "0.00";
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  return (
    prioritySortValue(left) - prioritySortValue(right) ||
    left.code_location.absolute_file_path.localeCompare(right.code_location.absolute_file_path) ||
    left.code_location.line_range.start - right.code_location.line_range.start ||
    left.code_location.line_range.end - right.code_location.line_range.end ||
    left.title.localeCompare(right.title)
  );
}

function prioritySortValue(finding: ReviewFinding): number {
  return finding.priority ?? 4;
}
