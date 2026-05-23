import { invalidCli } from "./errors.js";
import type { ReviewArtifactResult, ReviewPriority } from "./schema.js";

export type FindingFailureThreshold = ReviewPriority;

export function parseFindingFailureThreshold(value: string): FindingFailureThreshold {
  const match = /^P([0-3])$/i.exec(value.trim());
  if (match === null) {
    throw invalidCli("Invalid --fail-on-findings value: expected P0, P1, P2, or P3");
  }

  return Number(match[1]) as FindingFailureThreshold;
}

export function hasFindingAtOrAbovePriority(
  result: ReviewArtifactResult,
  threshold: FindingFailureThreshold,
): boolean {
  return result.findings.some((finding) => {
    if (finding.priority === undefined) {
      return false;
    }

    return finding.priority <= threshold;
  });
}
