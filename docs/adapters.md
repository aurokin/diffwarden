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
- `copilot`

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

Prefer explicit allowlists over denylists whenever the transport supports them. Denylists are
fallbacks for transports that do not provide a stable allowlist surface or where the allowlist is
too coarse to run a useful review. When a provider adds unavoidable native control tools around a
read-only/spec mode, document that exception separately instead of broadening the allowlist by
category.

Do not impose adapter-specific tool-call, turn, step, or default wall-clock caps for normal
reviews. A reviewer timeout is only a run-level circuit breaker when the user or config
explicitly sets one. Tool budgets can stop a real review before the model has enough evidence,
especially on providers that use several small read/search turns.
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
| Copilot SDK | Reports the requested model and promotes provider-result model metadata from `assistant.usage` / `assistant.message` events when available. | Maps `minimal` to `low`, omits SDK reasoning effort for `off`, and promotes provider-result effort metadata when available. |

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

## Codex CLI

The Codex CLI path runs `codex exec` instead of `codex review` so Diffwarden can use its
shared schema-constrained prompt and parse the final message through the normal
`ReviewResult` schema. The CLI invocation uses `--json`, `--sandbox read-only`, `--ephemeral`,
`--output-schema`, `--output-last-message`, and `--cd <repo>`. Diffwarden sets
`web_search = "disabled"` by default and passes effort through `model_reasoning_effort` when
configured.

Latest Codex CLI builds expose `--ignore-rules`, which could prevent user or project
execpolicy `.rules` files from affecting review execution policy. Diffwarden does not pass it
by default yet because older otherwise-compatible Codex CLI installs may reject the flag.
Diffwarden also does not pass `--ignore-user-config` by default because Codex users commonly
depend on `config.toml` for model/provider/auth configuration.

The CLI path is `enforced` by Codex's read-only sandbox and headless approval policy. It is
not small-tool allowlisted: Codex may still use its normal shell/repository inspection path,
but writes and approval escalations are constrained by Codex's sandbox and approval policy.

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

Diffwarden's structured app-server mode sends `approvalPolicy: "never"`, `sandbox:
"read-only"`, `ephemeral: true`, `persistExtendedHistory: false`, no client dynamic tools, and
a turn-scoped read-only sandbox policy with network access disabled. `stdio-isolated` launches
`codex app-server --listen stdio://` with plugins, apps, computer use, browser use, in-app
browser, image generation, and multi-agent features disabled.

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
read-only sandbox policy, denies approval escalation requests, and rejects dynamic tool calls.
Diffwarden does not call app-server `command/exec`; that is a separate client API. The
remaining shell/unified-exec exposure is Codex-native model tool behavior, and Diffwarden
exposes this fact as `execEnabled: true` in preflight and adapter metadata. A later hardening
pass can explore disabling shell/unified exec once the minimum required file-read surface is
proven.

Diffwarden does not add Codex-specific tool-call, turn, step, retry, or equivalent caps. A
configured reviewer timeout, when set, remains the run-level limiter. Codex-native limits that
can still affect a review include model context/truncation behavior, command output capture and command timeout
defaults, app-server socket launch/handshake waits, and native review mode's rendered-text
parsing path.

## Cursor SDK

```bash
diffwarden --target uncommitted --reviewer cursor
```

Requires `CURSOR_API_KEY` in the environment. For local development with zsh-based
dotfiles, an interactive shell may be needed if the key is exported from `.zshrc`.

```bash
zsh -lic 'pnpm dev -- --target uncommitted --reviewer cursor'
```

The adapter uses `@cursor/sdk` local mode with `mode: "plan"`, `sandboxOptions: { enabled: true }`,
`autoReview: true`, empty `settingSources`, no MCP servers, and an ephemeral JSONL local store.
The JSONL store keeps Diffwarden reviews out of Cursor's default persistent local SDK store.
Cursor still does not expose deterministic read/glob/grep-only tool allowlisting for this path,
so Diffwarden reports prompt-only read-only capability instead of hard enforcement.

