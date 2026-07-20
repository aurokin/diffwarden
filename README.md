<p align="center">
  <img src="assets/logo.png" alt="diffwarden logo" width="720">
</p>

# diffwarden

A small CLI for agent-callable code review.

Diffwarden gives any coding agent one stable review command: it fans a diff out to
multiple reviewer engines, cross-checks their findings, and returns a single
machine-readable JSON artifact — without holding any API keys of its own.

<p align="center">
  <img src="https://raw.githubusercontent.com/aurokin/diffwarden/main/assets/readme-demo.gif" alt="diffwarden demo: a claude+codex review flags a P1, the fix lands, the re-run comes back clean with exit 0" width="518">
</p>

*A real session: two reviewers flag a planted P1, the fix lands, and the same command
comes back green with `exit 0`.*

## Quick Start

Requires Node `>=22.19.0`. Developed and tested on macOS and Linux; Windows is untested —
the CLI contains Windows-specific handling but it has not been validated.

From any Git checkout, run guided setup. `init` probes installed executables, SDK
packages, and auth signals to discover which reviewer engines this host can already run,
then writes a user config — all without running a review or spending model budget:

```bash
npx --yes diffwarden@latest init
```

Then run a real review against your configured reviewers:

```bash
npx --yes diffwarden@latest review --target base:main
```

With a permanent install (below), the same command is just `diffwarden review --target base:main`.

Reviews bill against your existing engine subscriptions or API keys; Diffwarden holds no
keys of its own and never bills you directly. Duration and cost vary by engine, model, and
diff size.

For a permanent install, use npm:

```bash
npm install --global diffwarden
diffwarden --version
```

To verify a specific reviewer's runtime, auth, model, and effort settings, or to force the
discovery scaffold:

```bash
diffwarden init --discover   # force the discovery scaffold
diffwarden doctor --reviewer-set 1
diffwarden doctor --reviewer claude
diffwarden review --target base:main --reviewer claude
```

Agents should opt into direct text output with `--agent`:

```bash
diffwarden review --target base:main --agent
```

### Development and CI Smoke Tests

The built-in `fake` reviewer runs a credential-free review, useful for smoke-testing the
pipeline in CI or local development without any engine installed:

```bash
diffwarden review --target uncommitted --reviewer fake
diffwarden review --target uncommitted --reviewer fake --agent
```

For local development from a source checkout:

```bash
git clone https://github.com/aurokin/diffwarden.git
cd diffwarden
pnpm install
pnpm build
pnpm dev -- review --target uncommitted --reviewer fake
```

## Why Not Your Agent's Built-In Review?

Built-in review commands ask the same model that wrote the code to judge it. Diffwarden
provides an independent second opinion across engines: multiple reviewers see the same
diff, and their findings are cross-checked and aggregated. The output is a stable
machine-readable contract any agent or CI gate can consume, the review path is read-only
by design, and Diffwarden never holds credentials — reviewers use the auth you already
have. See [`docs/comparisons.md`](./docs/comparisons.md) for the full argument.

## Common Commands

```bash
diffwarden review --target uncommitted --reviewer fake
diffwarden review --target base:main --reviewer cursor
diffwarden review --target base:main --reviewer claude --model sonnet --effort high
diffwarden review --target base:main --reviewer pi --model anthropic/claude-sonnet-4-5
diffwarden review --target base:main --reviewer droid-cli --model claude-opus-4-7
diffwarden review --target base:main --reviewer-set 2
diffwarden review --target base:main --reviewer cursor --reviewer pi:openrouter-high
diffwarden review --target commit:abc123 --json
diffwarden review --target base:main --reviewer-set 2 --agent
diffwarden review --target base:main --reviewer-set 2 --agent --focus "focus on state management" --focus "focus on localization"
diffwarden review --target base:main --reviewer-set 2 --agent --no-overview --focus "focus on state management"
diffwarden review --target base:main --reviewer-set 2 --report
diffwarden review --target base:main --reviewer-set 2 --fail-on-findings P2
diffwarden review show review.json
```

