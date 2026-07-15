<p align="center">
  <img src="assets/logo.png" alt="diffwarden logo" width="720">
</p>

# diffwarden

A small CLI for agent-callable code review.

`diffwarden` lets coding agents request a review of local changes, a branch diff, or a
single commit, then receive human display output, agent-readable text, or structured JSON
findings. The CLI owns target resolution, review prompting, parsing, validation, and
rendering; reviewer SDKs and CLIs stay behind adapters.

## Quick Start

Requires Node `>=22.19.0`.

Install the published CLI from npm:

```bash
npm install --global diffwarden
diffwarden --version
```

For a one-off run without a global install:

```bash
npx --yes diffwarden@latest --version
```

From any Git checkout, run a credential-free smoke review:

```bash
diffwarden review --target uncommitted --reviewer fake
```

That command renders the human review display. Agents should opt into direct text output:

```bash
diffwarden review --target uncommitted --reviewer fake --agent
```

For real reviews, use an installed and authenticated reviewer. Replace `pi` with the
reviewer you want to use:

```bash
diffwarden doctor --reviewer pi
diffwarden review --target base:main --reviewer pi
```

On a fresh machine, find out which reviewers this host can already run before configuring
anything. Discovery probes installed executables, SDK packages, and auth signals without
running a review or spending model budget:

```bash
diffwarden reviewers discover
```

Then create a user config so you can run Diffwarden without passing reviewers on every
command. In a terminal, a bare `diffwarden init` walks you through discovery; pass `--json` or
run non-interactively for a static starter:

```bash
diffwarden init              # in a TTY: guided discovery; non-TTY or --json: static starter
diffwarden init --discover   # force the discovery scaffold
diffwarden doctor --reviewer-set 1
diffwarden review --target base:main
```

For local development from a source checkout:

```bash
git clone https://github.com/aurokin/diffwarden.git
cd diffwarden
pnpm install
pnpm build
pnpm dev -- review --target uncommitted --reviewer fake
```

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
development and credential-free tests, pass `--reviewer fake` explicitly.

Create a starter user config with:

```bash
diffwarden init
```

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

No-focus event-stream guarantees:

- Once `run_started` is emitted, the stream always ends with **exactly one** terminal
  frame: `final_result` (authoritative aggregated `ReviewArtifact`) or `error` (an expected
  terminal failure such as all reviewers failing or a strict-mode violation).
- `reviewer_result` events are **provisional** (`provisional: true`): their findings are
  pre-aggregation and are not yet deduplicated or merged across reviewers. Only
  `final_result.artifact` is authoritative; treat it as the equivalent of `--json`.
- Under concurrency, `reviewer_result`/`reviewer_failed` arrive in completion order, but
  the `reviewers` array in `final_result.artifact` always follows selection order.
- `--out`, `--report`, and `--fail-on-findings` operate on the final artifact and behave
  identically across formats. In `ndjson` mode a terminal `error` frame is emitted and the
  process exits non-zero without throwing, so the stream stays a clean sequence of frames.

For focus runs, stdout carries a `ReviewBatchArtifact` instead. Batch NDJSON starts with
`batch_started`, emits lane-scoped lifecycle events with `lane_id`, emits `lane_finished` or
`lane_failed`, and still terminates with exactly one `final_result` carrying the full batch
artifact or one `error`. Normal no-focus NDJSON remains unchanged.

### Debugging Reviewer Output (opt-in)

Normal artifacts stay token-efficient by design: reviewer output is reduced to findings,
verdicts, validation, and limited diagnostics. To inspect what a reviewer transport actually
printed, opt in with `--debug-reviewer-output`:

```bash
diffwarden review --target base:main --reviewer droid-cli --debug-reviewer-output --out review.json
diffwarden review --target base:main --reviewer droid-cli --ndjson --debug-reviewer-output
```

