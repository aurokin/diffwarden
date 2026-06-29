---
name: diffwarden
description: Use when an agent should run the diffwarden CLI to request read-only code review of local changes, a branch diff, a single commit, or repository-scoped custom instructions from the repository it is working in.
---

# Diffwarden

Use `diffwarden` as a read-only review tool from the repository being reviewed. This skill is
for agents using Diffwarden, not for agents developing Diffwarden itself. See
`docs/consumer-context.md` in the Diffwarden repo for the consumer/contributor boundary.

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

   Use repeatable `--focus <text>` when the user wants scoped passes over one diff-backed
   target, such as state management, storage, localization, or migration risk. Focus lanes
   work with `uncommitted`, `base:<branch>`, and `commit:<sha>` targets. They remain
   diff-backed and changed-line validated; do not use them with `custom:<text>`.

2. Pick reviewers:
   - Use `diffwarden reviewers list` when you need to see configured reviewer IDs or reviewer
     sets before choosing.
   - Treat reviewers shown as disabled as intentionally unavailable. Do not select them or
     edit their `enabled` flag unless the user explicitly asks you to enable or disable that
     reviewer.
   - Use explicit `--reviewer` values when the user names reviewers.
   - Prefer the configured default reviewer set unless the user specifies reviewers or a
     different set. Passing no reviewer flags uses `defaultReviewerSet` when config defines
     it; use `--reviewer-set <name|count>` when you need an explicit set.
   - If neither is available, explain that Diffwarden needs an explicit reviewer, a reviewer
     set, or a config-defined `defaultReviewerSet`. You may run `diffwarden reviewers discover`
     to show which engines this host could run; it is read-only and spends no model budget. Do
     not write config (`diffwarden reviewers add`, `diffwarden init`) or change reviewer setup
     unless the user explicitly asks you to.

3. Run `diffwarden review` from the repository being reviewed. If running from another
   directory, pass `--cwd <repo>`.

4. Pick an output mode:
   - Use `--agent` for the normal coding-agent path. It emits plain text without terminal
     presentation.
   - Use `--json` when another tool needs the final structured artifact.
   - Use `--ndjson` for incremental consumers that need progress events before the final
     artifact is ready.
   - Omit mode flags only when a human wants to watch the interactive display.

5. For CI-like checks, use `--fail-on-findings <P0|P1|P2|P3>` only when the user wants an
   exit-code gate. It preserves normal output and exits `1` when final aggregated findings
   include a prioritized finding at or above the threshold. Findings without `priority` do
   not trigger the gate.

6. Read warnings before deciding whether output is complete. Multi-reviewer runs can return
   partial results when one reviewer fails unless `--strict` is used.

## Commands

Use real built-in reviewers or configured profile names in `--reviewer`; do not pass the
literal placeholder `<reviewer>`.

```bash
diffwarden review --target base:main --agent
diffwarden review --target base:main --reviewer-set <name|count> --agent
diffwarden review --target commit:<sha> --json
diffwarden review --target uncommitted --reviewer cursor --agent
diffwarden review --target base:main --reviewer pi --agent
diffwarden review --target base:main --reviewer cursor --reviewer pi:openrouter-high --agent
diffwarden review --target base:main --reviewer claude --model sonnet --effort high --agent
diffwarden review --target base:main --reviewer droid-cli --model claude-opus-4-7 --effort high --agent
diffwarden review --target base:main --reviewer cursor --json --out review.json
diffwarden review show review.json --agent
diffwarden review --target base:main --reviewer-set <name> --ndjson
diffwarden review --target base:main --reviewer-set <name> --agent --focus "focus on state management" --focus "focus on localization"
diffwarden review --target base:main --reviewer-set <name> --agent --no-overview --focus "focus on state management"
diffwarden review --target 'custom:Review auth flow and permission checks' --reviewer-set <name> --agent
diffwarden review --target base:main --reviewer-set <name> --fail-on-findings P2 --agent
diffwarden reviewers list
diffwarden reviewers list --json
diffwarden reviewers discover
diffwarden init
```

Use `fake` only for credential-free smoke checks, not real review:

```bash
diffwarden review --target uncommitted --reviewer fake --agent
```

## Output Handling

- `--agent` output can be read directly and summarized to the user.
- JSON artifacts use `schema_version: 2` and include target, result, validation, warnings,
  and per-reviewer artifacts. Focus runs return a `ReviewBatchArtifact` with `kind: "batch"`,
  a resolved lane plan, a top-level merged result for gates, and per-lane artifacts.
- NDJSON events use `schema_version: 2`. Parse each stdout line as one event. After
  `run_started`, the stream ends with exactly one terminal event: `final_result` or `error`.
  Focus batch streams start with `batch_started`, include lane-scoped events carrying
  `lane_id`, emit `lane_finished`/`lane_failed`, and still terminate with exactly one
  `final_result` or `error`.
- Treat `reviewer_result` NDJSON events as provisional. Only `final_result.artifact` is the
  authoritative aggregated review artifact.
- Findings include title, body, confidence, optional priority, file path, and line range.
- Treat findings as review evidence, not automatic truth.
- Preserve severity, reviewer attribution, and file/line references when summarizing.
- If a finding is intentionally declined, add a concise inline code
  comment near the relevant code explaining the invariant or tradeoff. That helps future
  review runs avoid fixating on the same apparent issue. 
- If there are no findings, say that directly and mention any warnings or residual test gaps.
- `reviewers discover` reports host readiness, not a review. It groups reviewers as Ready to use /
  Needs attention / Not installed, ordered verified-first then alphabetically. JSON uses
  `schema_version: 1` with `candidates` (each carrying `status` and `authState`) plus a `summary`.
  `status` is one of `available`, `missing_executable`, `missing_auth`, `requires_env`,
  `unsupported_host`, or `preflight_failed`. `authState` is `verified` (a token-free signal — an
  env var or credential file — confirmed auth), `unverified` (installed but auth is delegated to
  the engine's own login and was not checked), `missing`, or `not_required`. It is shallow by
  default (no network or login); `--deep` additionally runs adapter preflight.

## Boundaries

- Diffwarden does not publish review comments to external services.
- Reviewing and `reviewers discover` are read-only and spend no model budget. Only
  `reviewers add` and `init` write config, and only to the user config file. Do not run them
  unless the user explicitly asks you to change reviewer setup.
- Droid users should prefer configured `droid-cli` reviewers for routine reviews when Factory
  UI session history matters.
