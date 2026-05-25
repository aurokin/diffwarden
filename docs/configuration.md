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

Configured reviewers use `engine` for the reviewer family (`claude`, `pi`, `codex`, etc.).
Legacy configs that still use `sdk` continue to load and are normalized internally.
Use `transport: "native"` for the SDK-backed path when you want to be explicit, or
`transport: "cli"` for executable-backed runs.

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

## CLI Transport Example

SDK-backed families can be configured to use a CLI transport.
Droid users should prefer the CLI profile for routine reviews when Factory UI session
history matters.

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
        "machineId": "YOUR_DROID_COMPUTER_ID"
      }
    }
  ]
}
```

Run the configured Droid CLI profile through the normal CLI:

```bash
diffwarden --target base:main --reviewer droid-cli --model claude-opus-4-7 --effort high
```