- Each CLI-transport reviewer artifact gains a bounded `debug_output` field with separate
  `stdout`/`stderr` transcripts, total byte counts, and per-stream truncation flags. Budget:
  256 KiB per stream per reviewer (retried runs share the budget, so the failing first
  attempt is preserved). Transports that cannot expose raw output simply omit the field.
- With `--ndjson`, bounded `reviewer_debug_output` events additionally stream while the
  reviewer runs (up to 8 KiB of text per event; a final event with `truncated: true` marks
  an exhausted stream budget). These events are non-authoritative and never affect results,
  validation, gating, exit codes, or the terminal-frame guarantee. Consumers must ignore
  unknown fields on NDJSON events; new optional fields are additive within a schema version.
- When both `--ndjson` and `--debug-reviewer-output` are set, adapters with a native stream
  output mode switch to it so debug events arrive live instead of at process exit: Claude
  CLI runs with `--output-format stream-json --verbose`, and Cursor and Droid with
  `--output-format stream-json` (support is probed first; CLIs without the mode silently
  stay on `json`, recorded as `debugStreamModeDropped` in reviewer metadata). Stream events
  are rendered as compact one-line summaries — assistant text verbatim, tool activity as
  `[tool_use ...]`-style markers, reasoning/thinking content excluded — and the final
  review result is extracted from the stream so the artifact parses identically to
  non-stream runs. In stream mode the artifact's `debug_output.stdout` records those same
  summaries rather than the raw JSONL (which embeds reasoning content and would waste the
  bounded budget), so the artifact transcript matches the streamed events. Unparseable stream output degrades to raw passthrough; stream problems
  never fail the review. Without `--ndjson`, invocations are unchanged even when
  `--debug-reviewer-output` is set.
- Codex app-server reviewers capture debug output only in `stdio-isolated` mode:
  notification summaries in the same one-line format feed `debug_output.stdout` (completed
  agent messages verbatim, other items as `[item:<type>]` markers, server requests as
  `[request <method> -> <decision>]` notes, deltas/token usage/reasoning excluded), and the
  isolated child's stderr is teed raw into `debug_output.stderr`. The shared-server modes
  (`attach`/`auto`/`launch`) are asymmetric: they talk to a daemon over a socket, so there
  is no child stderr to tee, and event capture is withheld entirely — recorded as
  `debugOutputDropped: "shared-server-unverified"` in reviewer metadata — until thread
  scoping of shared-daemon notifications is verified against a live attach-mode capture.
- Without the flag, artifacts and event streams are byte-identical to today.

Sensitivity: debug output is the raw transport transcript. It can contain more context than
the normalized artifact — prompt fragments, file contents, provider diagnostics — so treat
it as a local debugging aid, not something to commit or ship to CI logs by default.
`--report-mode full` reports embed the artifact (including `debug_output` when opted in);
`--report-mode metadata` reports never do.

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

Implemented:

- TypeScript CLI scaffold.
- Git target resolution for uncommitted, base branch, and single-commit reviews.
- Custom instruction targets for repository-scoped reviews.
- Fake reviewer for credential-free development.
- Review parsing, rendering, validation, and aggregation.
- Diff-backed focus lanes with optional overview and batch artifacts.
- Opt-in review history reports.
- Project/user `diffwarden.config.json` discovery.
- Host-aware reviewer discovery and config setup (`reviewers discover`, `reviewers add`,
  `init --discover`).
- Reviewer sets and `engine[:profile]` reviewer specs.
- Cursor, Claude, Pi, Droid, and GitHub Copilot SDK adapters.
- Codex app-server transport with shared server reuse, structured review mode, and
  ephemeral read-only threads.
- Thin CLI transport adapters for Codex, Gemini, OpenCode, Grok, Antigravity, GitHub
  Copilot, and CLI variants of Cursor, Claude, Pi, and Droid.
- npm publishing for the `diffwarden` CLI package.

Not implemented:

- Publishing review comments to external services.

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
9. [`docs/release.md`](./docs/release.md) - GitHub and npm release process.
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
