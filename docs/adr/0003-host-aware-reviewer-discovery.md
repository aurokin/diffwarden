# ADR 0003: Host-Aware Reviewer Discovery and Setup

## Status

Accepted, 2026-06-24

## Context

Diffwarden supports eleven reviewer engines across SDK, CLI, and app-server transports, each
with its own executable, npm package, and authentication story. A new user on a fresh machine
has no way to learn which of those engines they can actually run short of editing config by
hand and running `diffwarden doctor` against guesses. `doctor` answers "will this configured
reviewer run?" and `reviewers list` answers "what is configured?", but neither answers the
first question a new user asks: "what could this host run at all?"

The driving constraints, from AUR-567:

- Agents must be able to read the result without spending model tokens or running a review.
- Humans should get a readable summary without a full terminal UI (see ADR 0001).
- Setup must never silently change who reviews a patch (for example by flipping
  `defaultReviewerSet`).
- The read-only, no-spend default posture of the tool must be preserved.

## Decision

Add a host-aware discovery path and an explicit setup path, kept as distinct commands so the
read-only probe never implies a config write.

### Commands and flags

- `diffwarden reviewers discover [--deep] [--json]` — probe the host and classify each
  reviewer candidate. Read-only with respect to config; never runs a review.
- `diffwarden reviewers add [engine] [--id] [--transport] [--model] [--effort] [--provider]
  [--set] [--disabled] [--interactive]` — write one reviewer to the user config.
- `diffwarden init --discover [--interactive]` — scaffold a fresh user config from discovered,
  ready-to-use reviewers.

`discover`, `list`, and `doctor` form a deliberate three-question split: *what could run*,
*what is configured*, *will the configured set run*.

### Probe tiers

Discovery is shallow by default and uses only token-free probes: executable presence on
`PATH`, side-effect-free SDK package resolution, environment-variable presence, and
credential-file readability. `--deep` is opt-in and additionally runs the same adapter
preflight as `doctor`, which may spawn CLIs or call provider APIs. This keeps the default fast,
offline, and safe for agents, while letting a human escalate to real verification when they
want it. Deep preflight is injected into the discovery core (rather than called directly) so the
spawn path is reused from `doctor` and the result-mapping stays pure and unit-testable.

### Classification taxonomy

Each candidate gets a `status` of `available`, `missing_executable`, `missing_auth`,
`requires_env`, `unsupported_host`, or `preflight_failed`, plus an `authState` of `verified`,
`unverified`, `missing`, or `not_required`. Shallow probing can only produce the first four
statuses; `unsupported_host` and `preflight_failed` come from `--deep` preflight mapping. Only
`available` candidates carry a recommended config entry.

### Auth metadata lives in the capability registry

The per-engine auth signals (which environment variables to check, which credential file to
look for and how to resolve it, whether the engine delegates login, whether env vars are
optional) live in `src/adapters/capabilities.ts` next to the adapter capabilities, not in the
discovery module. Discovery reads them. This keeps a single source of truth and prevents the
discovery classifier from drifting away from adapter behavior.

### Writes target the user config only, and never the default set

`reviewers add` and `init --discover` are the only commands that write reviewer config, and
they always write the user config path
(`$XDG_CONFIG_HOME/diffwarden/diffwarden.config.json`), never a project config or any
repository file. Writes are atomic (temp file plus rename) with a SHA-256 compare-and-swap
guard. `reviewers add` merges by `id` in place, preserves every other key, and appends an id to
a named set only when `--set` is given. Neither command changes `defaultReviewerSet` for an
existing config. Adding a reviewer therefore never silently changes who reviews a patch.

### Output respects the existing contracts

JSON discovery output uses `schema_version: 1` and reports the probed environment-variable
names and credential-file paths but never secret values. The human display reuses the
frameworkless renderer vocabulary from ADR 0001 (grouped status rows, status glyphs, NO_COLOR
and non-TTY fallback); it is presentation, not a parsing contract.

### Interactive ships in this issue, implemented last

`--interactive` is part of this issue but is the final slice. It selects and confirms before
writing, is built on `node:readline` only (no TUI dependency, consistent with ADR 0001), and
requires a TTY: it exits `2` when stdin is not interactive so CI and piped callers fail fast
with a clear message rather than hanging.

## Consequences

Positive consequences:

- A new user can go from a fresh checkout to a working config without hand-editing JSON:
  `discover` → `init --discover` (or `reviewers add`) → `doctor` → `review`.
- Agents can read discovery output to reason about host capability without spending tokens.
- Auth knowledge stays in one place, shared by adapters and discovery.
- The read-only/no-spend default is preserved; the only writers are explicit setup commands
  scoped to the user config.

Tradeoffs:

- Discovery adds a fourth reviewer-introspection surface alongside `list`, `doctor`, and
  config loading.
- Shallow probing reports capability, not a guarantee; a candidate marked `available` can still
  fail a real run. `--deep` exists to close that gap when a user wants certainty.
- The capability registry now carries auth metadata in addition to transport capabilities,
  growing its surface.

## Related Issues

- AUR-567: Add host-aware reviewer discovery and setup flow.
