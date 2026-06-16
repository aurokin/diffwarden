# ADR 0002: Diff-Backed Focus Lanes

## Status

Accepted, 2026-06-13

## Context

Diffwarden currently has two review target shapes:

- Diff-backed targets such as `uncommitted`, `base:<branch>`, and `commit:<sha>`.
- Repository-scoped custom targets such as `custom:<text>`, which run without a collected patch.

`custom:<text>` is useful for repository audits, but it does not solve a common driving-agent
workflow: review one diff through several intentional zones of concern. For example, a user or agent
may want to review `base:main` once for full coverage and also run focused passes for state
management, store behavior, and localization. Those focused passes should remain reviews of the
same diff, not broad repository audits.

The feature needs to be ergonomic for agents. Agents should not need to encode a JSON plan for the
simple case, and they should receive output that clearly separates the overview lane from each focus
lane while preserving a top-level result for automation gates.

## Decision

Keep `--target` as the code snapshot or diff selector. Add `--focus <text>` as an instruction layer
on top of normal diff-backed targets.

Focused reviews are diff-backed. A focus lane must use the same resolved patch and changed-file
metadata as the base target, and findings must still be introduced by the reviewed diff and overlap
changed lines. The focus instructions narrow the review scope; they do not turn the run into a
repository-scoped audit.

When one or more focus lanes are supplied, include an overview lane by default. The overview lane is
the same full-diff review Diffwarden would run today without focus instructions. Users can suppress
it with `--no-overview`, and can force it with `--overview` when configuration disables overview by
default.

Configuration may set the default overview behavior:

```json
{
  "reviewPlan": {
    "includeOverview": true
  }
}
```

The CLI remains the simplest agent-facing plan format:

```bash
diffwarden review --target base:main --reviewer-set 2 --agent \
  --focus "focus on state management" \
  --focus "focus on the store" \
  --focus "focus on localization"

diffwarden review --target base:main --reviewer-set 2 --agent \
  --no-overview \
  --focus "focus on localization"
```

Keep `custom:<text>` behavior unchanged. It remains the repository-scoped, non-diff-backed target.
Focus lanes should not be implemented as aliases or fallbacks to custom targets.

Adapters should not need focus-specific behavior. The focus-plan orchestration should sit above the
existing reviewer runner: resolve the target once, build lanes, then run the existing review pipeline
for each lane with lane-specific prompt instructions.

Lane execution should fan out concurrently. Diffwarden does not offer user-facing sequential
orchestration; any staggering should be limited to adapter trust-policy or process-safety needs. A
reviewer timeout is per reviewer per lane, not a shared batch budget.

## Output Contract

When no focus lanes are supplied, preserve the existing single `ReviewArtifact` contract.

When focus lanes are supplied, return a `ReviewBatchArtifact`. A batch artifact is the public shape
for multi-lane review plans; normal multi-reviewer runs still use the existing `ReviewArtifact`
because reviewer fan-out is already represented by `artifact.reviewers`.

A `ReviewBatchArtifact` contains:

- The shared resolved target.
- The resolved review plan, including `overview` and `focus-*` lane metadata.
- A top-level merged result for CI and `--fail-on-findings`.
- Per-lane artifacts so agents can inspect exactly which overview or focus pass produced a result.

The per-lane artifact should be the normal `ReviewArtifact` shape. This keeps the existing reviewer
aggregation, validation, and renderer behavior reusable inside each lane while giving batch-aware
surfaces the extra plan/lane structure.

Lane identifiers should be deterministic:

- `overview`
- `focus-1`
- `focus-2`
- `focus-3`

The batch output must not overload `reviewer_ids` to represent lane attribution. Reviewer
attribution and lane attribution are separate concepts. Top-level merged findings should retain
reviewer attribution and add lane attribution, while each lane artifact remains inspectable for the
exact lane-local reviewer results.

`--json` prints the full `ReviewBatchArtifact` when focus lanes are supplied, and `--out` writes the
same full-information artifact regardless of display mode. `diffwarden review show <path>` should
accept both saved `ReviewArtifact` and saved `ReviewBatchArtifact` files and render them through the
human, `--agent`, or `--json` paths.

NDJSON batch runs should remain machine-readable and versioned. Prefer a flat lane-aware stream over
nested event wrappers:

- Emit a `batch_started` frame with the shared target, resolved reviewers, and lane plan.
- Emit the existing lifecycle event vocabulary for lane-scoped work with a required `lane_id`.
- Emit lane completion/failure frames when a lane reaches its local artifact or error.
- Emit exactly one terminal `final_result` frame carrying the full `ReviewBatchArtifact`, or one
  terminal `error` frame if the batch cannot produce an artifact.

For non-batch runs, keep the existing event stream unchanged.

## Consequences

Positive consequences:

- Preserves the mental model that targets select code and focus narrows review intent.
- Gives driving agents a simple repeated-flag interface for multi-pass review plans.
- Keeps focus reviews constrained to the diff, avoiding noisy repository-audit findings.
- Keeps adapters isolated from orchestration concerns.
- Allows automation to use one merged verdict while still inspecting lane-specific evidence.

Tradeoffs:

- Batch artifacts add a second public output shape for review runs.
- NDJSON needs lane-aware event framing.
- Focused lanes multiply reviewer cost because each focus is a full reviewer pass.
- Report history needs lane-aware provenance and summaries.

## Implementation Guidance

Prefer thin vertical slices:

- First support one focused diff-backed lane with `--no-overview`.
- Then add repeated focus fan-out plus overview defaults and config.
- Then finalize batch rendering, NDJSON framing, and report provenance.
- Finally update README, configuration docs, feature docs, and the product spec.

Prompt wording for focused lanes should make both constraints explicit:

- Only report issues introduced by the reviewed diff.
- Only report issues directly relevant to the focus instructions.

Validation should continue to use changed-file and changed-line overlap checks for focused lanes.

## Related Issues

- AUR-568: Add focus lanes for diff-backed reviews.
- AUR-569: Support one focused diff-backed review lane.
- AUR-570: Fan out repeated focus lanes with overview defaults.
- AUR-571: Render and stream batch review results by lane.
- AUR-572: Record focus plan provenance in reports.
- AUR-573: Document focus reviews and overview controls.
