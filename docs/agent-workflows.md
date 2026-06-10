# Agent Workflows

Diffwarden is most useful when a coding agent needs a repeatable review gate before
reporting, committing, or moving an external issue to done. These workflows are
prompt patterns for agents that already know how to edit code and run project checks.
They do not change Diffwarden's CLI contract: the product still accepts a target,
runs the configured reviewers, and returns Markdown, JSON, or NDJSON.

Raw prompt examples are kept separately:

- [`docs/prompts/diffwarden-changes.md`](./prompts/diffwarden-changes.md)
- [`docs/prompts/complete-linear-issues.md`](./prompts/complete-linear-issues.md)

## Review With Diffwarden

Use this pattern when implementation work is complete enough for review, but before
final reporting or commit.

```text
Use Diffwarden to review the current code changes until there are no valid findings.

For each finding:
- Decide whether it is valid by reading the relevant code and tests.
- Fix valid findings.
- Record invalid or intentionally deferred findings with the reason.
- Rerun Diffwarden after fixes that change reviewed code.

At the end, report the Diffwarden command or commands, any remaining findings, and
the decisions made while handling the review.
```

Common commands:

```bash
diffwarden --target uncommitted
diffwarden --target uncommitted --reviewer-set 2
diffwarden --target uncommitted --reviewer cursor --reviewer claude
diffwarden --target base:main --reviewer-set 2
```

If the repo or user config does not define `defaultReviewerSet`, pass an explicit
`--reviewer` or `--reviewer-set`. Use `--reviewer fake` only for local development
and credential-free tests, not as a real review gate.

## Complete Linear Issues

Use this pattern for Linear issues where the agent owns implementation, review,
documentation, and status updates. The same shape can be adapted to GitHub issues
or another tracker-backed task.

```text
Complete the listed issues end to end.

Before editing code:
- Read each issue, linked issues, milestone or project context, comments, relevant
  documentation, and the code that will likely change.
- Create a short implementation plan for each issue.
- Keep a decision log for planning, implementation, and review decisions.
- If the agent environment supports a separate planning reviewer, use it to check
  whether the plan covers the issue before coding.

During implementation:
- Work one coherent issue or vertical slice at a time.
- Run the repo's normal low-churn checks for the changed surface.
- Use Diffwarden to review the resulting code until there are no valid findings.
- For every Diffwarden finding, either fix it or record why it is not valid for this
  change.

Before moving on:
- Commit only after implementation, project checks, and Diffwarden review are complete.
- Decide whether documentation needs to change; make that update before closing the
  issue or starting the next one.
- Update the external issue status and final comment with what changed, how it was
  verified, and any review decisions worth preserving. For Linear, move through the
  workspace's normal todo, in-review, and done statuses as the work progresses.
```

For scratch notes, use the repository's existing temporary-work convention. If the
repo does not have one, a useful pattern is:

```text
.tmp/<session-name>/<ISSUE-ID>_PLAN.md
.tmp/<session-name>/<ISSUE-ID>_DECISIONS.md
```

Only use that path when `.tmp/` is ignored or when you intentionally add it to the
repo's ignore rules. These files are for in-session planning and should not become
product documentation by accident.

## Decision Logs

Decision logs are valuable because review loops often involve judgment, not just
mechanical fixes. Keep them short and concrete:

```text
- DW-1: Valid. Fixed the null result path in src/example.ts and added coverage.
- DW-2: Not valid. The reviewer assumed sync execution, but this path awaits the
  write before returning.
- DOC-1: Updated docs/configuration.md because the new option affects user setup.
```

The final agent report should summarize the same decisions in prose or bullets, but
the scratch log gives future turns a stable source of truth if the session is
interrupted.

## Documentation Pass

When an issue or milestone changes user behavior, reviewer behavior, configuration,
or repo conventions, update docs as part of the same workflow. Prefer progressive
disclosure:

- Put quick-start or high-frequency usage in `README.md`.
- Put option and config detail in `docs/configuration.md`.
- Put reviewer runtime behavior in `docs/adapters.md` and the capability summary in
  `docs/features.md`.
- Put broader tradeoffs in `docs/comparisons.md` or `SPEC.md`.
- Keep version-sensitive SDK discoveries near the adapter docs or code that depends
  on them, and link upstream references instead of copying large upstream sections.