The SDK currently depends on `sqlite3`, so `pnpm-workspace.yaml` allows pnpm to run the
`sqlite3` build script through `onlyBuiltDependencies`.

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

The adapter uses `@anthropic-ai/claude-agent-sdk` with built-in tools restricted to `Read`,
`Grep`, and `Glob`, isolated setting sources, an empty MCP server map, strict MCP config, no
session persistence, and native JSON Schema output. Current Claude docs distinguish `tools` from `allowedTools`:
`tools` constrains the built-in tool surface, while `allowedTools` only pre-approves tools.
Diffwarden sets both to `Read`, `Grep`, and `Glob`, uses `permissionMode: "dontAsk"` so
unapproved tools are denied, and also sends deny rules for write, shell, web, skill, agent,
and workflow tools. `LS` is intentionally omitted because the current Claude tools reference
does not list it; `Glob` is the listing primitive for this restricted review surface.

In the default `auto` auth mode, Diffwarden
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

When local Claude Code auth is selected, Diffwarden first checks that the selected `claude`
executable supports the review policy flags used by the SDK/CLI paths. In `auto` mode, an
outdated local executable falls back to `ANTHROPIC_API_KEY` when one is available; forced
`claude-code` mode fails preflight with a missing-requirement error instead of running with a
weaker policy.

Diffwarden does not set Claude SDK `maxTurns` for review runs; only a configured reviewer
timeout limits the run. Claude-native limits can still stop or shape a run, including model
context
limits, structured-output retry behavior, provider output limits, and built-in tool result
limits such as Glob result caps.

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

When no model is configured, Pi selects the first authenticated model from the scoped model
list. Diffwarden keeps that behavior for ad hoc `--reviewer pi` runs, but preflight reports
`piImplicitModelSelection` metadata and warns when more than one candidate model exists.
Reusable provider-heavy profiles should pin `provider`, `model`, and usually `effort` in
config so results do not drift with environment variables, login state, or Pi model registry
ordering.

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

Pi tool names stay Pi-native, but Diffwarden maps them to the shared review policy this way:

| Pi tool | Policy role |
| --- | --- |
| `read` | read file contents |
| `grep` | search file contents |
| `find` | find files by name or path |
| `ls` | list directories |
| `review_output` | SDK-only structured termination tool |

The SDK path enables exactly `read`, `grep`, `find`, `ls`, and `review_output`, with
`review_output` as the only successful structured-review termination path. The CLI path enables
only `read,grep,find,ls`; it cannot use the SDK custom termination tool and instead returns
JSONL/text from `pi --print --mode json`.

Both Pi transports disable ambient context surfaces where the transport exposes a switch. SDK
runs use an extension-free resource loader that returns no extensions, skills, prompts, themes,
agents files, system prompt, or appended system prompts. CLI runs use `--no-session`,
`--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, and
`--no-context-files`.

Diffwarden passes `SettingsManager.inMemory()` to Pi SDK review sessions. This prevents
global or project Pi `settings.json` files from changing review runtime behavior. Review
sessions use explicit Pi defaults for `transport: "auto"`, `steeringMode: "one-at-a-time"`,
and `followUpMode: "one-at-a-time"`. Set `sdkOptions.settings` on the reviewer to override
supported Pi SDK runtime fields such as `transport` or `thinkingBudgets` without inheriting
settings files; unsupported keys are rejected rather than ignored. Preflight and output
metadata report those runtime fields plus the Pi-native settings that can affect runtime
duration: agent retry enabled/max retries/base delay, provider
request timeout/retry/max retry delay, compaction enabled/reserve/keep-recent tokens, and
HTTP idle timeout when the installed Pi SDK exposes that getter. With
`@earendil-works/pi-coding-agent@0.75.3`, HTTP idle timeout is not exposed through the public
settings manager, so Diffwarden reports it as unavailable instead of guessing. These are
Pi-native/provider-native controls, not Diffwarden tool-call or step caps. A configured reviewer
timeout, when set, is the Diffwarden-owned run-level circuit breaker.

Diffwarden does not add Pi-specific tool-call, turn, step, retry, or equivalent caps. The
provider-owned limits that can affect a run are Pi SDK settings and provider transport behavior:
agent retry, provider request timeout/retry/max retry delay, compaction, transport selection,
message delivery mode, thinking budgets, and HTTP idle timeout when exposed by the installed SDK.

Live smoke test:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
```

