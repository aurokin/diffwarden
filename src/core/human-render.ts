import path from "node:path";
import type {
  ReviewArtifact,
  ReviewArtifactFinding,
  ReviewBatchArtifact,
  ReviewEvent,
  ReviewRunArtifact,
  ReviewTargetResolved,
} from "./schema.js";
import { asciiGlyphs, unicodeGlyphs, visibleLength, wrapText } from "./terminal-caps.js";

export type HumanReviewRenderOptions = {
  color?: boolean;
  /** Unicode glyph opt-up (terminal-caps allowlist). ASCII is the default. */
  unicode?: boolean;
  /** Wrap/rule width, pre-clamped by the caller. */
  width?: number;
};

const defaultSummaryWidth = 80;

type FindingCounts = {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  unspecified: number;
};

type RenderFinding = ReviewArtifactFinding & { lane_ids?: string[] };

export function renderHumanReviewEvent(
  event: ReviewEvent,
  options: HumanReviewRenderOptions = {},
): string | undefined {
  const style = createStyle(options);

  switch (event.type) {
    case "batch_started":
      return [
        style.heading("diffwarden review batch"),
        `Target: ${formatTarget(event.target.kind, event.target)}`,
        `Reviewers: ${event.reviewers.map((reviewer) => reviewer.id).join(", ")}`,
        `Lanes: ${event.plan.lanes.map(formatLanePlanLabel).join(", ")}`,
        "",
      ].join("\n");
    case "run_started":
      return [
        style.heading(`${formatLanePrefix(event.lane_id)}diffwarden review`),
        `Target: ${formatTarget(event.target.kind, event.target)}`,
        `Reviewers: ${event.reviewers.map((reviewer) => reviewer.id).join(", ")}`,
        "",
      ].join("\n");
    case "preflight_started":
      return `${style.muted("•")} ${formatLanePrefix(event.lane_id)}${event.reviewer_id} preflight`;
    case "preflight_finished":
      return `${event.ok ? style.success("✓") : style.danger("✗")} ${formatLanePrefix(
        event.lane_id,
      )}${
        event.reviewer_id
      } preflight ${event.ok ? "passed" : "failed"}${formatTiming(event.timing_ms)}`;
    case "reviewer_started":
      return `${style.accent("→")} ${formatLanePrefix(event.lane_id)}${
        event.reviewer_id
      } reviewing`;
    case "reviewer_result":
      return `${style.success("✓")} ${formatLanePrefix(event.lane_id)}${
        event.reviewer_id
      } finished${formatTiming(event.artifact.timing_ms)}`;
    case "reviewer_failed":
      return `${style.danger("✗")} ${formatLanePrefix(event.lane_id)}${
        event.reviewer_id
      } failed${formatTiming(event.timing_ms)}: ${event.error.message}`;
    case "lane_finished":
      return `${style.success("✓")} Lane ${event.lane_id} finished${formatTiming(event.timing_ms)}`;
    case "lane_failed":
      return `${style.danger("✗")} Lane ${event.lane_id} failed${formatTiming(
        event.timing_ms,
      )}: ${event.error.message}`;
    case "error":
      return `${style.danger("Review failed")}: ${event.error.message}`;
    case "reviewer_debug_output":
      // Debug chunks are an ndjson-only surface; human mode stays quiet.
      return undefined;
    case "final_result":
      return undefined;
  }
}

