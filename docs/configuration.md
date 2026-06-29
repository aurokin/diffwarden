# Configuration

`diffwarden` keeps the public CLI small and routes SDK/provider detail through
configuration.

## Config Discovery

Project config is discovered as `diffwarden.config.json` from the current directory upward
to the Git repo root.

User config is discovered at:

- `$XDG_CONFIG_HOME/diffwarden/diffwarden.config.json`
- `~/.config/diffwarden/diffwarden.config.json` when `XDG_CONFIG_HOME` is unset

Create a starter user config with:

```bash
diffwarden init              # in a TTY: guided discovery; non-TTY or --json: static starter
diffwarden init --discover   # force the discovery scaffold (prompts in a TTY)
diffwarden init --json       # static starter config, never interactive
```

In a terminal, a bare `diffwarden init` drops into the guided discover → scaffold → confirm
flow. Pass `--json`, or run in a non-TTY (CI, piped), to write the static starter template
instead. `init` and `reviewers add` always write to the user config path above, never to a
project `diffwarden.config.json`. See [Discovery & Setup](#discovery--setup).

## Reviewer Selection

Use explicit reviewers:

```bash
diffwarden review --target base:main --reviewer cursor
diffwarden review --target base:main --reviewer claude
diffwarden review --target base:main --reviewer pi:openrouter-high
diffwarden review --target base:main --reviewer cursor --reviewer pi:openrouter-high
```

Use a configured reviewer set:

```bash
diffwarden review --target base:main --reviewer-set 2
```

When no `--reviewer` or `--reviewer-set` is provided, config must define
`defaultReviewerSet`.

List configured reviewers and reviewer sets without invoking adapters or running preflight:

```bash
diffwarden reviewers list
diffwarden reviewers list --json
```

Configured reviewers must use `engine` for the reviewer family (`claude`, `pi`, `codex`,
etc.). Use `transport: "sdk"` for the SDK-backed path when you want to be explicit, or
`transport: "cli"` for executable-backed runs. Codex also supports a `transport: "app-server"`
path for ephemeral `codex app-server` reviews.

## Discovery & Setup

Three commands answer three different questions. None of them publish review comments, and
discovery never spends model budget:

- `diffwarden reviewers discover` — *What could this host run?* Probes every built-in reviewer
  engine for an installed executable or resolvable SDK package and for token-free auth signals
  (relevant environment variables and credential files), then classifies each candidate. It
  reads nothing from your config and writes nothing.
- `diffwarden reviewers list` — *What is configured?* Lists the reviewers, reviewer sets, and
  `defaultReviewerSet` already in config. It does not probe the host.
- `diffwarden doctor` — *Will a configured reviewer actually run?* Resolves reviewers from
  config and runs full adapter preflight (which may spawn CLIs or call provider APIs).

Discovery is shallow by default: it inspects `PATH`, resolvable SDK packages, environment
variables, and credential-file presence only. Pass `--deep` to additionally run adapter
preflight for present engines, which can spawn CLIs or make provider calls:

```bash
diffwarden reviewers discover
diffwarden reviewers discover --deep
diffwarden reviewers discover --json
```

Each candidate is classified as one of `available`, `missing_executable`, `missing_auth`,
`requires_env`, `unsupported_host`, or `preflight_failed`. `available` candidates carry a
recommended config entry. JSON output uses `schema_version: 1`; it reports environment
variable *names* and credential-file *paths* that were probed but never secret values.

Write a discovered reviewer into the user config with `reviewers add`:

```bash
diffwarden reviewers add codex                       # add with defaults, id "codex"
diffwarden reviewers add claude --transport cli      # add CLI-transport Claude
diffwarden reviewers add pi --id pi-fast --set 1     # custom id, also append to set "1"
diffwarden reviewers add grok --disabled             # write a disabled placeholder
```

`reviewers add` merges by `id` (re-adding an existing id updates it in place), appends to a
named reviewer set with `--set` without ever changing `defaultReviewerSet`, preserves every
other key in the file, and writes atomically. Adding a reviewer never enables it into the
default set silently; choose the set explicitly. Scaffold a whole config from discovery in one
step with `init --discover`, which writes the ready-to-use reviewers, a `defaultReviewerSet`,
and `readonly: true`, and refuses to overwrite an existing config.

Edit, remove, and manage set membership of existing reviewers with the same atomic,
user-config-only write contract:

```bash
diffwarden reviewers edit codex --model gpt-5.1-codex  # patch one field, keep the rest
diffwarden reviewers edit grok --enabled               # clear a disabled placeholder
diffwarden reviewers set add 1 codex                   # add a configured id to set "1"
diffwarden reviewers set remove 1 codex                # remove it from set "1"
diffwarden reviewers remove codex                      # delete it and prune it from all sets
```

`edit` patches only the named fields (preserving `sdkOptions`, `profile`, `enabled: false`, and
every untouched key) and rejects overrides the resolved transport cannot honor before writing,
just like `add`. `remove` deletes the reviewer and prunes its id from every reviewer set so sets
never reference a missing reviewer. Both `remove` and `set remove` refuse to leave the set named
by `defaultReviewerSet` empty unless you pass `--force`; removing or editing an unknown id exits
non-zero and writes nothing. `set add` requires the id to be a configured reviewer.

Interactive setup is the default in a TTY. A bare `diffwarden reviewers add` opens the
discovered-reviewer picker, a bare `diffwarden init` runs the discover/scaffold flow, and a
bare `reviewers remove` or `reviewers edit <field>` lets you pick which configured reviewer to
act on (`edit` still needs at least one field flag, which chooses *what* to change). Naming a
target — an engine, an id — passing `--json`, or running outside a TTY (CI, piped) stays fully
declarative and never prompts; a no-target setup command in a non-TTY exits with a usage error
rather than hanging. `--interactive` forces the guided flow for `add` and `init` even when a
target is named, and still requires a real TTY.

## Disabling Configured Reviewers

Set `enabled: false` on a configured reviewer when it should stay in config but must not run,
for example when a local app, CLI, or provider is temporarily unavailable. Omitted `enabled`
means enabled.

```json
{
  "reviewers": [
    {
      "id": "droid-cli",
      "engine": "droid",
      "transport": "cli",
      "enabled": false
    }
  ]
}
```

Disabled reviewers remain visible in `diffwarden reviewers list` and JSON output as
`enabled: false`. Selecting a disabled configured reviewer fails with a config error, whether
it is selected directly by id, through an `engine:profile` spec, through `reviewerSets`, or
through `defaultReviewerSet`. Diffwarden does not silently skip disabled reviewers because
that could change who reviewed a patch. Bare built-in specs such as `claude`, `pi`, or
`droid` are unaffected, even if a configured reviewer id happens to match a built-in name.

## Environment Defaults

CLI flags take precedence over environment defaults.

```bash
DIFFWARDEN_REVIEWERS=cursor,claude,pi:openrouter-high
DIFFWARDEN_REVIEWER_SET=2
DIFFWARDEN_MODEL=anthropic/claude-sonnet-4-5
DIFFWARDEN_EFFORT=high
# Optional: only set this when a review should have a wall-clock cap.
DIFFWARDEN_TIMEOUT_SECONDS=1800
```

Reviewer selector environment defaults are only applied after a config file is discovered.
Without config, pass `--reviewer` or `--reviewer-set` explicitly.

## Focus Review Defaults

Focused diff-backed reviews include the normal overview lane by default when one or more
`--focus` flags are present. Configure the default with `reviewPlan.includeOverview`:

```json
{
  "reviewPlan": {
    "includeOverview": false
  }
}
```

CLI flags override config for one run:

```bash
diffwarden review --target base:main --reviewer-set 2 --focus "focus on state" --overview
diffwarden review --target base:main --reviewer-set 2 --focus "focus on state" --no-overview
```

`--overview` and `--no-overview` only apply when at least one focus lane is requested.
Focus lanes are diff-backed instruction layers over `uncommitted`, `base:<branch>`, and
`commit:<sha>` targets; they are not compatible with repository-scoped `custom:<text>`.

## Reporting

Review history reports are off by default because they can contain finding bodies, reviewer
explanations, file paths, and other source-adjacent review content.

Enable reports for one run:

```bash
diffwarden review --target base:main --reviewer-set 2 --report
```

Use repo-local history:

```bash
diffwarden review --target base:main --reviewer-set 2 --report --report-scope repo
```

Use a custom directory:

```bash
diffwarden review --target base:main --reviewer-set 2 --report --report-dir ./reports
```

Config can opt in globally or per project:

```json
{
  "reporting": {
    "enabled": true,
    "scope": "global",
    "mode": "full"
  }
}
```

Reporting options:

- `enabled`: write report history when true.
- `scope`: `global` or `repo`. Global writes under the user state directory. Repo writes
  under `.diffwarden/reports/` in the Git repo root.
- `dir`: custom report directory. Relative paths resolve from the CLI cwd and override
  `scope`.
- `mode`: `full` stores the full review artifact. `metadata` omits the full artifact and
  finding bodies while preserving titles, locations, priorities, confidence, reviewer
  metadata, and counts.

CLI flags take precedence over config, including `--no-report` for disabling a configured
report on one run. `--out` writes one explicit review artifact file; `--report` writes
date-partitioned history records for later external analysis.

### Report Provenance

Report records use `report_schema_version: 3`. Every report includes a `provenance` block
intended to make a run reproducible without persisting more patch content than necessary:

- `diffwarden.version`: the Diffwarden CLI version that wrote the report.
- `invocation`: the requested target, reviewers or reviewer set, model, effort, timeout,
  strict mode, finding gate, and output mode when those options were supplied.
- `config`: the loaded config path and SHA-256 of the config file contents when a config file
  was used. The report does not embed config contents.
- `reviewer_selection`: the requested reviewer specs or reviewer set plus the resolved reviewer
  ids that actually ran.
- `target`: for diff-backed targets, SHA-256 and byte count of the reviewed patch. Reports do
  not persist the patch text as provenance, so `patch_persisted` is currently always `false`.

Focus batch reports also record `focus`, `include_overview`, and the resolved `review_plan`
under invocation provenance. These fields are persisted in metadata mode because they are
needed to reproduce the review plan. The shared diff hash and byte count are stored once for
the batch target, not once per lane.

Reviewer entries preserve adapter output metadata, preflight metadata, and adapter usage data
when the adapter provides them. Adapter and executable version data are therefore best-effort:
SDK adapters record SDK/version details where they already discover them, while CLI adapters do
not run extra `--version` probes solely for reporting.

Executable-backed adapters include the resolved `executable` path plus `requestedExecutable`
and `executableSource`. `executableSource: "config"` means the executable string came from
reviewer executable config, usually `cliOptions.executable` and for Droid SDK
`sdkOptions.executable`; `adapter-default` means Diffwarden used the built-in executable name
and resolved it from `PATH`. These fields describe Diffwarden's launcher selection, not a
provider-observed runtime value.

Adapter metadata may include `requestedModel`, `resolvedModel`, `modelResolutionSource`,
`requestedEffort`, `resolvedEffort`, and `effortResolutionSource`. These fields preserve the
requested config/CLI value separately from the value Diffwarden can prove was selected.
`config` resolution sources mean the value came from Diffwarden reviewer configuration, which
is useful provenance but lower confidence than provider-observed runtime metadata. `env` means
the value came from `DIFFWARDEN_MODEL` or `DIFFWARDEN_EFFORT`. SDK adapters prefer
provider-observed values where available. CLI adapters report deterministic values that
Diffwarden passes on the command line, but provider-observed values from stable runtime
JSON/JSONL metadata take precedence when available. Claude CLI's single-model `modelUsage`
result is used only when no explicit runtime model field is present, and is normalized to remove
display-only formatting such as a trailing context-window suffix. Droid CLI stdout currently
omits model and effort fields, but Diffwarden can read Droid's local session settings file from
the returned `session_id` and report those values as provider-local metadata when the file is
available and Diffwarden did not already select model or effort from config, env, or per-run
overrides. Droid lookup starts with the encoded cwd directory and falls back to a one-level
session-id search under `~/.factory/sessions` for path-encoding compatibility. When explicit
Droid CLI model or non-`off` effort settings are present, Droid session values are retained as
`droidSessionModel` and `droidSessionEffort` but are not promoted over the selected values.
Because Droid CLI omits an off effort flag, session settings may still provide the resolved
runtime effort for `effort: "off"` while preserving `requestedEffort: "off"`. Pi CLI's assistant
`message.model` records are treated as runtime-result evidence, not startup configuration proof.
CLI adapters omit default model resolution when the executable does not expose a stable
machine-readable runtime value. Gemini remains supported for enterprise and paid API-key users
after Google's June 18, 2026 consumer/free Gemini CLI transition to Antigravity CLI, but no new
metadata-specific behavior is being added for it.

Droid CLI stream modes are not used for review metadata today. CLI reviews keep the single-shot
JSON/text contract plus `session_id` session-settings lookup for Factory UI-friendly routine
runs.

Reports also promote these fields into each reviewer summary as `model_resolution` and
`effort_resolution` objects. Run adapter metadata is preferred; preflight metadata is used only
when run metadata is unavailable.

Privacy mode affects review content, not run provenance. `full` reports include the full
review artifact, which can contain source-adjacent review text. For focus runs this is the
full `ReviewBatchArtifact`. `metadata` reports omit the artifact and finding bodies while
retaining titles, locations, priorities, confidence scores, counts, lane summaries,
provenance, usage data, and adapter/preflight metadata.

## Model And Effort

Model selection is a base CLI option via `--model`.

Effort, provider, and SDK-specific settings are represented as reviewer config. Simple
single-reviewer runs can use flags like `--model` and `--effort`; multi-reviewer/provider
runs should use named profiles.

Public effort values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## Pi Provider Profile Example

Provider-backed Pi profiles can keep provider-specific auth and base URL wiring in config
while leaving the public CLI surface unchanged.
Use named profiles for reusable reviewer sets and pin `provider`, `model`, and usually
`effort`. Bare `--reviewer pi` remains useful for ad hoc local runs, but it selects the first
authenticated Pi model when no model is configured; that choice can drift as auth state or
Pi's model registry changes.

```json
{
  "reviewers": [
    {
      "id": "pi-openrouter-high",
      "engine": "pi",
      "profile": "openrouter-high",
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet",
      "effort": "high",
      "providerOptions": {
        "baseUrlEnv": "OPENROUTER_BASE_URL",
        "apiKeyEnv": "OPENROUTER_API_KEY"
      },
      "sdkOptions": {
        "providerProfile": "openrouter"
      }
    }
  ]
}
```

## Pi Shared CLI Auth Example

By default the Pi SDK adapter uses isolated, in-memory auth and only sees provider
credentials supplied through environment variables. Set `sdkOptions.authSource` to
`"shared"` to reuse the Pi CLI's on-disk login (`auth.json`) instead, including OAuth
logins such as `openai-codex`. This reads the same credentials the `pi` CLI uses and
auto-refreshes OAuth tokens with file locking, without spawning the CLI.

```json
{
  "reviewers": [
    {
      "id": "pi-shared-codex-high",
      "engine": "pi",
      "provider": "openai-codex",
      "model": "gpt-5.5",
      "effort": "high",
      "sdkOptions": {
        "authSource": "shared"
      }
    }
  ]
}
```

`authSource` accepts `"isolated"` (default) or `"shared"`. With `"shared"` you may set an
optional `sdkOptions.authPath` to point at a non-default `auth.json` (a leading `~` is
expanded to the home directory); `authPath` is rejected unless `authSource` is `"shared"`.
Environment-backed provider auth still composes on top of shared credentials.

Use isolated auth with `providerOptions.apiKeyEnv`/`baseUrlEnv` when the profile should be
fully described by Diffwarden config and environment variables, such as CI or provider API
key workflows. Use shared auth when the intended provider/model depends on a Pi CLI OAuth
login that cannot be represented as an API key. In both modes, reusable provider-heavy
profiles should pin the model instead of relying on Pi's first authenticated model.

Note: `"shared"` reads real credentials and **writes to `auth.json` on disk**: the file (and
its parent directory) is created empty if it does not yet exist, and the file is rewritten
when an expired OAuth token is refreshed (the same behavior as the Pi CLI). This is the one
way a review run touches state outside the repository; the default `"isolated"` mode never
reads or writes `auth.json`.

## Pi SDK Runtime Settings

The Pi SDK adapter always supplies an isolated in-memory `SettingsManager` for review runs.
Diffwarden does not inherit global or project Pi `settings.json` files, and it does not add
tool-call, turn, step, retry, or default wall-clock caps around Pi. A configured reviewer
timeout, when set, is the authoritative run-level circuit breaker.

Diffwarden passes explicit Pi runtime defaults for review sessions:

```json
{
  "transport": "auto",
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time"
}
```

Set `sdkOptions.settings` on a Pi reviewer when a run needs a different Pi SDK runtime
setting without inheriting settings files:

```json
{
  "reviewers": [
    {
      "id": "pi-websocket",
      "engine": "pi",
      "sdkOptions": {
        "settings": {
          "transport": "websocket",
          "thinkingBudgets": {
            "high": 12000
          }
        }
      }
    }
  ]
}
```

Supported `sdkOptions.settings` fields are `transport`, `steeringMode`, `followUpMode`, and
`thinkingBudgets`; unsupported keys are rejected rather than ignored. `thinkingBudgets`
supports `minimal`, `low`, `medium`, and `high`. Preflight and output metadata report those
runtime settings plus the effective Pi-native retry/provider/compaction settings that Pi will
use for the session. Provider request timeout and retry values may appear as SDK defaults when
Pi leaves them unset. HTTP idle timeout is reported as an SDK default when the installed Pi
SDK exposes it; otherwise metadata marks it as unavailable rather than inferring a value from
upstream docs.

## CLI Transport Example

SDK-backed families can be configured to use a CLI transport.
Droid users should prefer the CLI profile for routine reviews when Factory UI session
history matters. Droid CLI uses `droid exec --use-spec`, keeps Droid's default read-only
autonomy by leaving mission/unsafe autonomy flags unset, uses an explicit read/spec-control
tool allowlist, verifies that allowlist with `--list-tools`, adds a Diffwarden log group ID,
and relies only on an explicitly configured reviewer timeout rather than tool-call, turn, step,
or retry caps.
Codex CLI disables Codex web search by default with
`web_search = "disabled"`; set `cliOptions.webSearch` to `"enabled"` or `"inherit"` when a
reviewer should use a different policy.

Copilot defaults to SDK transport. Set `sdkOptions.baseDirectory` to use a dedicated Copilot
home, or `sdkOptions.executable` to force a Copilot-named runtime binary or readable `.js`
runtime entry for the SDK path. Diffwarden launches `.js` runtime entries through Node. SDK
runs stage only auth keys from the source Copilot home into a temporary Copilot home with empty
MCP config.
SDK reviews fail closed if the source Copilot home, resolved SDK runtime, or GitHub CLI auth
directory is inside the reviewed repository.
Set `transport: "cli"` and `cliOptions.executable` to run the Copilot CLI directly.
CLI runs use a run-scoped `HOME`/`COPILOT_HOME`, isolated `GH_CONFIG_DIR`, and scoped Windows
AppData paths, copy Copilot auth plus GitHub CLI `hosts.yml` auth from `GH_CONFIG_DIR`,
`XDG_CONFIG_HOME`, home, or Windows AppData locations, use `-p/--prompt` for non-interactive
mode with a short instruction that points at a run-scoped prompt file, and add only that prompt
directory plus a run-scoped tool-output temp directory with `--add-dir`. User-level Copilot
MCP config is replaced by an empty staged file; only repo-local MCP configs are parsed for
explicit `--disable-mcp-server` flags. The resolved Copilot CLI executable must be outside the
reviewed workspace, including executables found through `PATH`.

OpenCode CLI receives prompts on stdin and uses a generated `diffwarden-review-*` agent in
low-tool mode by default. Diffwarden supplies the patch in the prompt, allows only `read`,
`glob`, and `grep` through both `OPENCODE_CONFIG_CONTENT` and `OPENCODE_PERMISSION`, denies all
other OpenCode tool permissions, and tells OpenCode not to run the patch provenance command.
Diffwarden does not inject an OpenCode step cap; only a configured reviewer timeout limits the
run. Set `cliOptions.agent` to select an existing primary OpenCode agent. If
`cliOptions.agent` is set, or if `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, or
`OPENCODE_CONFIG_DIR` is already present in the effective environment passed to OpenCode,
Diffwarden does not inject the generated agent config.

```json
{
  "reviewers": [
    {
      "id": "claude-cli",
      "engine": "claude",
      "transport": "cli",
      "model": "sonnet",
      "effort": "high",
      "cliOptions": {
        "executable": "/Users/auro/.local/bin/claude"
      }
    },
    {
      "id": "droid-cli",
      "engine": "droid",
      "transport": "cli",
      "cliOptions": {
        "executable": "/Users/auro/.local/bin/droid"
      }
    },
    {
      "id": "copilot-sdk",
      "engine": "copilot",
      "transport": "sdk",
      "sdkOptions": {
        "baseDirectory": "/Users/auro/.copilot-diffwarden",
        "executable": "/Users/auro/.local/bin/copilot"
      }
    },
    {
      "id": "droid-sdk-local-computer",
      "engine": "droid",
      "transport": "sdk",
      "sdkOptions": {
        "executable": "/Users/auro/.local/bin/droid",
        "machineId": "YOUR_DROID_COMPUTER_ID"
      }
    }
  ]
}
```

## Codex App-Server Example

Codex can opt into an app-server transport. By default this path uses the
existing shared Codex home, connects to its app-server socket when one is already running,
and launches `codex app-server --listen unix://` only when no socket is available. Reviews
still start ephemeral read-only threads and record `execEnabled: true` because command
execution remains available as Codex-native model tool behavior; approval escalations are
denied. Diffwarden sets Codex `web_search` to `"disabled"` by default.

```json
{
  "reviewers": [
    {
      "id": "codex-app-server",
      "engine": "codex",
      "transport": "app-server",
      "cliOptions": {
        "executable": "/opt/homebrew/bin/codex"
      },
      "appServerOptions": {
        "webSearch": "disabled",
        "reviewMode": "structured"
      }
    }
  ]
}
```

`appServerOptions.webSearch` accepts:

- `disabled`: set Codex `web_search = "disabled"`. This is the default.
- `enabled`: set Codex `web_search = "live"` for the review.
- `inherit`: do not override Codex web search for the thread.

In `stdio-isolated` mode, `inherit` copies the source Codex home's top-level `web_search`
setting into the temporary `CODEX_HOME` when one is configured.

`appServerOptions.reviewMode` accepts:

- `structured`: use Diffwarden's schema-constrained `turn/start` flow. This is the default.
- `native`: use experimental Codex `review/start` mode and return Codex's rendered review
  text. This mode is text-only for Diffwarden artifacts unless the text contains parseable
  `ReviewResult` JSON.

In native mode, Codex disables web search inside the review task regardless of the parent
thread's `web_search` setting. Diffwarden reports `webSearchMode: "disabled"` and preserves
the requested parent-thread setting as `requestedWebSearchMode` when one was configured.
Configured effort overrides still apply; Diffwarden passes them through thread config as
`model_reasoning_effort` because `review/start` has no per-request effort field.

The shared Codex home resolves from `appServerOptions.codexHome`, then
`DIFFWARDEN_CODEX_HOME`, then `DIFFWARDEN_CODEX_AUTH_HOME`, then `$CODEX_HOME`, then
`$HOME/.codex`. Shared mode intentionally uses that Codex home's auth, config, plugins,
apps, and daemon state. Diffwarden still sets approval policy `never`, uses a read-only
sandbox policy with network disabled, and denies approval escalations.

`appServerOptions.codexHome` applies to shared socket modes. In `stdio-isolated` mode,
Diffwarden creates a temporary `CODEX_HOME` for the app-server process and sources auth and
model-provider config from `DIFFWARDEN_CODEX_AUTH_HOME`, then `$CODEX_HOME`, then
`$HOME/.codex`.

Use a stable alternate Codex home when you want a reusable server without sharing the
primary Codex config:

```json
{
  "reviewers": [
    {
      "id": "codex-app-server",
      "engine": "codex",
      "transport": "app-server",
      "appServerOptions": {
        "mode": "auto",
        "codexHome": "~/.codex-diffwarden"
      }
    }
  ]
}
```

`appServerOptions.mode` accepts:

- `auto`: attach to an existing socket and launch only if none exists.
- `attach`: attach only and fail if the socket is unavailable.
- `launch`: reuse an existing socket or launch the shared server.
- `stdio-isolated`: use a temporary `CODEX_HOME` and stdio app-server process for each review.

Run the configured Droid CLI profile through the normal CLI:

```bash
diffwarden review --target base:main --reviewer droid-cli --model claude-opus-4-7 --effort high
```

## Claude Auth Mode

Claude reviewers default to `sdkOptions.authMode: "auto"` for both SDK and CLI transports.
Auto mode prefers a logged-in Claude Code account over `ANTHROPIC_API_KEY` and removes
Anthropic API credentials from the child environment when Claude Code auth is selected. This
keeps reviewer sets from silently consuming API credits when a local Claude Code subscription
is available.

Use `claude-code` or `api-key` to make the choice explicit:

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

## Claude Tool Policy

Claude SDK and CLI reviews use a small read-only review surface: `Read`, `Grep`, and `Glob`.
Current Claude documentation treats `allowedTools` as auto-approval rules, not as an
availability allowlist. Diffwarden therefore restricts SDK built-in tools with `tools`, mirrors
that list into `allowedTools`, uses `permissionMode: "dontAsk"` so anything outside the
approved read tools is denied instead of prompting, and sets `strictMcpConfig: true` with an
empty MCP server map. It also sends explicit deny rules for high risk surfaces such as `Bash`,
`PowerShell`, `Monitor`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`,
`Skill`, and `Workflow`.

Claude CLI reviews mirror the same policy with `--tools`, `--allowedTools`,
`--disallowedTools`, and `--permission-mode dontAsk`. The CLI path also disables session
persistence, settings sources, ambient MCP config, slash commands, and Chrome integration for
the review invocation.

`LS` is not included. The current Claude tools reference no longer lists an `LS` built-in tool,
and `Glob` is sufficient for path discovery inside Diffwarden's restricted review surface.
Diffwarden does not add Claude tool-call, turn, step, or retry caps around normal reviews; the
configured reviewer timeout, when set, is the run-level circuit breaker. Claude-native limits
may still apply,
including model context limits, structured-output retry behavior, provider output limits, and
built-in tool result limits.

Diffwarden checks local Claude Code executables for the required review policy flags before
using them. In `sdkOptions.authMode: "auto"`, an outdated local Claude Code install falls back
to `ANTHROPIC_API_KEY` when an API key is available. In forced `claude-code` mode or CLI
transport, unsupported executables fail preflight with a missing-requirement error.