By default, the smoke test requests `anthropic/claude-sonnet-4-5`. Select another
authenticated model with `PI_SMOKE_MODEL`.

```bash
PI_SMOKE_MODEL=anthropic/claude-opus-4-5 DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
```

### Pi SDK versus CLI comparison

Run the credential-free comparison fixture when changing Pi SDK or Pi CLI review behavior:

```bash
pnpm vitest run --config vitest.unit.config.ts test/pi-comparison.test.ts
```

The fixture keeps the expected transport differences explicit. The SDK path uses `read`,
`grep`, `find`, `ls`, and terminating `review_output` tool-call capture; output metadata
reports `captureMode: "tool-call"`. The CLI path runs `pi --print --mode json`, disables
sessions, extensions, skills, prompt templates, themes, and context files, restricts tools to
`read,grep,find,ls`, and parses JSONL/text output; output metadata reports
`captureMode: "text"`.

Optional live comparison runs are separate from the default loop and must keep the spend guard.
Pin a cheap or specific authenticated model rather than relying on Pi model registry order.

```bash
PI_SMOKE_MODEL=anthropic/claude-sonnet-4-5 DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
DIFFWARDEN_LIVE_CLI=pi DIFFWARDEN_LIVE_PI_MODEL=anthropic/claude-sonnet-4-5 DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:cli
```

For provider-qualified CLI runs, either pass the full provider/model string in
`DIFFWARDEN_LIVE_PI_MODEL` or split it across `DIFFWARDEN_LIVE_PI_PROVIDER` and
`DIFFWARDEN_LIVE_PI_MODEL`. `DIFFWARDEN_LIVE_PI_EFFORT` maps to the CLI `--thinking` flag.

## Droid

```bash
diffwarden --target uncommitted --reviewer droid-cli
```

Prefer Droid's CLI transport for routine reviews. It follows the current `droid exec`
surface, uses `--use-spec`, leaves `--auto` unset so Droid Exec stays in its documented
default read-only autonomy mode, and passes an explicit `--enabled-tools` allowlist:
`read-cli`, `glob-search-cli`, `grep_tool_cli`, `ls-cli`, and Droid's spec-control
`exit-spec-mode` tool. Diffwarden preflights the installed CLI for those review-policy flags
and runs `droid exec --list-tools --output-format json` with the same allowlist before running a
review, so Droid CLI tool ID changes fail closed. Droid CLI invocations also receive a
Diffwarden-scoped `--log-group-id` for Factory log filtering.

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
runs in Droid's spec interaction mode with autonomy off and the SDK `Read`, `Glob`, `Grep`,
`LS`, and `ExitSpecMode` tools explicitly allowlisted for read-only review behavior. Treat this
path as experimental if Factory UI session history matters, because SDK runs still appear in Droid
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

Diffwarden does not add Droid-specific tool-call, turn, step, retry, mission, compaction, or
equivalent caps around review runs. A configured reviewer timeout, when set, is the
Diffwarden-owned run-level circuit breaker. Droid-native context limits, structured-output
behavior, session history, and
any provider or organization policy limits still apply.

