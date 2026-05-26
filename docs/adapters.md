# Reviewer Adapters

Adapters run reviewer engines and return text or structured output. Core CLI logic owns
target resolution, prompt assembly, parsing, validation, aggregation, and rendering.

For the source-of-truth capability table, see [`features.md`](./features.md). This page
explains adapter behavior and operational notes.

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

Codex also has an experimental opt-in app-server transport:

```json
{
  "reviewers": [
    {
      "id": "codex-app-server",
      "engine": "codex",
      "transport": "app-server"
    }
  ]
}
```

SDK-backed families can also opt into CLI transport through config.

## Model And Effort Metadata

Adapters keep the legacy `model` and `effort` metadata fields and also report explicit
resolution fields when the runtime exposes enough information:

- `requestedModel` / `requestedEffort`: the value from config or CLI flags.
- `resolvedModel` / `resolvedEffort`: the effective value Diffwarden can prove was selected.
- `modelResolutionSource` / `effortResolutionSource`: where that resolution came from.

Current SDK coverage:

| Adapter | Model resolution | Effort resolution |
| --- | --- | --- |
| Cursor SDK | Preflight resolves aliases through `Cursor.models.list`; run output prefers the SDK result model. | Requested effort is reported as unsupported because the SDK path does not expose an effort control. |
| Claude SDK | Reports the model Diffwarden passes to the SDK, using `sonnet` when no override is configured. | Maps public effort values to Claude native effort or disabled thinking. |
| Pi SDK | Reports the selected authenticated provider/model from Pi's model registry. | Reports the requested and clamped Pi thinking level. |
| Droid SDK | Reads the effective spec-mode model from `session.initResult.settings`. | Reads the effective spec-mode reasoning effort from `session.initResult.settings`. |

CLI transports report deterministic values that Diffwarden passes on the command line:
`resolvedModel` is set only when a model override is passed, and `resolvedEffort` reflects
the CLI-native effort value after public-effort mapping. CLI default models remain omitted
until an executable exposes stable machine-readable runtime metadata.

The Codex app-server transport follows the same metadata convention. It additionally records
`transport: "app-server"`, `ephemeral: true`, `execEnabled: true`, `appServerMode`,
`codexHome`, `codexHomeShared`, and app-server lifecycle metadata because command execution
is intentionally still available in the first experimental version.

## Codex App Server

```bash
diffwarden --target uncommitted --reviewer codex-app-server
```

The Codex app-server path is configured through a named reviewer with
`transport: "app-server"`. By default it uses the shared Codex home, connects to
`$CODEX_HOME/app-server-control/app-server-control.sock` when an app-server is already
running, and launches `codex app-server --listen unix://` only when no socket is available.
The review itself starts an ephemeral read-only thread, disables web search for the thread,
and requests JSON-schema turn output.

The shared Codex home resolves from `appServerOptions.codexHome`, then
`DIFFWARDEN_CODEX_HOME`, then `DIFFWARDEN_CODEX_AUTH_HOME`, then `$CODEX_HOME`, then
`$HOME/.codex`. Shared mode intentionally inherits that Codex home's auth, config, plugins,
apps, and daemon state. For a reusable middle ground, set `appServerOptions.codexHome` to a
dedicated stable home such as `~/.codex-diffwarden`.

`appServerOptions.mode` controls lifecycle:

- `auto`: attach to an existing socket and launch only if none exists.
- `attach`: attach only and fail if the socket is unavailable.
- `launch`: reuse an existing socket or launch the shared server.
- `stdio-isolated`: use the older temporary `CODEX_HOME` stdio app-server path.

Command execution is currently left enabled for this experimental transport so Codex can use
its normal repository inspection path. Diffwarden sets approval policy to `never`, uses a
read-only sandbox policy, denies approval escalation requests, and exposes this fact as
`execEnabled: true` in preflight and adapter metadata. A later hardening pass can explore
disabling shell/unified exec once the minimum required file-read surface is proven.

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
zsh -lic 'DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk'
```

## Claude SDK

```bash
diffwarden --target uncommitted --reviewer claude
```

The Claude adapter can use either a locally authenticated Claude Code executable or
`ANTHROPIC_API_KEY`.

```bash
ANTHROPIC_API_KEY=... pnpm dev -- --target uncommitted --reviewer claude
pnpm dev -- --target uncommitted --reviewer claude
```

The adapter uses `@anthropic-ai/claude-agent-sdk` with built-in tools disabled, isolated
setting sources, and native JSON Schema output. In the default `auto` auth mode, Diffwarden
checks `claude auth status --json` with Anthropic API credentials removed from the child
environment. If that reports a logged-in Claude Code account, the SDK is pointed at the
local `claude` executable and API credentials are removed from the SDK process environment
so Claude Code auth is reused deliberately. If Claude Code auth is unavailable, Diffwarden
falls back to `ANTHROPIC_API_KEY`.

Force a specific Claude SDK auth path with reviewer `sdkOptions.authMode`:

```json
{
  "reviewers": [
    {
      "id": "claude-subscription",
      "engine": "claude",
      "sdkOptions": {
        "authMode": "claude-code"
      }
    },
    {
      "id": "claude-api-key",
      "engine": "claude",
      "sdkOptions": {
        "authMode": "api-key"
      }
    }
  ]
}
```

Valid values are `auto`, `claude-code`, and `api-key`.

Live smoke test:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
```

