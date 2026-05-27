---
name: diffwarden
description: Use when an agent should run the diffwarden CLI to request read-only code review of local changes, a branch diff, a single commit, or repository-scoped custom instructions from the repository it is working in.
---

# Diffwarden

Use `diffwarden` as a read-only review tool from the repository being reviewed. This skill is
for agents using Diffwarden.

If the user needs to install this skill, prefer the Skills CLI so agent-specific skill
directories and lockfiles stay consistent:

```bash
npx skills add aurokin/diffwarden --global --skill diffwarden --agent codex claude-code --full-depth
```

## Workflow

1. Pick the review target:
   - Working tree changes: `uncommitted`
   - Current branch against a base branch: `base:<branch>`
   - One completed commit: `commit:<sha>`
   - Repository-scoped instructions: `custom:<text>`

   Use `custom:<text>` when the user wants a review that is not tied to one patch, such as
   "review the auth flow" or "look for migration risks." Custom targets still validate
   finding paths, but they do not collect a diff, populate `changed_files`, embed a patch in
   the prompt, or validate findings against changed-line overlap.

2. Pick reviewers:
   - Use explicit `--reviewer` values when the user names reviewers.
   - Prefer the configured default reviewer set unless the user specifies reviewers or a
     different set. Passing no reviewer flags uses `defaultReviewerSet` when config defines
     it; use `--reviewer-set <name|count>` when you need an explicit set.
   - If neither is available, explain that Diffwarden needs an explicit reviewer, a reviewer
     set, or a config-defined `defaultReviewerSet`.

3. Run `diffwarden` from the repository being reviewed. If running from another directory,
   pass `--cwd <repo>`.

4. Pick an output format:
   - Use default Markdown for human-facing responses.
   - Use `--format json` when another tool or agent needs the final structured artifact.
   - Use `--format ndjson` for incremental consumers that need progress events before the
     final artifact is ready.

5. For CI-like checks, use `--fail-on-findings <P0|P1|P2|P3>` only when the user wants an
   exit-code gate. It preserves normal Markdown or JSON output and exits `1` when final
   aggregated findings include a prioritized finding at or above the threshold. Findings
   without `priority` do not trigger the gate.

6. Read warnings before deciding whether output is complete. Multi-reviewer runs can return
   partial results when one reviewer fails unless `--strict` is used.

## Commands

Use real built-in reviewers or configured profile names in `--reviewer`; do not pass the
literal placeholder `<reviewer>`.

```bash
diffwarden --target base:main
diffwarden --target base:main --reviewer-set <name|count>
diffwarden --target commit:<sha> --format json
diffwarden --target uncommitted --reviewer cursor
diffwarden --target base:main --reviewer pi
diffwarden --target base:main --reviewer cursor --reviewer pi:openrouter-high
diffwarden --target base:main --reviewer claude --model sonnet --effort high
diffwarden --target base:main --reviewer droid-cli --model claude-opus-4-7 --effort high
diffwarden --target base:main --reviewer cursor --format json --out review.json
diffwarden --target base:main --reviewer-set <name> --format ndjson
diffwarden --target 'custom:Review auth flow and permission checks' --reviewer-set <name>
diffwarden --target base:main --reviewer-set <name> --fail-on-findings P2
diffwarden init
```

Use `fake` only for credential-free smoke checks, not real review:

```bash
diffwarden --target uncommitted --reviewer fake
```

## Output Handling

- Default Markdown can be shown directly to the user.
- JSON artifacts use `schema_version: 2` and include target, result, validation, warnings,
  and per-reviewer artifacts.
- NDJSON events use `schema_version: 2`. Parse each stdout line as one event. After
  `run_started`, the stream ends with exactly one terminal event: `final_result` or `error`.
- Treat `reviewer_result` NDJSON events as provisional. Only `final_result.artifact` is the
  authoritative aggregated review artifact.
- Findings include title, body, confidence, optional priority, file path, and line range.
- Treat findings as review evidence, not automatic truth.
- Preserve severity, reviewer attribution, and file/line references when summarizing.
- If a finding is intentionally declined, add a concise inline code
  comment near the relevant code explaining the invariant or tradeoff. That helps future
  review runs avoid fixating on the same apparent issue. 
- If there are no findings, say that directly and mention any warnings or residual test gaps.

## Boundaries

- Diffwarden does not publish review comments to external services.
- Droid users should prefer configured `droid-cli` reviewers for routine reviews when Factory
  UI session history matters.
