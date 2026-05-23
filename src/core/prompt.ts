import type { ReviewTargetResolved } from "./schema.js";

export function buildReviewPrompt(target: ReviewTargetResolved, diff: string): string {
  if (target.kind === "custom") {
    return buildCustomReviewPrompt(target);
  }

  return [
    "Review the code changes in this repository.",
    `The target is ${renderTarget(target)}.`,
    `Inspect the patch from the repository root with:\n\n  cd ${shellQuote(target.repo_root)} && ${target.diff_command}`,
    "Only report bugs introduced by this diff.",
    reviewResultInstructions(),
    "",
    "Patch:",
    "```diff",
    diff,
    "```",
  ].join("\n\n");
}

function buildCustomReviewPrompt(target: ReviewTargetResolved): string {
  return [
    "Review this repository using the custom instructions below.",
    `The target is ${renderTarget(target)}.`,
    `Inspect the repository from:\n\n  cd ${shellQuote(target.repo_root)}`,
    "Report only actionable issues within the scope of the custom instructions.",
    "Custom instructions:",
    target.instructions?.trim() ?? "",
    reviewResultInstructions(),
  ].join("\n\n");
}

function reviewResultInstructions(): string {
  return [
    "Return only a JSON object that matches this ReviewResult shape. Do not wrap it in Markdown or any surrounding prose.",
    [
      "{",
      '  "findings": [',
      "    {",
      '      "title": "[P1] Short bug title",',
      '      "body": "Concise explanation of why this is a bug and when it occurs.",',
      '      "confidence_score": 0.0,',
      '      "priority": 1,',
      '      "code_location": {',
      '        "absolute_file_path": "/absolute/path/to/file",',
      '        "line_range": { "start": 1, "end": 1 }',
      "      }",
      "    }",
      "  ],",
      '  "overall_correctness": "patch is correct",',
      '  "overall_explanation": "Brief summary of whether the patch is correct.",',
      '  "overall_confidence_score": 0.0',
      "}",
    ].join("\n"),
    "Use an empty findings array when there are no actionable bugs.",
    'Set overall_correctness to exactly "patch is correct" or "patch is incorrect".',
  ].join("\n\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function renderTarget(target: ReviewTargetResolved): string {
  if (target.kind === "base" && target.base_ref) {
    return `base:${target.base_ref}`;
  }
  if (target.kind === "commit" && target.commit_sha) {
    return `commit:${target.commit_sha}`;
  }
  if (target.kind === "custom" && target.instructions) {
    return `custom:${target.instructions}`;
  }
  return target.kind;
}
