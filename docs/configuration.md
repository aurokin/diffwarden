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
      "sdk": "pi",
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

```json
{
  "reviewers": [
    {
      "id": "claude-cli",
      "sdk": "claude",
      "transport": "cli",
      "model": "sonnet",
      "effort": "high",
      "cliOptions": {
        "executable": "/Users/auro/.local/bin/claude"
      }
    },
    {
      "id": "droid-cli",
      "sdk": "droid",
      "transport": "cli",
      "cliOptions": {
        "executable": "/Users/auro/.local/bin/droid"
      }
    }
  ]
}
```
