import type { ReviewArtifact, ReviewArtifactFinding, ReviewEvent } from "./schema.js";

export type HumanReviewRenderOptions = {
  color?: boolean;
};

type FindingCounts = {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  unspecified: number;
};

export function renderHumanReviewEvent(
  event: ReviewEvent,
  options: HumanReviewRenderOptions = {},
): string | undefined {
  const style = createStyle(options);

  switch (event.type) {
    case "run_started":
      return [
        style.heading("diffwarden review"),
        `Target: ${formatTarget(event.target.kind, event.target)}`,
        `Reviewers: ${event.reviewers.map((reviewer) => reviewer.id).join(", ")}`,
        "",
      ].join("\n");
    case "preflight_started":
      return `${style.muted("•")} ${event.reviewer_id} preflight`;
    case "preflight_finished":
      return `${event.ok ? style.success("✓") : style.danger("✗")} ${
        event.reviewer_id
      } preflight ${event.ok ? "passed" : "failed"}${formatTiming(event.timing_ms)}`;
    case "reviewer_started":
      return `${style.accent("→")} ${event.reviewer_id} reviewing`;
    case "reviewer_result":
      return `${style.success("✓")} ${event.reviewer_id} finished${formatTiming(
        event.artifact.timing_ms,
      )}`;
    case "reviewer_failed":
      return `${style.danger("✗")} ${event.reviewer_id} failed${formatTiming(
        event.timing_ms,
      )}: ${event.error.message}`;
    case "error":
      return `${style.danger("Review failed")}: ${event.error.message}`;
    case "final_result":
      return undefined;
  }
}

export function renderHumanReviewSummary(
  artifact: ReviewArtifact,
  options: HumanReviewRenderOptions = {},
): string {
  const style = createStyle(options);
  const counts = findingCounts(artifact.result.findings);
  const failedReviewers =
    artifact.reviewers?.filter((reviewer) => reviewer.status === "failed") ?? [];
  const successfulReviewers =
    artifact.reviewers?.filter((reviewer) => reviewer.status !== "failed") ?? [];
  const findingTotal = artifact.result.findings.length;
  const lines = [
    "",
    style.heading("Result"),
    `Verdict: ${formatVerdict(artifact.result.overall_correctness, style)}`,
    `Confidence: ${formatConfidence(artifact.result.overall_confidence_score)}`,
    `Findings: ${formatFindingCount(findingTotal, counts, style)}`,
    `Reviewers: ${successfulReviewers.length} passed, ${failedReviewers.length} failed`,
  ];

  if (artifact.warnings !== undefined && artifact.warnings.length > 0) {
    lines.push("", style.warning("Warnings"));
    for (const warning of artifact.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (failedReviewers.length > 0) {
    lines.push("", style.danger("Failed reviewers"));
    for (const reviewer of failedReviewers) {
      lines.push(`- ${reviewer.id}: ${reviewer.error?.message ?? "Unknown error"}`);
    }
  }

  if (findingTotal === 0) {
    lines.push("", "No findings.");
  } else {
    lines.push("", style.warning("Findings"));
    for (const finding of [...artifact.result.findings].sort(compareFindings)) {
      lines.push(...renderFindingCard(finding, style));
    }
  }

  const explanation = artifact.result.overall_explanation.trim();
  if (explanation !== "") {
    lines.push("", style.muted("Overall explanation"), explanation);
  }

  return `${lines.join("\n")}\n`;
}

export function shouldUseHumanColor(options: {
  env?: NodeJS.ProcessEnv;
  stream?: Pick<NodeJS.WriteStream, "isTTY">;
}): boolean {
  const env = options.env ?? process.env;
  const stream = options.stream ?? process.stdout;
  return (
    stream.isTTY === true &&
    env.NO_COLOR === undefined &&
    env.CI === undefined &&
    env.TERM !== "dumb"
  );
}

function renderFindingCard(
  finding: ReviewArtifactFinding,
  style: ReturnType<typeof createStyle>,
): string[] {
  const location = finding.code_location;
  const reviewers =
    finding.reviewer_ids === undefined || finding.reviewer_ids.length === 0
      ? ""
      : ` · ${finding.reviewer_ids.join(", ")}`;
  return [
    `- ${style.priority(finding.priority)} ${finding.title}`,
    `  ${location.absolute_file_path}:${location.line_range.start}-${location.line_range.end}${reviewers}`,
    `  ${finding.body.replaceAll("\n", "\n  ")}`,
  ];
}

function formatFindingCount(
  total: number,
  counts: FindingCounts,
  style: ReturnType<typeof createStyle>,
): string {
  if (total === 0) {
    return style.success("0");
  }

  const parts = [
    counts.p0 > 0 ? `${style.danger("P0")} ${counts.p0}` : undefined,
    counts.p1 > 0 ? `${style.danger("P1")} ${counts.p1}` : undefined,
    counts.p2 > 0 ? `${style.warning("P2")} ${counts.p2}` : undefined,
    counts.p3 > 0 ? `${style.accent("P3")} ${counts.p3}` : undefined,
    counts.unspecified > 0 ? `Unspecified ${counts.unspecified}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return `${total} (${parts.join(", ")})`;
}

function findingCounts(findings: ReviewArtifactFinding[]): FindingCounts {
  const counts: FindingCounts = { p0: 0, p1: 0, p2: 0, p3: 0, unspecified: 0 };
  for (const finding of findings) {
    switch (finding.priority) {
      case 0:
        counts.p0 += 1;
        break;
      case 1:
        counts.p1 += 1;
        break;
      case 2:
        counts.p2 += 1;
        break;
      case 3:
        counts.p3 += 1;
        break;
      default:
        counts.unspecified += 1;
        break;
    }
  }
  return counts;
}

function formatVerdict(
  verdict: ReviewArtifact["result"]["overall_correctness"],
  style: ReturnType<typeof createStyle>,
): string {
  if (verdict === "patch is correct") {
    return style.success(verdict);
  }
  if (verdict === "patch is incorrect") {
    return style.danger(verdict);
  }
  return verdict;
}

function formatConfidence(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "0.00";
}

function formatTiming(timingMs: number | undefined): string {
  return timingMs === undefined ? "" : ` (${(timingMs / 1000).toFixed(1)}s)`;
}

function formatTarget(kind: string, target: ReviewArtifact["target"]): string {
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

function createStyle(options: HumanReviewRenderOptions) {
  const enabled = options.color === true;
  return {
    accent: (value: string) => color(value, 36, enabled),
    danger: (value: string) => color(value, 31, enabled),
    heading: (value: string) => color(value, 35, enabled),
    muted: (value: string) => color(value, 90, enabled),
    priority: (priority: 0 | 1 | 2 | 3 | undefined) => {
      if (priority === undefined) {
        return "P?";
      }
      if (priority <= 1) {
        return color(`P${priority}`, 31, enabled);
      }
      if (priority === 2) {
        return color("P2", 33, enabled);
      }
      return color("P3", 36, enabled);
    },
    success: (value: string) => color(value, 32, enabled),
    warning: (value: string) => color(value, 33, enabled),
  };
}

function color(value: string, code: number, enabled: boolean): string {
  return enabled ? `\u001B[${code}m${value}\u001B[0m` : value;
}
