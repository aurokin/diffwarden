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
diffwarden init
```

## Reviewer Selection

Use explicit reviewers:

```bash
diffwarden --target base:main --reviewer cursor
diffwarden --target base:main --reviewer claude
diffwarden --target base:main --reviewer pi:openrouter-high
diffwarden --target base:main --reviewer cursor --reviewer pi:openrouter-high
```

Use a configured reviewer set:

```bash
diffwarden --target base:main --reviewer-set 2
```

When no `--reviewer` or `--reviewer-set` is provided, config must define
`defaultReviewerSet`.

List configured reviewers and reviewer sets without invoking adapters or running preflight:

```bash
diffwarden reviewers list
diffwarden reviewers list --format json
```

Configured reviewers use `engine` for the reviewer family (`claude`, `pi`, `codex`, etc.).
Legacy configs that still use `sdk` continue to load and are normalized internally.
Use `transport: "native"` for the SDK-backed path when you want to be explicit, or
`transport: "cli"` for executable-backed runs. Codex also supports a
`transport: "app-server"` path for ephemeral `codex app-server` reviews.

## Environment Defaults

CLI flags take precedence over environment defaults.

```bash
DIFFWARDEN_REVIEWERS=cursor,claude,pi:openrouter-high
DIFFWARDEN_REVIEWER_SET=2
DIFFWARDEN_MODEL=anthropic/claude-sonnet-4-5
DIFFWARDEN_EFFORT=high
DIFFWARDEN_TIMEOUT_SECONDS=300
```

Reviewer selector environment defaults are only applied after a config file is discovered.
Without config, pass `--reviewer` or `--reviewer-set` explicitly.

## Reporting

Review history reports are off by default because they can contain finding bodies, reviewer
explanations, file paths, and other source-adjacent review content.

Enable reports for one run:

```bash
diffwarden --target base:main --reviewer-set 2 --report
```

Use repo-local history:

```bash
diffwarden --target base:main --reviewer-set 2 --report --report-scope repo
```

Use a custom directory:

```bash
diffwarden --target base:main --reviewer-set 2 --report --report-dir ./reports
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
report on one run. `--out` writes one explicit `ReviewArtifact` file; `--report` writes
date-partitioned history records for later external analysis.

### Report Provenance

Report records use `report_schema_version: 3`. Every report includes a `provenance` block
intended to make a run reproducible without persisting more patch content than necessary:

- `diffwarden.version`: the Diffwarden CLI version that wrote the report.
- `invocation`: the requested target, reviewers or reviewer set, model, effort, timeout,
  strict mode, finding gate, and output format when those options were supplied.
- `config`: the loaded config path and SHA-256 of the config file contents when a config file
  was used. The report does not embed config contents.
- `reviewer_selection`: the requested reviewer specs or reviewer set plus the resolved reviewer
  ids that actually ran.
- `target`: for diff-backed targets, SHA-256 and byte count of the reviewed patch. Reports do
  not persist the patch text as provenance, so `patch_persisted` is currently always `false`.

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
machine-readable runtime value. Gemini remains supported, but no new metadata-specific behavior
is being added for it.

Reports also promote these fields into each reviewer summary as `model_resolution` and
`effort_resolution` objects. Run adapter metadata is preferred; preflight metadata is used only
when run metadata is unavailable.

Privacy mode affects review content, not run provenance. `full` reports include the full
`ReviewArtifact`, which can contain source-adjacent review text. `metadata` reports omit the
artifact and finding bodies while retaining titles, locations, priorities, confidence scores,
counts, provenance, usage data, and adapter/preflight metadata.

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
      "id": "pi-shared",
      "engine": "pi",
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

Note: `"shared"` reads real credentials and **writes to `auth.json` on disk**: the file (and
its parent directory) is created empty if it does not yet exist, and the file is rewritten
when an expired OAuth token is refreshed (the same behavior as the Pi CLI). This is the one
way a review run touches state outside the repository; the default `"isolated"` mode never
reads or writes `auth.json`.

## CLI Transport Example

SDK-backed families can be configured to use a CLI transport.
Droid users should prefer the CLI profile for routine reviews when Factory UI session
history matters. Codex CLI disables Codex web search by default with
`web_search = "disabled"`; set `cliOptions.webSearch` to `"enabled"` or `"inherit"` when a
reviewer should use a different policy.

OpenCode CLI receives prompts on stdin and uses a generated `diffwarden-review-*` agent in
low-tool mode by default. Diffwarden supplies the patch in the prompt, allows only `read`,
`glob`, and `grep` through both `OPENCODE_CONFIG_CONTENT` and `OPENCODE_PERMISSION`, denies all
other OpenCode tool permissions, and tells OpenCode not to run the patch provenance command.
Diffwarden does not inject an OpenCode step cap; the reviewer timeout is the run-level
circuit breaker. Set `cliOptions.agent` to select an existing primary OpenCode agent. If
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
      "id": "droid-native-local-computer",
      "engine": "droid",
      "transport": "native",
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
execution remains available. Diffwarden sets Codex `web_search` to `"disabled"` by default.

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
diffwarden --target base:main --reviewer droid-cli --model claude-opus-4-7 --effort high
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
