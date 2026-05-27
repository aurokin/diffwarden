<p align="center">
  <img src="skills/diffwarden/assets/logo.png" alt="diffwarden logo" width="720">
</p>

# diffwarden

A small CLI for agent-callable code review.

`diffwarden` lets coding agents request a review of local changes, a branch diff, or a
single commit, then receive Markdown or structured JSON findings. The CLI owns target
resolution, review prompting, parsing, validation, and rendering; reviewer SDKs and CLIs
stay behind adapters.

## Quick Start

Install from the GitHub source release or a local checkout:

```bash
git clone https://github.com/aurokin/diffwarden.git
cd diffwarden
git checkout v0.2.7
pnpm install
pnpm build
pnpm link --global
diffwarden --version
```

For local development without installing the binary:

```bash
pnpm install
pnpm build
pnpm dev -- --target uncommitted --reviewer fake
```

The project requires Node `>=22.19.0`.

## Common Commands

```bash
diffwarden --target uncommitted --reviewer fake
diffwarden --target base:main --reviewer cursor
diffwarden --target base:main --reviewer claude --model sonnet --effort high
diffwarden --target base:main --reviewer pi --model anthropic/claude-sonnet-4-5
diffwarden --target base:main --reviewer droid-cli --model claude-opus-4-7
diffwarden --target base:main --reviewer-set 2
diffwarden --target base:main --reviewer cursor --reviewer pi:openrouter-high
diffwarden --target commit:abc123 --format json
diffwarden --target base:main --reviewer-set 2 --report
diffwarden --target base:main --reviewer-set 2 --fail-on-findings P2
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
diffwarden reviewers list --format json
```

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

When no `--reviewer` or `--reviewer-set` is provided, config must define
`defaultReviewerSet`; otherwise the CLI exits with a config-required error. For local
development and credential-free tests, pass `--reviewer fake` explicitly.

Create a starter user config with:

```bash
diffwarden init
```

## Output Formats

`--format` selects how results are written to **stdout**:

| Format | Stable machine contract? | What stdout receives |
| --- | --- | --- |
| `markdown` (default) | Human-readable, not a parsing contract | One rendered report after every reviewer finishes |
| `json` | Yes | One final `ReviewArtifact` JSON object after every reviewer finishes |
| `ndjson` | Yes (versioned event stream) | Newline-delimited review events as work progresses |

`markdown` and `json` are final-result-only and unchanged: stdout stays empty until
aggregation completes. They remain the right choice when you only need the finished
artifact.

`ndjson` streams typed review events for incremental consumers (agents, CI). Each line is
one JSON event carrying `schema_version: 2`:

```bash
diffwarden --target base:main --reviewer-set 2 --format ndjson
```

```json
{"schema_version":2,"type":"run_started","cwd":"…","target":{…},"reviewers":[{"id":"pi","engine":"pi"}]}
{"schema_version":2,"type":"preflight_started","reviewer_id":"pi"}
{"schema_version":2,"type":"preflight_finished","reviewer_id":"pi","ok":true,"timing_ms":120}
{"schema_version":2,"type":"reviewer_started","reviewer_id":"pi"}
{"schema_version":2,"type":"reviewer_result","reviewer_id":"pi","provisional":true,"artifact":{…}}
{"schema_version":2,"type":"final_result","artifact":{…}}
```

Event-stream guarantees:

- Once `run_started` is emitted, the stream always ends with **exactly one** terminal
  frame: `final_result` (authoritative aggregated `ReviewArtifact`) or `error` (an expected
  terminal failure such as all reviewers failing or a strict-mode violation).
- `reviewer_result` events are **provisional** (`provisional: true`): their findings are
  pre-aggregation and are not yet deduplicated or merged across reviewers. Only
  `final_result.artifact` is authoritative — treat it as the equivalent of `--format json`.
- Under concurrency, `reviewer_result`/`reviewer_failed` arrive in completion order, but
  the `reviewers` array in `final_result.artifact` always follows selection order.
- `--out`, `--report`, and `--fail-on-findings` operate on the final artifact and behave
  identically across formats. In `ndjson` mode a terminal `error` frame is emitted and the
  process exits non-zero without throwing, so the stream stays a clean sequence of frames.
- `--verbose` only shapes `markdown` and is rejected together with `--format ndjson`.

Human progress (not a contract): when stdout is `markdown` or `json` **and stderr is a
TTY**, diffwarden prints per-reviewer progress lines to **stderr** so long multi-reviewer
runs are not silent. This is purely informational, is suppressed when stderr is not a TTY
(pipes, CI), and never appears in `ndjson` mode. Only stdout carries the stable contracts.

## Review History Reports

Reports are opt-in. Use `--report` to persist an analysis-friendly JSON record of a run:

```bash
diffwarden --target base:main --reviewer-set 2 --report
diffwarden --target custom:"Review auth paths" --reviewer pi --report --report-scope repo
diffwarden --target uncommitted --reviewer fake --report --report-dir ./tmp/reports
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
requested `ReviewArtifact`; `--report` appends durable history.

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
- Opt-in review history reports.
- Project/user `diffwarden.config.json` discovery.
- Reviewer sets and `engine[:profile]` reviewer specs.
- Cursor, Claude, Pi, and Droid Agent SDK adapters.
- Experimental Codex app-server transport with shared server reuse and ephemeral read-only
  threads.
- Thin CLI transport adapters for Codex, Gemini, OpenCode, Grok, Antigravity, and CLI
  variants of Cursor, Claude, Pi, and Droid.

Not implemented:

- Publishing review comments to external services.
- npm publishing. GitHub source releases are available.

## Documentation

Read from top to bottom until you have enough detail:

1. `README.md` - quickstart, current status, and common commands.
2. [`docs/comparisons.md`](./docs/comparisons.md) - Codex review comparison and SDK vs CLI
   transport tradeoffs.
3. [`docs/features.md`](./docs/features.md) - supported reviewer feature matrix.
4. [`docs/configuration.md`](./docs/configuration.md) - config files, reviewer sets, and
   environment defaults.
5. [`docs/adapters.md`](./docs/adapters.md) - SDK and CLI reviewer adapter behavior.
6. [`docs/macos.md`](./docs/macos.md) - macOS executable trust and performance triage.
7. [`QUALITY.md`](./QUALITY.md) - lint, typecheck, test, coverage, complexity, and e2e
   commands.
8. [`SPEC.md`](./SPEC.md) - full product and architecture specification.
9. [`REFERENCES.md`](./REFERENCES.md) - upstream documentation and source-of-truth links.

## Design Principles

- Simple CLI first: agents call one command and get a review.
- SDK-agnostic internals: adapter differences stay out of core review logic.
- Codex-style review semantics and output schema.
- Structured review results first; readable Markdown by default.
- Read-only behavior by default.
- Adapter read-only guarantees must be documented explicitly.
- External comment publishing and write-capable tools are permanently out of scope.
- Avoid stale docs: link to upstream SDK docs instead of copying API details here.
