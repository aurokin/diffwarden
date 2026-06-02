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

Codex also has an opt-in app-server transport:

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

## Tool Policy Guidelines

Reviewer adapters should expose the smallest useful read-only tool surface whenever the
underlying SDK, app-server, or CLI allows it. The reviewed patch remains the source of truth,
but reviewers need enough local context to inspect surrounding code, tests, and helper APIs.

Preferred tools are direct file and repository inspection primitives: read files, list or glob
files, grep/search text, and equivalent read-only repository queries. Avoid write-capable tools,
patch/edit tools, shell execution, external publishing, browser/web fetch, task spawning,
subagents, memory/session mutation, and broad plugin surfaces unless a provider transport cannot
perform a useful review without them. If shell access is the only practical inspection path,
constrain it to read-only commands and document the weaker enforcement level.

Do not impose adapter-specific tool-call, turn, or step caps for normal reviews. Diffwarden's
reviewer timeout is the run-level circuit breaker. Tool budgets can stop a real review before
the model has enough evidence, especially on providers that use several small read/search turns.
If a provider has an unavoidable native cap, surface that as a transport limitation rather than
treating it as Diffwarden policy.

Every adapter should document its effective read-only capability as one of:

- `enforced`: the transport provides a native read-only mode, sandbox, or spec mode.
- `tool-restricted`: Diffwarden exposes only read-oriented tools, but enforcement depends on
  the provider runtime.
- `prompt-only`: Diffwarden asks for read-only behavior, but hard enforcement is not proven.

## Model And Effort Metadata

Adapters keep the legacy `model` and `effort` metadata fields and also report explicit
resolution fields when the runtime exposes enough information:

- `requestedModel` / `requestedEffort`: the value from config or CLI flags.
- `resolvedModel` / `resolvedEffort`: the effective value Diffwarden can prove was selected.
- `modelResolutionSource` / `effortResolutionSource`: where that resolution came from.

Resolution sources rank by provenance. Provider-observed sources such as `provider-init` and
`provider-result` are runtime evidence. `provider-local` means provider-owned local settings or
session files supplied the value; it can fill gaps but should not override explicit selected
values by itself. `config` means the value came from Diffwarden reviewer configuration; it is
clearer than treating configured values as direct CLI requests, but it is still lower confidence
than runtime evidence. `env` means the value came from `DIFFWARDEN_MODEL` or
`DIFFWARDEN_EFFORT`. `requested` means the value came from a per-run CLI override.
`adapter-default` and `adapter-selection` mean Diffwarden selected or translated the value
locally.

Current SDK coverage:

| Adapter | Model resolution | Effort resolution |
| --- | --- | --- |
| Cursor SDK | Preflight resolves aliases through `Cursor.models.list`; run output prefers the SDK result model. | Requested effort is reported as unsupported because the SDK path does not expose an effort control. |
| Claude SDK | Reports the model Diffwarden passes to the SDK, using `sonnet` when no override is configured. | Maps public effort values to Claude native effort or disabled thinking. |
| Pi SDK | Reports the selected authenticated provider/model from Pi's model registry. | Reports the requested and clamped Pi thinking level. |
| Droid SDK | Reads the effective spec-mode model from `session.initResult.settings`. | Reads the effective spec-mode reasoning effort from `session.initResult.settings`. |

CLI transports always report deterministic values that Diffwarden passes on the command line:
`requestedModel` / `requestedEffort` preserve configured or per-run overrides, and
`resolvedModel` / `resolvedEffort` reflect CLI-native values when Diffwarden can prove them.
Configured overrides use the `config` source. Environment defaults use `env`. Per-run overrides
use `requested`. When a CLI emits stable machine-readable runtime JSON or JSONL metadata,
provider-observed `resolved*` fields take precedence over deterministic argv metadata. CLI
defaults remain omitted when the executable does not expose a structured runtime value.

The Codex app-server transport follows the same metadata convention. It additionally records
`transport: "app-server"`, `ephemeral: true`, `execEnabled: true`, `appServerMode`,
`codexHome`, `codexHomeShared`, `webSearchPolicy`, `codexReviewMode`, and app-server lifecycle
metadata because command execution is intentionally still available for this transport.

## Codex App Server