Live SDK smoke test:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
```

## GitHub Copilot

```bash
diffwarden --target uncommitted --reviewer copilot
```

The Copilot SDK adapter uses `@github/copilot-sdk` with `mode: "empty"`. Diffwarden disables
config discovery, custom instructions, MCP Apps, extensions, custom agents,
plugin/skill/instruction directories, session telemetry, coauthor behavior, and schedule
management for review sessions. SDK runs use a temporary Copilot home with filtered auth state
and an empty `mcp-config.json`, because the SDK only serializes explicit `mcpServers` and does
not expose the CLI's `--disable-mcp-server` switch. Infinite sessions are disabled so review
runs do not create persistent workspace checkpoints/history. The session exposes only
Copilot's read/search tools:
`builtin:view`, `builtin:read_file`, `builtin:file_search`, and `builtin:grep_search`.
In Copilot naming, `file_search` is the glob-style file finder and `grep_search` is text search.
Diffwarden also scrubs the Copilot repo-hook override environment variable before starting the
SDK runtime.
The SDK permission handler
approves `read` permission requests and rejects shell, write, URL, MCP, memory, custom-tool,
hook, extension, and other permission kinds.

The SDK path listens for `session.idle` after `session.send()` instead of calling
`sendAndWait()`, whose SDK default wait timeout is not Diffwarden policy. A configured reviewer
timeout, when set, remains the run-level circuit breaker.

By default the SDK path reads Copilot auth from `sdkOptions.baseDirectory`, then
`$COPILOT_HOME`, then `$HOME/.copilot`, stages only auth keys into a run-scoped Copilot home,
and points the runtime at that staged home. Diffwarden rejects SDK reviews when the source
Copilot home resolves inside the reviewed workspace, because Copilot's read/search tools are
intentionally allowed to inspect repository files. Explicit `sdkOptions.executable` runtime
overrides and GitHub CLI auth directories derived from `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`,
`HOME`, `USERPROFILE`, or Windows AppData must also resolve outside the reviewed workspace.
Set `sdkOptions.executable` to force the SDK runtime to spawn a Copilot-named runtime binary
or readable `.js` runtime entry. Diffwarden launches `.js` entries through Node. Otherwise,
Diffwarden resolves the SDK-bundled `@github/copilot` runtime entry explicitly. The resolved
runtime must live outside the reviewed workspace; source-checkout development installs should
configure an external runtime or use Copilot CLI transport when reviewing the Diffwarden
repository itself.

Copilot CLI transport uses `-p/--prompt` for non-interactive mode, writes the large assembled
review prompt to a run-scoped prompt file, requests JSONL output, and uses the same read/search
tool list. The CLI currently requires `--allow-all-tools` in non-interactive mode. Diffwarden
pairs it with `--available-tools view,read_file,file_search,grep_search`, explicit
write/shell/URL denials, disabled built-in and repo-configured MCP servers, disabled custom
instructions, disabled ask-user, disabled remote control, explicit `--add-dir` roots for the
prompt directory and a run-scoped tool-output temp directory, `COPILOT_ALLOW_ALL` scrubbing,
Node loader env scrubbing, and repo-hook override env scrubbing. Each CLI run receives a
temporary `HOME`/`COPILOT_HOME`, isolated `GH_CONFIG_DIR`, and Windows `APPDATA`/`LOCALAPPDATA`
scoped under that same temporary home. Diffwarden copies Copilot auth state from the source
Copilot home and GitHub CLI `hosts.yml` auth from `GH_CONFIG_DIR`, `XDG_CONFIG_HOME/gh`,
`$HOME/.config/gh`, or the standard Windows GitHub CLI config directory; installed plugins,
marketplaces, hooks, MCP config, personal skills, custom agents, other GitHub CLI config, and
user settings are not copied. The resolved Copilot CLI executable must live outside the
reviewed workspace because support probes execute before Copilot's tool policy applies. Copilot
documents that permission approvals do not expose tools filtered out by `--available-tools`,
and that denials take precedence over allow rules.

To call the CLI transport directly, define a reviewer id such as:

```json
{
  "reviewers": [
    {
      "id": "copilot-cli",
      "engine": "copilot",
      "transport": "cli"
    }
  ]
}
```

Then run:

```bash
diffwarden --target uncommitted --reviewer copilot-cli
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

