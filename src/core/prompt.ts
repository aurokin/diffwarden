import type { ReviewTargetResolved } from "./schema.js";

export function buildReviewPrompt(target: ReviewTargetResolved, diff: string): string {
  return [
    "Review the code changes in this repository.",
    `The target is ${renderTarget(target)}.`,
    `Inspect the patch with:\n\n  ${target.diff_command}`,
    "Only report bugs introduced by this diff.",
    "Emit the ReviewResult JSON object exactly.",
    "",
    "Patch:",
    "```diff",
    diff,
    "```",
  ].join("\n\n");
}

function renderTarget(target: ReviewTargetResolved): string {
  if (target.kind === "base" && target.base_ref) {
    return `base:${target.base_ref}`;
  }
  if (target.kind === "commit" && target.commit_sha) {
    return `commit:${target.commit_sha}`;
  }
  return target.kind;
}
