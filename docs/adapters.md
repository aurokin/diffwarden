# Reviewer Adapters

Adapters run reviewer engines and return text or structured output. Core CLI logic owns
target resolution, prompt assembly, parsing, validation, aggregation, and rendering.

## Adapter Families

SDK adapters remain the default for:

- `cursor`
- `claude`
- `pi`
- `droid`

CLI-only reviewers use `transport: "cli"` automatically:

- `codex`
- `gemini`
- `opencode`
- `grok`
- `antigravity`

SDK-backed families can also opt into CLI transport through config.

## Cursor SDK

```bash
diffwarden --target uncommitted --reviewer cursor
```

Requires `CURSOR_API_KEY` in the environment. For local development with zsh-based
dotfiles, an interactive shell may be needed if the key is exported from `.zshrc`.

```bash
zsh -lic 'pnpm dev -- --target uncommitted --reviewer cursor'
```

The adapter uses `@cursor/sdk`. That SDK currently depends on `sqlite3`, so
`package.json` allows pnpm to run the `sqlite3` build script through
`pnpm.onlyBuiltDependencies`.

Live smoke test:

```bash
zsh -lic 'pnpm test:live:sdk'
```

## Claude SDK

```bash
diffwarden --target uncommitted --reviewer claude
```

The Claude adapter can use either `ANTHROPIC_API_KEY` or a locally authenticated Claude Code
executable.

```bash
ANTHROPIC_API_KEY=... pnpm dev -- --target uncommitted --reviewer claude
pnpm dev -- --target uncommitted --reviewer claude
```

The adapter uses `@anthropic-ai/claude-agent-sdk` with built-in tools disabled, isolated
setting sources, and native JSON Schema output. If no API key is present and
`claude auth status --json` reports a logged-in account, the SDK is pointed at the local
`claude` executable so Claude Code auth can be reused.

Live smoke test:

```bash
pnpm test:live:sdk
```

## Pi SDK

```bash
diffwarden --target uncommitted --reviewer pi --model anthropic/claude-sonnet-4-5
```

The adapter loads `@earendil-works/pi-coding-agent`, checks environment-backed
authenticated models, runs with a scoped model list, and captures structured output through
a terminating `review_output` tool.

The Pi path reports a tool-restricted read-only capability. It passes only `read`, `grep`,
`find`, `ls`, and `review_output` as active tools, uses an extension-free resource loader,
and keeps tests credential-free by default.

Live smoke test:

```bash
pnpm test:live:sdk
```

By default, the smoke test requests `anthropic/claude-sonnet-4-5`. Select another
authenticated model with `PI_SMOKE_MODEL`.

```bash
PI_SMOKE_MODEL=anthropic/claude-opus-4-5 pnpm test:live:sdk
```

## Droid SDK

```bash
diffwarden --target uncommitted --reviewer droid
```

The adapter uses `@factory/droid-sdk` and the local `droid` executable. It requests native
JSON Schema output and runs in Droid's spec interaction mode for read-only review behavior.
Set `FACTORY_API_KEY` or use local Droid auth supported by the installed CLI.

Set `sdkOptions.machineId` on a Droid reviewer to target a specific Droid Computer. For live
SDK smoke tests, set `DIFFWARDEN_LIVE_DROID_MACHINE_ID` to the ID from
`droid computer list`.

Droid persists session history under `~/.factory/sessions` and groups sessions by `cwd`.
Diffwarden passes the reviewed repository as `cwd` so Droid can inspect files, and tags its
SDK and CLI sessions with `diffwarden` metadata for discovery. The current Droid CLI and SDK
do not expose an ephemeral/no-history review mode.

Live smoke test:

```bash
pnpm test:live:sdk
```

## CLI Transports

```bash
diffwarden --target uncommitted --reviewer codex
diffwarden --target uncommitted --reviewer gemini
diffwarden --target uncommitted --reviewer opencode
diffwarden --target uncommitted --reviewer grok
diffwarden --target uncommitted --reviewer antigravity
```

The shared CLI adapter performs executable preflight, runs the selected CLI in its most
restrictive documented review mode, and returns either native structured output or text for
the core parser.

SDK-backed families, including Droid, can use `transport: "cli"` from config.
`cliOptions.executable` can point at non-standard installs, such as local `pi`, `droid`, or
`agy` binaries. CLI auth is delegated to the underlying executable, so live runs require each
tool to be logged in or configured through its own environment variables.

Capability metadata is conservative. OpenCode, Grok, Antigravity, and Cursor CLI paths
currently report prompt-only read-only behavior when hard enforcement is not proven.

## Live Test Controls

Inspect local tool availability:

```bash
pnpm live:doctor
```

Set `INTEGRATION_DISABLE` with any SDK names that should remain disabled during broader
live test runs.

```bash
INTEGRATION_DISABLE=cursor,claude,pi
```

Restrict live CLI adapter tests to a subset with `DIFFWARDEN_LIVE_CLI`.

```bash
DIFFWARDEN_LIVE_CLI=codex,claude,gemini pnpm test:live:cli
```

Override CLI executable paths with engine-specific variables when a binary is not on `PATH`.

```bash
DIFFWARDEN_LIVE_PI_EXECUTABLE=/Users/auro/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/latest/bin/pi
DIFFWARDEN_LIVE_DROID_EXECUTABLE=/Users/auro/.local/bin/droid
DIFFWARDEN_LIVE_DROID_MACHINE_ID=YOUR_DROID_COMPUTER_ID
DIFFWARDEN_LIVE_ANTIGRAVITY_EXECUTABLE=/Users/auro/.local/bin/agy
```

Run built-binary e2e smoke tests against selected reviewers with:

```bash
DIFFWARDEN_LIVE_E2E_REVIEWERS=codex,claude pnpm test:live:e2e
```

The e2e harness uses CLI transports through a temporary config file and honors the same
per-reviewer live overrides as the CLI adapter harness:

```bash
DIFFWARDEN_LIVE_E2E_REVIEWERS=droid DIFFWARDEN_LIVE_DROID_EFFORT=low pnpm test:live:e2e
```
