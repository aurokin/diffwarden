# ADR 0001: Human Review Experience Without a Full Terminal Framework

## Status

Accepted, 2026-06-13

## Context

Diffwarden's primary contract is agent-callable code review. Agents and automation should be able
to run `diffwarden`, receive a stable `ReviewArtifact` as JSON, and make downstream decisions from
that artifact. Humans still need a first-class way to run or inspect reviews, but that surface should
not compromise the default machine-readable path.

Two open product issues touch this area:

- AUR-537 proposes making JSON the default output and adding a human terminal UI.
- AUR-567 proposes host-aware reviewer discovery and setup.

The human experience should share the `diffwarden-marketing` "night watch" feel: dark terminal-native
surfaces, precise status language, diff-colored accents, reviewer fan-out, and a strong visual moment
that is memorable enough for demos and screenshots. At the same time, Diffwarden should avoid the
common failure modes of full terminal apps inside tmux, SSH, CI, and agent-run terminals.

## Decision

Do not adopt a full terminal UI framework for the first human review experience.

Instead, build a frameworkless, TTY-aware human review renderer on top of the existing
`runReviewEvents` and `ReviewArtifact` model.

The initial human review experience should:

- Use an explicit human entry point such as `diffwarden review` or an explicit human output mode.
- Keep the default agent path machine-readable, with JSON as the default stdout contract once AUR-537
  is implemented.
- Treat human output as presentation, not a stable parsing contract.
- Render live reviewer fan-out, reviewer state changes, warnings, failed reviewers, verdict,
  confidence, finding counts, and final finding summaries.
- Use controlled ANSI styling and small bounded redraws only when the terminal supports them.
- Degrade to plain append-only text when stdout/stderr are not TTYs, `TERM=dumb`, CI is detected,
  color is disabled, or terminal dimensions are too constrained.
- Avoid alternate screen buffers, raw mode, mouse handling, custom scroll regions, and mandatory
  keybindings.

AUR-567 should use the same visual language for discovery, but it should not depend on a full TUI.
Discovery should remain JSON-first for agents and scripts. Human setup may use plain tables, status
rows, and a narrow prompt flow for explicit config changes.

## Deferred

Full TUI frameworks such as OpenTUI or Ink are deferred until Diffwarden has a clear product need for
persistent keyboard navigation, filtering, selection, or multi-pane drilldown.

OpenTUI is not a good required dependency for the current package posture because Diffwarden supports
Node `>=22.19.0`, while OpenTUI's native renderer currently requires Bun or a newer Node runtime with
experimental FFI. Ink is more compatible with the current Node floor, but it is still more framework
than the first human review surface needs.

An optional local HTML report or artifact viewer remains a strong future path for a richer visual
experience. That should be considered separately from the terminal renderer because it can reuse more
of the marketing site's visual language without inheriting terminal compatibility risk.

## Consequences

Positive consequences:

- Preserves Diffwarden's simple agent contract.
- Avoids most tmux, SSH, and CI edge cases associated with full-screen terminal apps.
- Keeps the dependency footprint small.
- Lets the human review surface feel designed without turning Diffwarden into a terminal IDE.
- Allows AUR-537 and AUR-567 to share status, icon, color, and diagnostic vocabulary without sharing
  a heavyweight framework.

Tradeoffs:

- The first human review experience will not support deep keyboard navigation or persistent panes.
- Long review artifacts may need concise summaries, truncation, or follow-up commands for full detail.
- If users later need interactive filtering or finding drilldown, a TUI framework decision will need
  to be revisited.

## Implementation Guidance

Prefer small, testable presentation modules:

- A view model that converts `ReviewEvent` and `ReviewArtifact` into human display state.
- A terminal capability detector for TTY, color, width, CI, and dumb terminal behavior.
- An icon/color resolver shared by review display and reviewer discovery.
- A renderer with append-only and bounded-redraw modes.
- Snapshot or process tests that verify non-TTY output remains readable and machine output remains
  clean.

The renderer must never write ANSI presentation, icons, spinners, or progress frames to JSON or NDJSON
stdout contracts.

## Related Issues

- AUR-537: Make JSON the default output and add a human review experience.
- AUR-567: Add host-aware reviewer discovery and setup flow.
