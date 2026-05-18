# diffwarden

A small CLI for agent-callable code review.

`diffwarden` lets coding agents request a review of local changes, a branch diff, a single commit, or eventually a read-only PR target, then receive Markdown or structured JSON findings. The CLI owns target resolution, review prompting, parsing, validation, and rendering; reviewer SDKs live behind adapters.

## Intended public contract

```bash
diffwarden --target base:main
diffwarden --target uncommitted --reviewer cursor
diffwarden --target base:main --reviewer claude
diffwarden --target base:main --reviewer pi
diffwarden --target base:main --reviewer claude --model sonnet --effort high
diffwarden --target commit:abc123
diffwarden --target base:main --format json
diffwarden --target base:main --reviewer-set 2
diffwarden --target base:main --reviewer cursor --reviewer pi:openrouter-high
```

## Read order

1. [`SPEC.md`](./SPEC.md) — product and architecture specification.
2. [`REFERENCES.md`](./REFERENCES.md) — upstream documentation and source-of-truth links.

## Current status

Initial TypeScript scaffold is implemented with target resolution, fake reviewer plumbing, review parsing/rendering/validation, and a Cursor Agent SDK adapter. The planned public GitHub repository is `aurokin/diffwarden`, and the CLI binary name is `diffwarden`; npm publishing is not part of the current plan.

The intended v1 target surface is:

- `uncommitted`
- `base:<branch>`
- `commit:<sha>`

`--format json` prints the full `ReviewArtifact`, including reviewers, target, result, validation, and timing metadata.

## Cursor reviewer

The Cursor adapter is available with:

```bash
diffwarden --target uncommitted --reviewer cursor
```

It requires `CURSOR_API_KEY` in the environment. For local development with zsh-based dotfiles, an interactive shell may be needed if the key is exported from `.zshrc`:

```bash
zsh -lic 'pnpm dev -- --target uncommitted --reviewer cursor'
```

The opt-in live smoke test is:

```bash
zsh -lic 'INTEGRATION_TEST_ON=1 pnpm vitest run test/cursor-adapter.test.ts'
```

The adapter uses `@cursor/sdk`. That SDK currently depends on `sqlite3`, so `package.json` allows pnpm to run the `sqlite3` build script through `pnpm.onlyBuiltDependencies`.

The intended v1 reviewer surface is the Cursor Agent SDK, Claude Agent SDK, and Pi Agent SDK. Adapters should use SDKs directly, not shell out to agent executables as the primary integration path.

Configuration is required for real SDK runs. The default reviewer should be a configured Pi profile because Pi supports the broadest provider surface. Claude subscription users should configure the Claude Agent SDK, Cursor subscription users should configure the Cursor Agent SDK, and other providers should generally route through Pi profiles.

Model selection is a base CLI option via `--model`. Effort, provider, and SDK-specific settings are represented as reviewer config. Simple single-reviewer runs can use flags like `--model` and `--effort`; multi-reviewer/provider-heavy runs should use named profiles like `pi:openrouter-high`.

Invalid model and effort selections should fail clearly. Missing SDK/runtime requirements, missing SDK-required executables, missing auth, provider setup failures, timeouts, and SDK execution failures should also fail gracefully with specific error messages.

## Design principles

- Simple CLI first: agents call one command and get a review.
- SDK-agnostic internals: Cursor, Claude, and Pi adapters share one review contract.
- Codex-style review semantics and output schema.
- Structured review results first; readable Markdown by default.
- Read-only by default.
- Adapter read-only guarantees must be documented explicitly.
- PR posting, GitHub review comments, and write-capable tools are permanently out of scope.
- Avoid stale docs: link to upstream SDK docs instead of copying API details here.