Gemini CLI uses `--approval-mode plan` and JSON output, but Plan Mode alone still exposes
web, research, and planning surfaces that are broader than Diffwarden's review policy. For
review runs, Diffwarden writes a temporary Policy Engine admin policy that allows only
`read_file`, `list_directory`, `glob`, and Gemini's grep tool names (`grep_search` plus legacy
alias `search_file_content`), denies every MCP tool at a higher priority than the built-in allow
rule, denies every other built-in tool across all approval modes, passes the same file through
`--policy` and `--admin-policy`, passes
`--allowed-mcp-server-names ""`, and passes `--extensions none`. The duplicated policy path
preserves Diffwarden's user-tier policy when Gemini ignores supplemental admin policies because a
standard system admin policy directory already exists; a centrally configured admin policy can
still override lower-tier user policies if it explicitly conflicts with Diffwarden's review
policy. Gemini CLI preflight verifies the selected executable supports the required policy flags.
Diffwarden also unsets any inherited `GEMINI_CLI_TRUST_WORKSPACE`, points
`GEMINI_CLI_TRUSTED_FOLDERS_PATH` at a temporary empty trust database, and passes
`--skip-trust`. Gemini currently loads workspace settings before `--skip-trust` sets session
trust, so the isolated trust database prevents a review from inheriting repository workspace
settings or hooks from the user's persistent trusted-folders state while still allowing headless
prompt mode to start. Gemini CLI policy preflight uses the same inherited-trust scrub and
temporary trusted-folders isolation for its `--help` capability probe. Gemini may downgrade
approval mode for untrusted startup phases, which is why Diffwarden's generated policy applies
across all approval modes instead of only Plan Mode.
Diffwarden does not pass a Gemini tool-call, turn, step, retry, or equivalent cap; only a
configured reviewer timeout limits the run. Diffwarden also does not enable `--sandbox` by
default because Gemini sandboxing depends on provider-native local sandbox prerequisites; the
default read-only posture is the policy-restricted Plan Mode invocation.