Examples above mix flagship engines (`claude`, `codex` — fully supported and live-tested)
with experimental engines (`cursor`, `pi`, `droid`, and others — functional, best-effort);
see [Current Status](#current-status) for the tier breakdown.

Verify reviewer runtime, auth, model, and effort settings without reviewing a diff:

```bash
diffwarden doctor --reviewer cursor --model composer-2.5
diffwarden doctor --reviewer claude --model sonnet --effort high
diffwarden doctor --reviewer pi --model anthropic/claude-sonnet-4-5
```

List configured reviewers and reviewer sets without running preflight checks:

```bash
diffwarden reviewers list
diffwarden reviewers list --json
```

Probe the host for usable reviewer engines, then add, edit, or remove reviewers in the user
config. Discovery never runs a review or spends model budget; `--deep` additionally runs adapter
preflight:

```bash
diffwarden reviewers discover
diffwarden reviewers discover --deep
diffwarden reviewers discover --json
diffwarden reviewers add codex
diffwarden reviewers add claude --transport cli --set 1
diffwarden reviewers edit codex --model gpt-5.1-codex
diffwarden reviewers set add 1 codex
diffwarden reviewers set remove 1 codex
diffwarden reviewers remove codex
```

`add`, `edit`, `remove`, and `set` all write only the env-located user config (never the project
config), atomically. Removing a reviewer also prunes it from every reviewer set; `remove` and
`set remove` refuse to leave `defaultReviewerSet` empty unless you pass `--force`. In a TTY, the
config-mutating commands are interactive by default: a bare `add` opens an arrow-key multiselect
of discovered reviewers that aren't already configured and walks each through a field editor for
transport, model, effort, and the reviewer id; a bare `edit` (or `edit <id>` with no field flags)
opens a field editor for a configured reviewer's transport, model, effort, and enabled state; and
`remove` picks a reviewer and confirms (default No).
Esc or Ctrl-C steps back one level (cancelling at the top) and a `✕ quit` choice exits immediately;
submitting a blank model or choosing `default` effort clears that override back to the engine
default. Prompts render to stderr, so stdout stays machine-clean. Naming a target (an engine for
`add`, an id for `remove`/`edit`), passing a field flag to `edit`, passing `--json`, or running
non-interactively stays declarative and never prompts.

Supported v1 targets:

- `uncommitted`
- `base:<branch>`
- `commit:<sha>`
- `custom:<text>`

`custom:<text>` is for repository-scoped review instructions rather than a precomputed
patch. It still runs reviewer preflight, prompt assembly, parsing, schema validation,
path validation, aggregation, and rendering, but it does not collect a diff, populate
`changed_files`, embed a patch fence in the prompt, or validate findings against
changed-line overlap.

Use repeatable `--focus <text>` when you want scoped lanes over the same diff-backed
target:

```bash
diffwarden review --target base:main --reviewer-set 2 --agent \
  --focus "focus on state management" \
  --focus "focus on localization"

diffwarden review --target base:main --reviewer-set 2 --agent \
  --no-overview \
  --focus "focus on state management"
```

Focus lanes are still diff-backed reviews. They reuse one resolved target diff, embed the
same patch provenance, and validate findings against changed lines. When focus lanes are
present, Diffwarden includes the normal overview lane by default; use `--no-overview` for
focus-only runs or `--overview` to override config that disables the overview lane.
`custom:<text>` remains the repository-scoped audit target and is not compatible with
`--focus`.

When no `--reviewer` or `--reviewer-set` is provided, config must define
`defaultReviewerSet`; otherwise the CLI exits with a config-required error. For local
development and credential-free tests, pass `--reviewer fake` explicitly. Create a user
config with `diffwarden init` (see [Quick Start](#quick-start)).

## Review Output Modes

`diffwarden review` defaults to a human-facing terminal display. Output modes are explicit:

| Mode | Stable machine contract? | What stdout receives |
| --- | --- | --- |
| default | No | Human review display with progress and final summary |
| `--agent` | Human-readable, agent-oriented | Plain text final summary optimized for coding agents |
| `--json` | Yes | One final review artifact JSON object after every reviewer finishes |
| `--ndjson` | Yes (versioned event stream) | Newline-delimited review events as work progresses |

`--agent` and `--json` are final-result-only: stdout stays quiet until aggregation
completes. `--agent` avoids ANSI, spinners, and framing so coding agents can read findings
without parsing terminal presentation.

`--ndjson` streams typed review events for incremental consumers (agents, CI). Each line is
one JSON event carrying `schema_version: 2`:

```bash
diffwarden review --target base:main --reviewer-set 2 --ndjson
```

```json
{"schema_version":2,"type":"run_started","cwd":"…","target":{…},"reviewers":[{"id":"pi","engine":"pi"}]}
{"schema_version":2,"type":"preflight_started","reviewer_id":"pi"}
{"schema_version":2,"type":"preflight_finished","reviewer_id":"pi","ok":true,"timing_ms":120}
{"schema_version":2,"type":"reviewer_started","reviewer_id":"pi"}
{"schema_version":2,"type":"reviewer_result","reviewer_id":"pi","provisional":true,"artifact":{…}}
{"schema_version":2,"type":"final_result","artifact":{…}}
```

The stream ends with exactly one terminal frame: `final_result` (the authoritative
aggregated artifact, equivalent to `--json`) or `error`. `reviewer_result` events are
provisional and pre-aggregation. Focus runs carry a `ReviewBatchArtifact` with lane-scoped
events. Full event-stream guarantees, ordering rules, and batch NDJSON behavior are
documented in [`docs/agent-workflows.md`](./docs/agent-workflows.md#ndjson-event-stream-guarantees).

### Debugging Reviewer Output (opt-in)

Normal artifacts stay token-efficient by design: reviewer output is reduced to findings,
verdicts, validation, and limited diagnostics. To inspect what a reviewer transport actually
printed, opt in with `--debug-reviewer-output`:

```bash
diffwarden review --target base:main --reviewer droid-cli --debug-reviewer-output --out review.json
diffwarden review --target base:main --reviewer droid-cli --ndjson --debug-reviewer-output
```

Reviewer artifacts gain a bounded `debug_output` field with stdout/stderr transcripts, and
with `--ndjson` bounded debug events stream live while the reviewer runs. Debug output is
the raw transport transcript and can echo prompt fragments and file contents, so treat it
as a local debugging aid rather than something to ship to CI logs by default. Per-adapter
capture behavior, stream modes, and budgets are documented in
[`docs/features.md`](./docs/features.md#debugging-reviewer-output).

## Stability

The `--json` artifact and NDJSON frames carry `schema_version`. Additive fields may appear
at any time within a schema version; consumers must ignore unknown fields. Breaking shape
changes bump `schema_version` and are called out in release notes. Exit codes and
documented flags are stable. Human render output is explicitly not parseable or stable.
Pre-1.0, a semver minor release may include a `schema_version` bump.

Human progress (not a contract): in `--json` mode, when stderr is a TTY, diffwarden prints
per-reviewer progress lines to **stderr** so long multi-reviewer runs are not silent. This
is purely informational, is suppressed when stderr is not a TTY (pipes, CI), and never
appears in `--agent` or `--ndjson` mode. Only stdout carries the stable contracts.

## Human Review Display

Use `diffwarden review` when a person wants to watch or inspect a run:

```bash
diffwarden review --target base:main --reviewer-set 2
diffwarden review --target uncommitted --reviewer fake --out review.json
diffwarden review show review.json
diffwarden review show review.json --agent
```

The review display is intentionally not a stable parsing contract. It renders reviewer
fan-out, preflight/run status, warnings, failed reviewers, verdict, confidence, and finding
summaries for humans. It avoids full-screen terminal behavior and falls back to plain text
outside capable TTYs. Use `--agent`, `--json`, `--ndjson`, or `--out` when an agent or
script needs data. `review show` can render a saved artifact as human display, `--agent`, or
`--json`; it does not support `--ndjson` because there is no live event stream to replay.

## Review History Reports

Reports are opt-in. Use `--report` to persist an analysis-friendly JSON record of a run:

```bash
diffwarden review --target base:main --reviewer-set 2 --report
diffwarden review --target custom:"Review auth paths" --reviewer pi --report --report-scope repo
diffwarden review --target uncommitted --reviewer fake --report --report-dir ./tmp/reports
```

Reports include the cwd, target mode, custom instructions for `custom:<text>` targets,
Diffwarden version, invocation options, config path/hash when a config is loaded, requested
and resolved reviewers, reviewer engine/transport/model metadata, adapter/preflight metadata,
adapter usage data when available, per-reviewer elapsed time and findings, failure summaries,
and precomputed finding counts. Diff-backed reports store a stable SHA-256 hash and byte count
for the reviewed patch; the patch text itself is not persisted in report provenance.

The default global store is under the user state directory; repo-scoped reports go under
`.diffwarden/reports/`. Reports may contain review text that echoes source or diff content,
so they are never written unless explicitly enabled by CLI or config. `--out` still writes one
requested review artifact; `--report` appends durable history.

For focus runs, full reports include the full `ReviewBatchArtifact`. Metadata reports record
the requested focus strings, overview inclusion, resolved lane plan, shared diff hash/byte
provenance, and per-lane status/count summaries without embedding finding bodies or patch
text.

## Agent Skill

Diffwarden includes a reusable skill for agents that want to call the installed CLI from
another repository:

```text
skills/diffwarden/
```

This skill is for agents using Diffwarden, not for agents developing this repo. Consumers
should install it with the Skills CLI so their agent-specific skill directories and lockfiles
stay consistent:

```bash
npx skills add aurokin/diffwarden --global --skill diffwarden --agent codex claude-code --full-depth
```

For local Diffwarden development, symlink the checkout skill into the local agent skill
directories instead. This keeps skill edits live without reinstalling from a release:

```bash
pnpm install:skill
```

The local installer links `skills/diffwarden/` into `~/.agents/skills/diffwarden` and
`~/.claude/skills/diffwarden`. If `~/code/custom_skills` exists, it also adds
`diffwarden` to `.skills.local.json` `preserveGlobalSkillNames` so that repo's global sync
does not remove the manually linked development skill.

## Current Status

Diffwarden supports two tiers of reviewer engines:

- **Flagship (fully supported):** `claude` and `codex`. These engines are live-tested and
  are the recommended defaults for real reviews.
- **Experimental (functional, best-effort):** `cursor`, `pi`, `droid`, `copilot`,
  `gemini`, `opencode`, `grok`, and `antigravity`. These adapters work through the same
  review pipeline but receive less live testing; expect rougher edges.

The built-in `fake` reviewer is a credential-free test engine for development and CI, not
part of either tier.

Every engine shares the same target resolution, review prompting, parsing, validation,
aggregation, and output contract. Publishing review comments to external services is
permanently out of scope.

## Security

See [`SECURITY.md`](./SECURITY.md) for the security policy and how to report vulnerabilities.

## Documentation

Read from top to bottom until you have enough detail:

1. `README.md` - quickstart, current status, and common commands.
2. [`docs/consumer-context.md`](./docs/consumer-context.md) - consumer audience, docs
   boundaries, and where setup guidance belongs.
3. [`docs/agent-workflows.md`](./docs/agent-workflows.md) - prompt patterns and raw
   examples for using Diffwarden as an agent review gate.
4. [`docs/comparisons.md`](./docs/comparisons.md) - Codex review comparison and SDK vs CLI
   transport tradeoffs.
5. [`docs/features.md`](./docs/features.md) - supported reviewer feature matrix.
6. [`docs/configuration.md`](./docs/configuration.md) - config files, reviewer sets, and
   environment defaults.
7. [`docs/adapters.md`](./docs/adapters.md) - SDK and CLI reviewer adapter behavior.
8. [`docs/macos.md`](./docs/macos.md) - macOS executable trust and performance triage.
9. [`docs/release.md`](https://github.com/aurokin/diffwarden/blob/main/docs/release.md) - GitHub and npm release process (repository only; not shipped in the npm package).
10. [`QUALITY.md`](./QUALITY.md) - lint, typecheck, test, coverage, complexity, and e2e
   commands.
11. [`SPEC.md`](./SPEC.md) - full product and architecture specification.
12. [`REFERENCES.md`](./REFERENCES.md) - upstream documentation and source-of-truth links.

## Design Principles

- Simple CLI first: agents call one command and get a review.
- SDK-agnostic internals: adapter differences stay out of core review logic.
- Codex-style review semantics and output schema.
- Light Greptile influence on CLI shape: command surfaces should leave room for
  human, agent, and machine-readable review modes to grow independently.
- Human review by default under `review`; explicit `--agent`, `--json`, and `--ndjson`
  modes for non-human callers.
- Read-only behavior by default.
- Adapter read-only guarantees must be documented explicitly.
- External comment publishing and write-capable tools are permanently out of scope.
- Avoid stale docs: link to upstream SDK docs instead of copying API details here.
