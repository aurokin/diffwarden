# ADR 0001: Human Review Experience Without a Full Terminal Framework

## Status

Accepted, 2026-06-13. Amended 2026-07-03 (AUR-583) — see [Amendment](#amendment) for the
raw-mode carve-out that lets interactive setup commands use inline arrow-key prompts behind the
TTY gate while the review renderer keeps the original constraint.

## Context

Diffwarden's primary contract is agent-callable code review. Agents should be able to run
`diffwarden review --agent` and receive direct plain text they can act on, while automation can run
`diffwarden review --json` or `diffwarden review --ndjson` for stable structured contracts. Humans
still need a first-class way to run or inspect reviews, but that surface should not compromise the
agent or machine-readable paths.

Two open product issues touch this area:

- AUR-537 proposes adding distinct human, agent, and machine-readable review modes.
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
- Make `diffwarden review` human by default.
- Make `diffwarden review --agent` the explicit agent-readable plain text path.
- Make `diffwarden review --json` and `diffwarden review --ndjson` the explicit stable structured
  contracts.
- Treat human output as presentation, not a stable parsing contract.
- Render live reviewer fan-out, reviewer state changes, warnings, failed reviewers, verdict,
  confidence, finding counts, and final finding summaries.
- Use controlled ANSI styling and small bounded redraws only when the terminal supports them.
- Degrade to plain append-only text when stdout/stderr are not TTYs, `TERM=dumb`, CI is detected,
  color is disabled, or terminal dimensions are too constrained.
- Avoid alternate screen buffers, raw mode, mouse handling, custom scroll regions, and mandatory
  keybindings.

AUR-567 should use the same visual language for discovery, but it should not depend on a full TUI.
Discovery should keep explicit JSON modes for agents and scripts. Human setup may use plain tables,
status rows, and a narrow prompt flow for explicit config changes.

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

- Preserves Diffwarden's simple agent contract while leaving room for human, agent, and schema modes
  to grow independently.
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

The renderer must never write ANSI presentation, icons, spinners, or progress frames to `--agent`,
`--json`, or `--ndjson` stdout contracts.

## Related Issues

- AUR-537: Make review modes explicit and add a human review experience.
- AUR-567: Add host-aware reviewer discovery and setup flow.
- AUR-583: Make config-mutating setup commands interactive-by-default in a TTY.

## Amendment

### 2026-07-03 — Interactive setup commands may use inline raw-mode prompts (AUR-583)

The original Decision (2026-06-13) told the human surface to "avoid alternate screen buffers,
raw mode, mouse handling, custom scroll regions, and mandatory keybindings," and said AUR-567
setup could use only "plain tables, status rows, and a narrow prompt flow." AUR-583 makes the
config-mutating setup commands interactive-by-default in a TTY, which needs arrow-key
selection, i.e. raw-mode input. This amendment narrows the raw-mode prohibition so it still
binds the review renderer but carves out a bounded exception for setup prompts.

The key distinction is surface, not aesthetics. The **review renderer** is a long-lived,
streaming display whose stdout may be captured by agents, CI, or `--json`/`--ndjson`/`--agent`
consumers; raw mode there would corrupt those contracts and risk the classic tmux/SSH/CI
failure modes. A **setup prompt** is a one-shot, human-only, explicitly-invoked config edit
with no machine contract on the affected stream — a fundamentally safer place for interactivity.

### Refined decision

- The review renderer keeps the original constraint unchanged. `runReviewEvents` /
  `runReviewBatchEvents`, the human review display, and `review show` MUST stay append-only or
  bounded-redraw, MUST NOT enter raw mode, alternate-screen buffers, mouse handling, custom
  scroll regions, or mandatory keybindings, and MUST degrade to plain text outside capable
  TTYs. The renderer must never write presentation to `--agent`, `--json`, or `--ndjson`
  stdout. Nothing here relaxes that.

- The interactive setup commands — `diffwarden init`, `reviewers add`, `reviewers edit`,
  `reviewers remove` — MAY use inline, arrow-key, raw-mode line prompts (select / multiselect /
  text redrawn in place), but only under all four guardrails:

  1. **Behind the `shouldRunInteractiveSetup` + TTY gate.** A prompt is constructed only when
     stdin is an interactive TTY and the command was invoked without any declarative signal
     (a named target id/engine, an `edit` field flag, or `--json`). This is a hard safety
     property, not a convenience: @clack/prompts calls `setRawMode`, and raw mode on a
     non-TTY pipe blocks forever. Non-TTY and `--json` paths MUST NOT reach a prompt.

  2. **Degrade to a clean, deterministic error — never a hang.** A no-target setup command in
     a non-TTY exits `2` with a usage error; `--json` never prompts and stays fully
     declarative; `--interactive` in a non-TTY exits `2` rather than blocking. There is no
     code path where the process waits on input that can never arrive.

  3. **Render to stderr; keep stdout machine-clean.** The prompt UI, hints, and picker draw to
     `stderr` (clack is pointed at `{ input: process.stdin, output: process.stderr }`). Stdout
     carries only the machine-readable result (for `--json` and downstream tooling), so a
     setup command remains scriptable even though its human path is interactive.

  4. **Still no full-screen takeover.** The carve-out is for inline raw-mode line prompts only.
     Setup commands MUST still avoid alternate-screen buffers, mouse handling, and custom
     scroll regions. Diffwarden redraws a bounded prompt region in place; it never seizes the
     whole terminal or leaves scrollback in an altered state.

### Chosen dependency

@clack/prompts (`^1.6.0`) is the picker library. It provides arrow-key `select` /
`multiselect` / `text` prompts that redraw a bounded region in place, accept a configurable
output stream (so prompts go to stderr), and expose a `cancel`/`isCancel` signal that
Diffwarden maps to Esc/Ctrl-C "step back one level" and a `✕ quit` sentinel for a hard exit.
It behaves correctly under tmux, SSH, and terminal multiplexers, where the arrow-key
navigation Diffwarden wants is exactly what plain readline prompts cannot offer. It stays
inside the existing package posture (small, no native renderer, Node `>=22.19.0` compatible),
unlike a full-screen TUI framework.

Full TUI frameworks (OpenTUI, Ink) remain deferred as recorded above; @clack/prompts is
deliberately less than a framework — a prompt primitive, not a persistent-pane UI — and does
not reopen that decision.

### Consequences of the amendment

- Setup becomes genuinely usable by hand (discover → pick → tune transport/model/effort/enabled
  → confirm) while agents and scripts keep a clean declarative, non-prompting contract on the
  same commands.
- The raw-mode ban is now surface-specific rather than global. Reviewers of future work must
  check which surface they are on: raw-mode input is allowed only in gated setup prompts,
  never in the review renderer.
- The TTY gate is load-bearing for correctness, not just UX. Any new setup entry point that
  can reach a clack prompt must route through `shouldRunInteractiveSetup` (or an equivalent
  TTY check) first, and non-TTY/`--json` must fail closed with an error.
