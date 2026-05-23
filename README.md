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
git checkout v0.1.0
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
```

Supported v1 targets:

- `uncommitted`
- `base:<branch>`
- `commit:<sha>`

When no `--reviewer` or `--reviewer-set` is provided, config must define
`defaultReviewerSet`; otherwise the CLI exits with a config-required error. For local
development and credential-free tests, pass `--reviewer fake` explicitly.

Create a starter user config with:

```bash
diffwarden init
```

## Current Status

Implemented:

- TypeScript CLI scaffold.
- Git target resolution for uncommitted, base branch, and single-commit reviews.
- Fake reviewer for credential-free development.
- Review parsing, rendering, validation, and aggregation.
- Project/user `diffwarden.config.json` discovery.
- Reviewer sets and `sdk[:profile]` reviewer specs.
- Cursor, Claude, Pi, and Droid Agent SDK adapters.
- Thin CLI transport adapters for Codex, Gemini, OpenCode, Grok, Antigravity, and CLI
  variants of Cursor, Claude, Pi, and Droid.

Not implemented:

- `pr:<number|url>` targets.
- `custom:<text>` review targets.
- GitHub PR posting or inline review comments.
- `--fail-on-findings` CI gating.
- npm publishing. GitHub source releases are available.

## Documentation

Read from top to bottom until you have enough detail:

1. `README.md` - quickstart, current status, and common commands.
2. [`docs/configuration.md`](./docs/configuration.md) - config files, reviewer sets, and
   environment defaults.
3. [`docs/adapters.md`](./docs/adapters.md) - SDK and CLI reviewer adapter behavior.
4. [`QUALITY.md`](./QUALITY.md) - lint, typecheck, test, coverage, complexity, and e2e
   commands.
5. [`SPEC.md`](./SPEC.md) - full product and architecture specification.
6. [`REFERENCES.md`](./REFERENCES.md) - upstream documentation and source-of-truth links.

## Design Principles

- Simple CLI first: agents call one command and get a review.
- SDK-agnostic internals: adapter differences stay out of core review logic.
- Codex-style review semantics and output schema.
- Structured review results first; readable Markdown by default.
- Read-only behavior by default.
- Adapter read-only guarantees must be documented explicitly.
- PR posting, GitHub review comments, and write-capable tools are permanently out of scope.
- Avoid stale docs: link to upstream SDK docs instead of copying API details here.
