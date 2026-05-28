import type { ReviewTargetResolved } from "./schema.js";

export function buildReviewPrompt(
  target: ReviewTargetResolved,
  diff: string,
): string {
  if (target.kind === "custom") {
    return buildCustomReviewPrompt(target);
  }

  return [
    reviewRubric({ diffBacked: true }),
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
    reviewRubric({ diffBacked: false }),
    "Review this repository using the custom instructions below.",
    `The target is ${renderTarget(target)}.`,
    `Inspect the repository from:\n\n  cd ${shellQuote(target.repo_root)}`,
    "Report only actionable issues within the scope of the custom instructions.",
    "Custom instructions:",
    target.instructions?.trim() ?? "",
    reviewResultInstructions(),
  ].join("\n\n");
}

function reviewRubric(options: { diffBacked: boolean }): string {
  const scopeRule = options.diffBacked
    ? "Only flag issues introduced by the reviewed diff. Do not report pre-existing bugs or unrelated repository problems."
    : "Only flag issues that are directly within the custom review scope. Do not broaden the review into unrelated repository problems.";
  const locationRule = options.diffBacked
    ? "Choose the shortest useful line range for each finding, usually no more than 5-10 lines, and make the range overlap the diff."
    : "Choose the shortest useful line range for each finding, usually no more than 5-10 lines, and keep locations inside the repository.";

  return [
    "Review guidelines:",
    "",
    "Act as a read-only reviewer for a proposed code change made by another engineer. Do not run tests or health checks.",
    "",
    "Flag a finding only when all of these are true:",
    "",
    "- It meaningfully affects correctness, performance, security, or maintainability.",
    "- It is a discrete, actionable issue rather than a broad critique or a cluster of loosely related concerns.",
    `- ${scopeRule}`,
    "- The original author would likely fix it if they knew about it.",
    "- It does not depend on unstated assumptions about author intent.",
    "- It identifies a concrete affected path, scenario, input, or environment rather than speculating about possible breakage.",
    "- It is clearly not just an intentional behavior change by the author.",
    "",
    "Finding rules:",
    "",
    "- Return every qualifying finding, but prefer an empty findings array over weak or speculative findings.",
    "- Use one finding per distinct issue.",
    "- Ignore trivial style, formatting, typos, and documentation nits unless they obscure meaning or violate documented project requirements.",
    "- Keep each finding body to one concise paragraph.",
    "- Explain why the issue is a bug and state the conditions needed for it to occur.",
    "- Keep tone matter-of-fact. Do not praise the author, apologize, or sound accusatory.",
    `- ${locationRule}`,
    "- Do not include code blocks longer than 3 lines in a finding body.",
    "- Do not generate a patch or PR fix.",
    "",
    "Priority rules:",
    "",
    "- Prefix each finding title with a priority tag: [P0], [P1], [P2], or [P3].",
    "- [P0] means a universal blocker for release, production, or core usage.",
    "- [P1] means urgent and should be fixed in the next cycle.",
    "- [P2] means a normal bug that should be fixed eventually.",
    "- [P3] means low-priority but still actionable.",
    "- Include the numeric priority field as 0, 1, 2, or 3 whenever the priority is known.",
    "",
    "Overall correctness:",
    "",
    '- Use "patch is correct" only when existing code and tests should continue to work and there are no blocking bugs.',
    '- Use "patch is incorrect" when at least one finding shows the patch can break behavior, tests, security, performance, or maintainability.',
    "- Ignore non-blocking nits when deciding overall correctness.",
  ].join("\n");
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