```bash
diffwarden --target uncommitted --reviewer codex-app-server
```

The Codex app-server path is configured through a named reviewer with
`transport: "app-server"`. By default it uses the shared Codex home, connects to
`$CODEX_HOME/app-server-control/app-server-control.sock` when an app-server is already
running, and launches `codex app-server --listen unix://` only when no socket is available.
The review itself starts an ephemeral read-only thread, sets Codex `web_search` to `"disabled"` by
default, and requests JSON-schema turn output.

The shared Codex home resolves from `appServerOptions.codexHome`, then
`DIFFWARDEN_CODEX_HOME`, then `DIFFWARDEN_CODEX_AUTH_HOME`, then `$CODEX_HOME`, then
`$HOME/.codex`. Shared mode intentionally inherits that Codex home's auth, config, plugins,
apps, and daemon state. For a reusable middle ground, set `appServerOptions.codexHome` to a
dedicated stable home such as `~/.codex-diffwarden`.

`appServerOptions.codexHome` applies to shared socket modes. In `stdio-isolated` mode,
Diffwarden creates a temporary `CODEX_HOME` for the app-server process and sources auth and
model-provider config from `DIFFWARDEN_CODEX_AUTH_HOME`, then `$CODEX_HOME`, then
`$HOME/.codex`.

`appServerOptions.mode` controls lifecycle:

- `auto`: attach to an existing socket and launch only if none exists.
- `attach`: attach only and fail if the socket is unavailable.
- `launch`: reuse an existing socket or launch the shared server.
- `stdio-isolated`: use a temporary `CODEX_HOME` and stdio app-server process for each review.

`appServerOptions.webSearch` controls Codex's thread-level web-search override:

- `disabled`: set `web_search = "disabled"`. This is the default.
- `enabled`: set `web_search = "live"`.
- `inherit`: do not set `web_search` on the thread.

In `stdio-isolated` mode, `inherit` copies the source Codex home's top-level `web_search`
setting into the temporary `CODEX_HOME` when one is configured.

`appServerOptions.reviewMode` controls the review protocol:

- `structured`: use Diffwarden's schema-constrained `turn/start` flow. This is the default.
- `native`: use experimental Codex `review/start` mode and return Codex's rendered review
  text. This mode does not preserve structured findings in Diffwarden artifacts unless the
  text contains parseable `ReviewResult` JSON.

Codex native review mode disables web search inside the review task, even when the parent
thread has `web_search = "live"`. Diffwarden reports native-mode `webSearchMode` and
`effectiveWebSearchMode` as `"disabled"`; the requested parent-thread mode is preserved as
`requestedWebSearchMode` when applicable. Native mode carries configured effort overrides
through thread config as `model_reasoning_effort` because `review/start` does not accept a
per-request effort field.

Command execution is currently left enabled for this transport so Codex can use
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

The adapter uses `@anthropic-ai/claude-agent-sdk` with tools restricted to `Read`, `Grep`,
`Glob`, and `LS`, isolated setting sources, and native JSON Schema output. In the default
`auto` auth mode, Diffwarden
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

The Droid CLI JSON result includes a `session_id` but not model or effort fields. When the
local session settings file is available under `~/.factory/sessions`, Diffwarden reads that
Droid-owned settings file to report model and effort when Diffwarden did not already select
those values from config, env, or per-run overrides. The lookup first uses Droid's encoded cwd
directory and then falls back to a one-level session-id search under the default sessions
directory for path-encoding compatibility. If explicit model or non-`off` effort settings were
passed to Droid, Diffwarden keeps those selected values as the primary resolution and records
Droid's session values separately as `droidSessionModel` and `droidSessionEffort`. When both
display names and stable model IDs are present, Diffwarden reports the stable ID. The `off`
effort value is different: Droid CLI omits an off flag, so session settings may still fill the
resolved runtime effort while `requestedEffort` remains `off`. If the settings file is
unavailable, malformed, or stored outside the default sessions directory, Diffwarden keeps the
review successful and omits those runtime fields rather than inferring defaults from CLI help.

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

Codex CLI sets `web_search = "disabled"` by default to match Codex review mode. Set
`cliOptions.webSearch` to `"enabled"` to opt into live search, or `"inherit"` to leave
Codex's configured default untouched.