## Pi SDK

```bash
diffwarden --target uncommitted --reviewer pi --model anthropic/claude-sonnet-4-5
```

The adapter loads `@earendil-works/pi-coding-agent`, checks environment-backed
authenticated models, runs with a scoped model list, and captures structured output through
a terminating `review_output` tool.

By default the adapter builds an isolated, in-memory `AuthStorage` (`AuthStorage.inMemory()`)
that only sees provider credentials from environment variables. Set
`sdkOptions.authSource: "shared"` on the reviewer to use `AuthStorage.create(authPath?)`
instead, which loads the Pi CLI's on-disk `auth.json` (including OAuth logins like
`openai-codex`) and auto-refreshes OAuth tokens with file locking. This shares the CLI's
credentials without spawning the `pi` executable, so it avoids macOS executable-trust
prompts. `sdkOptions.authPath` overrides the default `auth.json` location (a leading `~` is
expanded); it requires `authSource: "shared"`. Preflight and output metadata report the
active `authSource` (and `authPath` when set). The default stays isolated to keep tests
credential-free. Note that shared mode writes to `auth.json` on disk: it creates the file
and its parent directory if absent, and rewrites the file when refreshing an expired OAuth
token, so it is the one path where a review run mutates state outside the repository.

The Pi path reports a tool-restricted read-only capability. It passes only `read`, `grep`,
`find`, `ls`, and `review_output` as active tools, uses an extension-free resource loader,
and keeps tests credential-free by default.

Live smoke test:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
```

By default, the smoke test requests `anthropic/claude-sonnet-4-5`. Select another
authenticated model with `PI_SMOKE_MODEL`.

```bash
PI_SMOKE_MODEL=anthropic/claude-opus-4-5 DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
```

## Droid

```bash
diffwarden --target uncommitted --reviewer droid-cli
```

Prefer Droid's CLI transport for routine reviews. It follows the current `droid exec`
surface, uses read-only spec mode by default, and keeps Diffwarden on the same runtime path
as the installed Droid CLI.

The Droid SDK adapter remains available through `--reviewer droid` or configured native
profiles. It uses `@factory/droid-sdk`, creates a session, reads resolved model and effort
settings from the session init result, streams a prompt with native JSON Schema output, and
runs in Droid's spec interaction mode for read-only review behavior. Treat this path as
experimental if Factory UI session history matters, because SDK runs still appear in Droid
session history and may be grouped differently from CLI-created Droid Computer sessions. Set
`FACTORY_API_KEY` or use local Droid auth supported by the installed CLI.

Set `sdkOptions.machineId` on a Droid reviewer to target a specific Droid Computer. For live
SDK smoke tests, set `DIFFWARDEN_LIVE_DROID_MACHINE_ID` to the ID from
`droid computer list`.

Droid persists session history under `~/.factory/sessions` and groups sessions by `cwd`.
Diffwarden passes the reviewed repository as `cwd` so Droid can inspect files, and tags its
SDK and CLI sessions with `diffwarden` metadata for discovery. The current Droid CLI and SDK
do not expose an ephemeral/no-history review mode. Diffwarden cannot currently suppress
Droid session history without isolating Factory's home/config directory, which is not the
default review path.

Live SDK smoke test:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
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

Claude CLI transport uses the same `sdkOptions.authMode` values as the Claude SDK adapter.
In `auto` mode, Diffwarden checks the selected Claude executable for logged-in Claude Code
auth with Anthropic API credentials removed, then removes those credentials from the actual
`claude -p` run when local Claude Code auth is available.

Capability metadata is conservative. OpenCode, Grok, Antigravity, and Cursor CLI paths
currently report prompt-only read-only behavior when hard enforcement is not proven.

CLI model and effort metadata is deterministic rather than provider-observed. Diffwarden
records requested and resolved fields for values it explicitly passes, including provider
qualified model strings such as `openrouter/anthropic/claude-sonnet`. Effort mappings follow
the invocation arguments: Claude maps `minimal` to `low` and `xhigh` to `max`; Droid and Grok
map `minimal` to `low`; Codex, Pi, OpenCode, Gemini, and Cursor record exact requested values
where those overrides are supported. Antigravity rejects model and effort overrides.

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
DIFFWARDEN_LIVE_CLI=codex,claude,gemini DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:cli
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
DIFFWARDEN_ALLOW_MODEL_SPEND=1 DIFFWARDEN_LIVE_E2E_REVIEWERS=codex,claude pnpm test:live:e2e
```

The e2e harness uses CLI transports through a temporary config file and honors the same
per-reviewer live overrides as the CLI adapter harness:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 DIFFWARDEN_LIVE_E2E_REVIEWERS=droid DIFFWARDEN_LIVE_DROID_EFFORT=low pnpm test:live:e2e
```