OpenCode CLI receives the review prompt on stdin, adds transport-specific guidance to use the
embedded patch first, uses a generated low-tool `diffwarden-review-*` agent by default, and injects
`OPENCODE_CONFIG_CONTENT` with a generated agent that allows only `read`, `glob`, and `grep`
while denying every other tool permission unless the caller already supplied
OpenCode config through `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, or
selected `cliOptions.agent`. Diffwarden also sets `OPENCODE_PERMISSION` with the same tool
policy for the spawned process. Diffwarden does not inject an OpenCode step cap; only a
configured reviewer timeout limits the run. Set `cliOptions.agent` to use an existing
primary OpenCode agent.

Grok CLI writes the prompt to a temp file and runs headless with JSON output,
`--permission-mode dontAsk`, `--tools read_file,grep,list_dir`, `--disallowed-tools` for
web/search-replace/write/shell/subagent surfaces, explicit allow rules for `Read` and `Grep`,
explicit deny rules for `Bash`, `Edit`, `Write`, `WebFetch`, and `MCPTool`,
`--sandbox read-only`, `--no-subagents`, `--no-memory`, and `--disable-web-search`. The `read-only`
sandbox permits Grok's own `~/.grok` and temp writes but blocks repository writes for review
runs; the low-tool allowlist keeps the model on file read, directory listing, and grep search
tools. Diffwarden preflights the selected executable for these policy flags and does not pass
`--max-turns`; only a configured reviewer timeout limits the run.

SDK-backed families, including Droid and Copilot, can use `transport: "cli"` from config.
`cliOptions.executable` can point at non-standard CLI installs, such as local `pi`, `droid`,
`copilot`, or `agy` binaries. Droid SDK reviewers use `sdkOptions.executable`, with
`cliOptions.executable` kept as a legacy fallback. CLI auth is delegated to the underlying
executable, so live runs require each tool to be logged in or configured through its own
environment variables.

Antigravity uses `agy --print` because `agy` print mode expects the prompt as the flag value.
Diffwarden stores the full assembled review prompt in a temporary file and passes a short print
prompt telling `agy` to read that file, keeping the diff out of process argv while preserving
print-mode behavior. Review runs use `--sandbox` and a temporary `HOME`/`USERPROFILE` with an
isolated `~/.gemini/antigravity-cli/settings.json`; Windows `HOMEDRIVE` and `HOMEPATH` are
removed from the child environment so they cannot point back to the real profile. If the source
Antigravity profile has valid non-policy settings, Diffwarden copies them as the base after
filtering policy/control keys and then overwrites the review policy: `toolPermission` is `strict`,
terminal sandboxing is enabled, the artifact review policy asks for review, MCP config is empty,
and permissions deny `write_file(*)`, `command(*)`, `unsandboxed(*)`, `read_url(*)`,
`execute_url(*)`, and `mcp(*)`.
The temporary profile allows `read_file(*)`, disables non-workspace access, and trusts only the
reviewed repository plus a dedicated temp prompt directory for that run. `agy` runs from that
prompt directory, while the isolated home used for copied Antigravity auth identity files is a
separate sibling directory outside both the process cwd and trusted roots, so reviewer file reads
cannot inspect copied credentials. If the temp home would resolve inside the reviewed repository,
Diffwarden fails closed before copying credentials; the same fail-closed rule applies when the
source Antigravity `.gemini` directory is already inside the reviewed repository. Malformed
source settings are ignored and replaced by the generated review profile. Diffwarden uses the same
native roots for `--add-dir` and `trustedWorkspaces` so Windows drive-specific paths remain
distinct. Review runs do not inherit
permissive user settings such as `always-proceed`; explicitly sanitized home
environment variables, including an explicit child environment with no home path, are respected
and do not fall back to host credentials. Preflight requires `agy --version` to report `1.0.6`
or newer, because that release fixed sandbox propagation for headless print mode after the
permission system was introduced in `1.0.5`.

Claude CLI transport uses the same `sdkOptions.authMode` values as the Claude SDK adapter.
In `auto` mode, Diffwarden checks the selected Claude executable for logged-in Claude Code
auth with Anthropic API credentials removed, then removes those credentials from the actual
`claude -p` run when local Claude Code auth is available. The invocation uses
`--tools Read,Grep,Glob` as the built-in allowlist, matching `--allowedTools` for approval under
`--permission-mode dontAsk`, and `--disallowedTools` for write, shell, web, skill, agent, and
workflow surfaces. It also passes `--no-session-persistence`, an empty `--setting-sources`,
`--strict-mcp-config` with an empty MCP config file, `--disable-slash-commands`, and
`--no-chrome`. Claude CLI preflight verifies that the selected executable supports these policy
flags. Diffwarden does not pass `--max-turns`; only a configured reviewer timeout limits the run.

Capability metadata is conservative. Cursor SDK/CLI and OpenCode CLI currently report
prompt-only read-only behavior when hard enforcement is not proven. Antigravity CLI reports
tool-restricted behavior because Diffwarden supplies an isolated strict permissions profile, but
the guarantees still depend on Antigravity's settings and permission engine.

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
effort field. Gemini remains supported for enterprise and paid API-key users after Google's
June 18, 2026 consumer/free Gemini CLI transition to Antigravity CLI, but new runtime-metadata
extraction work should not build additional Gemini-specific behavior. Antigravity rejects model
and effort overrides.

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
DIFFWARDEN_LIVE_PI_MODEL=anthropic/claude-sonnet-4-5
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