OpenCode CLI receives the review prompt on stdin, adds transport-specific guidance to use the
embedded patch first, uses a generated low-tool `diffwarden-review-*` agent by default, and injects
`OPENCODE_CONFIG_CONTENT` with a generated agent that allows only `read`, `glob`, and `grep`
while denying every other tool permission unless the caller already supplied
OpenCode config through `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, or
selected `cliOptions.agent`. Diffwarden also sets `OPENCODE_PERMISSION` with the same tool
policy for the spawned process. Diffwarden does not inject an OpenCode step cap; the configured
reviewer timeout is the run-level circuit breaker. Set `cliOptions.agent` to use an existing
primary OpenCode agent.

SDK-backed families, including Droid, can use `transport: "cli"` from config.
`cliOptions.executable` can point at non-standard CLI installs, such as local `pi`, `droid`, or
`agy` binaries. Droid SDK reviewers use `sdkOptions.executable`, with `cliOptions.executable`
kept as a legacy fallback. CLI auth is delegated to the underlying executable, so live runs
require each tool to be logged in or configured through its own environment variables.

Antigravity uses `agy --print` because `agy` print mode expects the prompt as the flag value.
Diffwarden stores the full assembled review prompt in a temporary file and passes a short print
prompt telling `agy` to read that file, keeping the diff out of process argv while preserving
print-mode behavior.

Claude CLI transport uses the same `sdkOptions.authMode` values as the Claude SDK adapter.
In `auto` mode, Diffwarden checks the selected Claude executable for logged-in Claude Code
auth with Anthropic API credentials removed, then removes those credentials from the actual
`claude -p` run when local Claude Code auth is available.

Capability metadata is conservative. OpenCode, Grok, Antigravity, and Cursor CLI paths
currently report prompt-only read-only behavior when hard enforcement is not proven.

CLI model and effort metadata is conservative. Diffwarden records requested and resolved fields
for values it explicitly passes, including provider-qualified model strings such as
`openrouter/anthropic/claude-sonnet`. Effort mappings follow the invocation arguments: Claude
maps `minimal` to `low` and `xhigh` to `max`; Droid and Grok map `minimal` to `low`; Codex, Pi,
OpenCode, Gemini, and Cursor record exact requested values where those overrides are supported.
If stdout contains stable JSON or JSONL runtime fields such as `model`, `modelId`,
`reasoningEffort`, or `model_reasoning_effort`, those provider-observed values replace the
deterministic resolved values. Droid CLI stdout does not currently include these fields, so
Diffwarden uses the returned `session_id` to read Droid's local session settings file when it is
available, including a fallback session-id lookup under `~/.factory/sessions` when the project
path encoding differs. Droid session settings are fallback resolution evidence when Diffwarden
did not already select a model or effort. When no explicit runtime model field is present,
Claude CLI also reports the runtime model as the single `modelUsage` key in its final JSON
result; Diffwarden strips display-only formatting such as a trailing context-window suffix before
reporting it. Pi CLI reports the runtime model in assistant message records. Claude and Pi CLI
values are runtime-result evidence, not startup configuration proof.
Diffwarden does not infer effort for Claude or Pi CLI unless the CLI emits an explicit runtime
effort field. Gemini remains supported, but new runtime-metadata extraction work should not build
additional Gemini-specific behavior. Antigravity rejects model and effort overrides.

## Live Test Controls

Inspect local tool availability:

```bash
pnpm live:doctor
```

`live:doctor` resolves CLI executables using explicit `DIFFWARDEN_LIVE_*_EXECUTABLE`
environment overrides first, then matching executable-backed Diffwarden reviewer config, then
adapter defaults.
Each row reports the source so stale PATH shims are easier to distinguish from configured
executables. For Antigravity, prefer a real `agy` CLI path such as `/Users/auro/.local/bin/agy`
over a shim that points into the macOS app bundle.
The Droid doctor rows are transport-specific: use `DIFFWARDEN_LIVE_DROID_SDK_EXECUTABLE` for
the SDK row and `DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE` for the CLI row.

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
DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE=/Users/auro/.local/bin/droid
DIFFWARDEN_LIVE_DROID_SDK_EXECUTABLE=/Users/auro/.local/bin/droid
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