export function renderHumanReviewSummary(
  artifact: ReviewRunArtifact,
  options: HumanReviewRenderOptions = {},
): string {
  if (isBatchArtifact(artifact)) {
    return renderHumanBatchReviewSummary(artifact, options);
  }

  const style = createStyle(options);
  const glyphs = options.unicode === true ? unicodeGlyphs : asciiGlyphs;
  const width = options.width ?? defaultSummaryWidth;
  const failedReviewers =
    artifact.reviewers?.filter((reviewer) => reviewer.status === "failed") ?? [];
  const findingTotal = artifact.result.findings.length;

  const lines = ["", ...renderVerdictBanner(artifact, style, glyphs, width)];

  if (artifact.warnings !== undefined && artifact.warnings.length > 0) {
    lines.push("", style.warning("Warnings"));
    for (const warning of artifact.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (failedReviewers.length > 0) {
    lines.push("");
    for (const reviewer of failedReviewers) {
      lines.push(
        `${style.danger(`${glyphs.fail} ${reviewer.id} failed`)}   ${style.muted(
          reviewer.error?.message ?? "Unknown error",
        )}`,
      );
    }
  }

  if (findingTotal > 0) {
    for (const finding of [...artifact.result.findings].sort(compareFindings)) {
      lines.push("", ...renderFindingCard(finding, style, glyphs, width, artifact.cwd));
    }
  }

  const explanation = artifact.result.overall_explanation.trim();
  if (explanation !== "") {
    lines.push("", style.muted("overall explanation"), ...wrapText(explanation, width, ""));
  }

  const footer = renderSummaryFooter(artifact, glyphs);
  if (footer !== undefined) {
    lines.push("", style.muted(footer));
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The verdict banner: a rule-pair whose color IS the verdict, a verdict word in caps, and —
 * when several reviewers ran — the consensus clause ("2 of 3 reviewers flagged"), which no
 * single-reviewer tool can print. Per-reviewer confidence lives on the reviewer rows / cards;
 * the banner never shows an aggregated confidence float.
 */
function renderVerdictBanner(
  artifact: ReviewRunArtifact,
  style: HumanStyle,
  glyphs: typeof asciiGlyphs,
  width: number,
): string[] {
  const verdict = artifact.result.overall_correctness;
  const [word, paint, glyph] =
    verdict === "patch is correct"
      ? (["CORRECT", style.success, glyphs.pass] as const)
      : verdict === "patch is incorrect"
        ? (["CHANGES REQUESTED", style.danger, glyphs.fail] as const)
        : (["UNCERTAIN", style.warning, glyphs.uncertain] as const);
  const rule = paint(glyphs.rule.repeat(width));

  const clauses = [`${paint(glyph)} ${style.bold(paint(word))}`];
  const consensus = consensusClause(artifact);
  if (consensus !== undefined) {
    clauses.push(style.bold(consensus));
  }
  const meta = style.muted(bannerMeta(artifact, glyphs));
  // The rules clamp to `width`, so the clause line must too — at narrow widths a single
  // joined line would terminal-wrap mid-word underneath an intact rule. Drop the meta (and
  // then the consensus) to their own lines instead of letting the terminal pick the break.
  const joined = [...clauses, meta].join("   ");
  if (visibleLength(joined) <= width) {
    return [rule, joined, rule];
  }
  const head = clauses.join("   ");
  if (visibleLength(head) <= width) {
    return [rule, head, meta, rule];
  }
  return [rule, ...clauses, meta, rule];
}

function consensusClause(artifact: ReviewRunArtifact): string | undefined {
  if (isBatchArtifact(artifact)) {
    const total = artifact.lanes.length;
    if (total < 2) {
      return undefined;
    }
    // A lane that failed to run did not flag anything — it is reported as failed, exactly
    // like reviewer failures in the single-run path.
    const succeeded = artifact.lanes.filter((lane) => lane.status === "success");
    const flagged = succeeded.filter(
      (lane) => lane.artifact.result.overall_correctness === "patch is incorrect",
    ).length;
    const unsure = succeeded.filter(
      (lane) =>
        lane.artifact.result.overall_correctness !== "patch is incorrect" &&
        lane.artifact.result.overall_correctness !== "patch is correct",
    ).length;
    const failed = total - succeeded.length;
    if (flagged > 0) {
      return `${flagged} of ${total} lanes flagged`;
    }
    // "agree" is reserved for unanimous correct verdicts — an unsure lane is not agreement.
    if (unsure > 0) {
      return `${unsure} of ${total} lanes unsure`;
    }
    return failed > 0
      ? `${total - failed} of ${total} lanes agree, ${failed} failed`
      : `${total} of ${total} lanes agree`;
  }
  // The denominator counts every reviewer that RAN, failures included — "2 of 2 agree" with
  // a third reviewer down would be a false consensus. Failures also surface as their own
  // lines below the banner.
  const reviewers = artifact.reviewers ?? [];
  const total = reviewers.length;
  if (total < 2) {
    return undefined;
  }
  const settled = reviewers.filter(
    (reviewer) => reviewer.status !== "failed" && reviewer.result !== undefined,
  );
  const flagged = settled.filter(
    (reviewer) => reviewer.result?.overall_correctness === "patch is incorrect",
  ).length;
  const unsure = settled.filter(
    (reviewer) =>
      reviewer.result?.overall_correctness !== "patch is incorrect" &&
      reviewer.result?.overall_correctness !== "patch is correct",
  ).length;
  const failed = total - settled.length;
  if (flagged > 0) {
    return `${flagged} of ${total} reviewers flagged`;
  }
  // "agree" is reserved for unanimous correct verdicts — an unsure reviewer is not agreement.
  if (unsure > 0) {
    return `${unsure} of ${total} reviewers unsure`;
  }
  return failed > 0
    ? `${settled.length} of ${total} reviewers agree, ${failed} failed`
    : `${total} of ${total} reviewers agree`;
}

function bannerMeta(artifact: ReviewRunArtifact, glyphs: typeof asciiGlyphs): string {
  const counts = findingCounts(artifact.result.findings);
  const total = artifact.result.findings.length;
  const parts =
    total === 0
      ? ["0 findings"]
      : [
          counts.p0 > 0 ? `${counts.p0} P0` : undefined,
          counts.p1 > 0 ? `${counts.p1} P1` : undefined,
          counts.p2 > 0 ? `${counts.p2} P2` : undefined,
          counts.p3 > 0 ? `${counts.p3} P3` : undefined,
          counts.unspecified > 0 ? `${counts.unspecified} unprioritized` : undefined,
        ].filter((part): part is string => part !== undefined);
  if (artifact.timing_ms !== undefined) {
    parts.push(`${(artifact.timing_ms / 1000).toFixed(0)}s`);
  }
  return parts.join(` ${glyphs.dot} `);
}

function renderSummaryFooter(
  artifact: ReviewRunArtifact,
  glyphs: typeof asciiGlyphs,
): string | undefined {
  const parts: string[] = [];
  if (artifact.timing_ms !== undefined) {
    parts.push(`review finished in ${(artifact.timing_ms / 1000).toFixed(1)}s`);
  }
  if (!isBatchArtifact(artifact)) {
    const timed = (artifact.reviewers ?? []).filter(
      (reviewer): reviewer is typeof reviewer & { timing_ms: number } =>
        reviewer.timing_ms !== undefined,
    );
    if (timed.length > 1) {
      const slowest = timed.reduce((left, right) =>
        right.timing_ms > left.timing_ms ? right : left,
      );
      parts.push(`slowest ${slowest.id} ${(slowest.timing_ms / 1000).toFixed(1)}s`);
    }
  }
  return parts.length > 0 ? parts.join(` ${glyphs.dot} `) : undefined;
}

export function renderHumanReviewArtifact(
  artifact: ReviewRunArtifact,
  options: HumanReviewRenderOptions = {},
): string {
  if (isBatchArtifact(artifact)) {
    return renderHumanBatchReviewArtifact(artifact, options);
  }

  const style = createStyle(options);
  const lines = [
    style.heading("diffwarden review"),
    `Target: ${formatTarget(artifact.target.kind, artifact.target)}`,
    `Reviewers: ${formatReviewers(artifact)}`,
  ];

  return `${lines.join("\n")}\n${renderHumanReviewSummary(artifact, options)}`;
}

export function renderAgentReviewSummary(artifact: ReviewRunArtifact): string {
  if (isBatchArtifact(artifact)) {
    return renderAgentBatchReviewSummary(artifact);
  }

  const counts = findingCounts(artifact.result.findings);
  const failedReviewers =
    artifact.reviewers?.filter((reviewer) => reviewer.status === "failed") ?? [];
  const successfulReviewers =
    artifact.reviewers?.filter((reviewer) => reviewer.status !== "failed") ?? [];
  const findingTotal = artifact.result.findings.length;
  const lines = [
    "Diffwarden Review",
    `Target: ${formatTarget(artifact.target.kind, artifact.target)}`,
    `Verdict: ${artifact.result.overall_correctness}`,
    `Confidence: ${formatConfidence(artifact.result.overall_confidence_score)}`,
    `Findings: ${formatAgentFindingCount(findingTotal, counts)}`,
    `Reviewers: ${formatReviewers(artifact)}`,
    `Reviewer status: ${successfulReviewers.length} passed, ${failedReviewers.length} failed`,
  ];

  if (artifact.warnings !== undefined && artifact.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of artifact.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (failedReviewers.length > 0) {
    lines.push("", "Failed reviewers:");
    for (const reviewer of failedReviewers) {
      lines.push(`- ${reviewer.id}: ${reviewer.error?.message ?? "Unknown error"}`);
    }
  }

  if (findingTotal === 0) {
    lines.push("", "No findings.");
  } else {
    lines.push("", "Findings:");
    for (const [index, finding] of [...artifact.result.findings].sort(compareFindings).entries()) {
      lines.push(...renderAgentFinding(index + 1, finding));
    }
  }

  const explanation = artifact.result.overall_explanation.trim();
  if (explanation !== "") {
    lines.push("", "Overall explanation:", explanation);
  }

  return `${lines.join("\n")}\n`;
}

function renderHumanBatchReviewArtifact(
  artifact: ReviewBatchArtifact,
  options: HumanReviewRenderOptions,
): string {
  const style = createStyle(options);
  const lines = [
    style.heading("diffwarden review batch"),
    `Target: ${formatTarget(artifact.target.kind, artifact.target)}`,
    `Lanes: ${artifact.plan.lanes.map(formatLanePlanLabel).join(", ")}`,
  ];

  return `${lines.join("\n")}\n${renderHumanBatchReviewSummary(artifact, options)}`;
}

type BatchReviewerFailure = {
  id: string;
  failed: number;
  lanes: number;
  lastError: string | undefined;
};

/**
 * Per-reviewer failure counts across the batch's successful lanes. A lane counts as
 * "success" as long as one reviewer survived, so a reviewer that failed in every lane is
 * otherwise invisible in the batch summary — findings silently come from fewer reviewers
 * than requested. (Failed lanes report their own error and are excluded here.)
 *
 * The per-reviewer `lanes` denominator counts lanes the reviewer appears in; the runner
 * resolves one roster and runs it in every lane, so in runner-produced artifacts this
 * equals the successful-lane count.
 */
function batchReviewerFailures(artifact: ReviewBatchArtifact): BatchReviewerFailure[] {
  const byReviewer = new Map<string, BatchReviewerFailure>();
  for (const lane of artifact.lanes) {
    if (lane.status !== "success") {
      continue;
    }
    for (const reviewer of lane.artifact.reviewers ?? []) {
      const entry = byReviewer.get(reviewer.id) ?? {
        id: reviewer.id,
        failed: 0,
        lanes: 0,
        lastError: undefined,
      };
      entry.lanes += 1;
      if (reviewer.status === "failed") {
        entry.failed += 1;
        entry.lastError = reviewer.error?.message ?? entry.lastError;
      }
      byReviewer.set(reviewer.id, entry);
    }
  }
  return [...byReviewer.values()].filter((entry) => entry.failed > 0);
}

function renderHumanBatchReviewSummary(
  artifact: ReviewBatchArtifact,
  options: HumanReviewRenderOptions,
): string {
  const style = createStyle(options);
  const glyphs = options.unicode === true ? unicodeGlyphs : asciiGlyphs;
  const width = options.width ?? defaultSummaryWidth;
  const findingTotal = artifact.result.findings.length;

  const lines = ["", ...renderVerdictBanner(artifact, style, glyphs, width)];

  if (artifact.warnings !== undefined && artifact.warnings.length > 0) {
    lines.push("", style.warning("Warnings"));
    for (const warning of artifact.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  const reviewerFailures = batchReviewerFailures(artifact);
  if (reviewerFailures.length > 0) {
    lines.push("");
    for (const failure of reviewerFailures) {
      lines.push(
        `${style.danger(
          `${glyphs.fail} ${failure.id} failed in ${failure.failed} of ${failure.lanes} lanes`,
        )}   ${style.muted(failure.lastError ?? "Unknown error")}`,
      );
    }
  }

  if (findingTotal > 0) {
    for (const finding of [...artifact.result.findings].sort(compareFindings)) {
      lines.push("", ...renderFindingCard(finding, style, glyphs, width, artifact.cwd));
    }
  }

  for (const lane of artifact.lanes) {
    lines.push("", style.heading(`Lane ${formatLaneArtifactLabel(lane)}`));
    lines.push(`Status: ${lane.status}`);
    if (lane.status === "failed") {
      lines.push(`Error: ${lane.error.message}`);
      continue;
    }

    lines.push(
      `Verdict: ${formatVerdict(lane.artifact.result.overall_correctness, style)}`,
      `Findings: ${lane.artifact.result.findings.length}`,
      `Reviewers: ${formatReviewers(lane.artifact)}`,
    );
  }

  const explanation = artifact.result.overall_explanation.trim();
  if (explanation !== "") {
    lines.push("", style.muted("overall explanation"), ...wrapText(explanation, width, ""));
  }

  const footer = renderSummaryFooter(artifact, glyphs);
  if (footer !== undefined) {
    lines.push("", style.muted(footer));
  }

  return `${lines.join("\n")}\n`;
}

function renderAgentBatchReviewSummary(artifact: ReviewBatchArtifact): string {
  const counts = findingCounts(artifact.result.findings);
  const findingTotal = artifact.result.findings.length;
  const successfulLanes = artifact.lanes.filter((lane) => lane.status === "success");
  const failedLanes = artifact.lanes.filter((lane) => lane.status === "failed");
  const lines = [
    "Diffwarden Review Batch",
    `Target: ${formatTarget(artifact.target.kind, artifact.target)}`,
    `Verdict: ${artifact.result.overall_correctness}`,
    `Confidence: ${formatConfidence(artifact.result.overall_confidence_score)}`,
    `Findings: ${formatAgentFindingCount(findingTotal, counts)}`,
    `Lanes: ${successfulLanes.length} passed, ${failedLanes.length} failed`,
  ];
  const reviewerFailures = batchReviewerFailures(artifact);
  if (reviewerFailures.length > 0) {
    lines.push(
      `Reviewer failures: ${reviewerFailures
        .map((failure) => `${failure.id} failed in ${failure.failed} of ${failure.lanes} lanes`)
        .join("; ")}`,
    );
  }

  if (artifact.warnings !== undefined && artifact.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of artifact.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (findingTotal === 0) {
    lines.push("", "No findings.");
  } else {
    lines.push("", "Merged findings:");
    for (const [index, finding] of [...artifact.result.findings].sort(compareFindings).entries()) {
      lines.push(...renderAgentFinding(index + 1, finding));
    }
  }

  lines.push("", "Lanes:");
  for (const lane of artifact.lanes) {
    lines.push(`- ${formatLaneArtifactLabel(lane)}: ${lane.status}`);
    if (lane.status === "failed") {
      lines.push(`  Error: ${lane.error.message}`);
      continue;
    }
    lines.push(
      `  Verdict: ${lane.artifact.result.overall_correctness}`,
      `  Findings: ${lane.artifact.result.findings.length}`,
      `  Reviewers: ${formatReviewers(lane.artifact)}`,
    );
  }

  const explanation = artifact.result.overall_explanation.trim();
  if (explanation !== "") {
    lines.push("", "Overall explanation:", explanation);
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

/**
 * Finding card: a priority-colored bar anchors line 1 (bar + P-label + title), then meta and
 * body share one hanging indent so the eye tracks a single left rail.
 */
function renderFindingCard(
  finding: RenderFinding,
  style: HumanStyle,
  glyphs: typeof asciiGlyphs,
  width: number,
  cwd: string,
): string[] {
  const paint =
    finding.priority !== undefined && finding.priority <= 1
      ? style.danger
      : finding.priority === 2
        ? style.warning
        : style.muted;
  const label = finding.priority === undefined ? "P?" : `P${finding.priority}`;
  const location = finding.code_location;
  const file = shortenPath(location.absolute_file_path, cwd);
  const range =
    location.line_range.start === location.line_range.end
      ? `${location.line_range.start}`
      : `${location.line_range.start}-${location.line_range.end}`;
  const metaParts = [
    `${file}:${range}`,
    ...(finding.reviewer_ids !== undefined && finding.reviewer_ids.length > 0
      ? [finding.reviewer_ids.join(", ")]
      : []),
    ...(finding.lane_ids !== undefined && finding.lane_ids.length > 0
      ? [`lanes ${finding.lane_ids.join(", ")}`]
      : []),
    `confidence ${formatConfidence(finding.confidence_score)}`,
  ];
  return [
    `${paint(glyphs.spine)} ${style.bold(paint(label))}  ${style.bold(finding.title)}`,
    style.muted(`   ${metaParts.join(` ${glyphs.dot} `)}`),
    ...wrapText(finding.body, width, "   "),
  ];
}

/** Repo-relative when the file sits under the run's cwd — absolute paths bloat every card. */
function shortenPath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative !== "" && !relative.startsWith("..") ? relative : absolutePath;
}

function formatAgentFindingCount(total: number, counts: FindingCounts): string {
  if (total === 0) {
    return "0";
  }

  const parts = [
    counts.p0 > 0 ? `P0 ${counts.p0}` : undefined,
    counts.p1 > 0 ? `P1 ${counts.p1}` : undefined,
    counts.p2 > 0 ? `P2 ${counts.p2}` : undefined,
    counts.p3 > 0 ? `P3 ${counts.p3}` : undefined,
    counts.unspecified > 0 ? `Unspecified ${counts.unspecified}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return `${total} (${parts.join(", ")})`;
}

function renderAgentFinding(index: number, finding: RenderFinding): string[] {
  const location = finding.code_location;
  const lines = [
    `${index}. ${formatPlainPriority(finding.priority)} ${finding.title}`,
    `File: ${location.absolute_file_path}:${location.line_range.start}-${location.line_range.end}`,
    `Confidence: ${formatConfidence(finding.confidence_score)}`,
  ];

  if (finding.reviewer_ids !== undefined && finding.reviewer_ids.length > 0) {
    lines.push(`Reviewers: ${finding.reviewer_ids.join(", ")}`);
  }
  if (finding.lane_ids !== undefined && finding.lane_ids.length > 0) {
    lines.push(`Lanes: ${finding.lane_ids.join(", ")}`);
  }

  const body = finding.body.trim();
  if (body !== "") {
    lines.push("Body:", body);
  }

  return lines;
}

function formatPlainPriority(priority: ReviewArtifactFinding["priority"]): string {
  return priority === undefined ? "P?" : `P${priority}`;
}

// Scoped to the artifact it is handed: batch call sites pass each lane's own artifact, so
// the (failed) marker always describes that lane, never a representative lane.
function formatReviewers(artifact: ReviewArtifact): string {
  if (artifact.reviewers !== undefined && artifact.reviewers.length > 0) {
    return artifact.reviewers
      .map((reviewer) => (reviewer.status === "failed" ? `${reviewer.id} (failed)` : reviewer.id))
      .join(", ");
  }

  if (artifact.engine !== undefined) {
    return artifact.engine;
  }

  return "unknown";
}

function isBatchArtifact(artifact: ReviewRunArtifact): artifact is ReviewBatchArtifact {
  return "kind" in artifact && artifact.kind === "batch";
}

function formatLanePrefix(laneId: string | undefined): string {
  return laneId === undefined ? "" : `[${laneId}] `;
}

function formatLanePlanLabel(lane: ReviewBatchArtifact["plan"]["lanes"][number]): string {
  return lane.kind === "overview" ? "overview" : `${lane.id}: ${lane.focus}`;
}

function formatLaneArtifactLabel(lane: ReviewBatchArtifact["lanes"][number]): string {
  return lane.kind === "overview" ? "overview" : `${lane.id}: ${lane.focus}`;
}

function findingCounts(findings: RenderFinding[]): FindingCounts {
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
  verdict: ReviewRunArtifact["result"]["overall_correctness"],
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

function formatTarget(kind: string, target: ReviewTargetResolved): string {
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

function compareFindings(left: RenderFinding, right: RenderFinding): number {
  return (
    prioritySortValue(left) - prioritySortValue(right) ||
    left.code_location.absolute_file_path.localeCompare(right.code_location.absolute_file_path) ||
    left.code_location.line_range.start - right.code_location.line_range.start ||
    left.code_location.line_range.end - right.code_location.line_range.end ||
    left.title.localeCompare(right.title)
  );
}

function prioritySortValue(finding: RenderFinding): number {
  return finding.priority ?? 4;
}

// Referenced by helper signatures above — fine: type alias declarations hoist across the module.
export type HumanStyle = ReturnType<typeof createStyle>;

export function createStyle(options: HumanReviewRenderOptions) {
  const enabled = options.color === true;
  return {
    accent: (value: string) => color(value, 36, enabled),
    bold: (value: string) => color(value, 1, enabled),
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
