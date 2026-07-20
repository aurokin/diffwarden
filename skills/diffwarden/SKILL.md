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
   diff-backed and changed-line validated; do not use them with `custom:<text>`. See
   "Choosing lanes and overview" below for when lanes and the overview lane pay off.

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
   - Only when debugging reviewer behavior, add `--debug-reviewer-output` to capture a
     bounded raw stdout/stderr transcript per CLI-transport reviewer (`debug_output` on the
     reviewer artifact; streamed `reviewer_debug_output` events with `--ndjson`). With
     `--ndjson`, Claude and Droid CLI reviewers switch to their native stream output so
     debug events arrive live as compact summaries with reasoning excluded. It is
     token-heavy and may contain sensitive raw provider output; leave it off for normal
     reviews.

5. For CI-like checks, use `--fail-on-findings <P0|P1|P2|P3>` only when the user wants an
   exit-code gate. It preserves normal output and exits `1` when final aggregated findings
   include a prioritized finding at or above the threshold. Findings without `priority` do
   not trigger the gate.

6. Read warnings before deciding whether output is complete. Multi-reviewer runs can return
   partial results when one reviewer fails unless `--strict` is used.

## Choosing lanes and overview

- Every lane, including the overview lane, carries the full resolved diff. `--focus`
  narrows the reviewer's attention, not the payload; never add lanes to work around diff
  size or provider input limits.
- Reach for `--focus` when the change spans distinct domains (one lane per domain), when
  iterating a fix-and-re-review loop, when a clean overview deserves adversarial depth in
  historically buggy areas, or to reassess one specific prior finding (single lane,
  `--no-overview`, cite the exact code path in the lane text).
- In fix-and-re-review loops, keep lane texts verbatim across rounds so a clean result is
  comparable rather than achieved by quietly narrowing scope. As sections go clean, rerun
  only the still-dirty lanes.
- With `--focus` present, the overview lane runs by default (an overview is a full
  unscoped pass, identical to a default run, not a summary). Suppress it with
  `--no-overview` for partition rounds, section re-reviews, and single-finding rebuttals;
  keep the default for fix-verification rounds, where lanes confirm the fixes and the
  overview watches for regressions the fixes introduced.
- Lane-clean is not done: overview and focus lanes reliably find disjoint defects, and a
  clean overview does not override lane findings. Finish a review campaign with an
  unscoped pass, and on long campaigns interleave one every few fix rounds rather than
  only at the end. Expect a closing overview to reopen a fix cycle or two.
- If the diff is too large for a reviewer's transport input limit, diff-backed lanes and
  the overview fail identically. Fall back to `--target commit:<sha>` reviews of each
  change, or a `custom:<text>` repository-exploring pass (which embeds instructions
  rather than the patch); remember `custom:` findings lose changed-line validation, so
  verify them before fixing.
- After every focus batch, read the artifact warnings before trusting coverage: without
  `--strict`, a reviewer or lane that failed degrades to a warning while siblings
  succeed, so findings may come from fewer reviewers than requested.
- A failed run writes a failure record to `--out` (`kind: "failure"` with the error) rather
  than a review artifact; `review show` reports it as a failed run. Still wait for process
  completion instead of polling for the file. Diff-backed targets need at least one
  commit — on a brand-new repository, create an initial commit first.

## Commands

Use real built-in reviewers or configured profile names in `--reviewer`; do not pass the
literal placeholder `<reviewer>`. `claude` and `codex` are the flagship fully supported
engines; the other engines shown below (`cursor`, `pi`, `droid-cli`, …) are experimental.

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
diffwarden review --target base:main --reviewer droid-cli --ndjson --debug-reviewer-output
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
- Reviewing and `reviewers discover` are read-only and spend no model budget. The config-writing
  commands — `reviewers add`, `reviewers edit`, `reviewers remove`, `reviewers set add/remove`,
  and `init` — write only to the user config file, atomically. Do not run them unless the user
  explicitly asks you to change reviewer setup. `remove` and `set remove` refuse to empty the
  `defaultReviewerSet` without `--force`. These commands are interactive-by-default only in a TTY;
  when you do run them, always name the target explicitly (the engine for `add`, the id for
  `remove`/`edit`) and pass at least one field flag for `edit`, since a bare or no-field setup
  command in your non-TTY session exits non-zero instead of opening the interactive picker.
- Droid users should prefer configured `droid-cli` reviewers for routine reviews when Factory
  UI session history matters.
