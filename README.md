# diffwarden

A small CLI for agent-callable code review.

`diffwarden` lets coding agents request a review of local changes, a branch diff, a single commit, or eventually a read-only PR target, then receive Markdown or structured JSON findings. The CLI owns target resolution, review prompting, parsing, validation, and rendering; reviewer SDKs live behind adapters.

## Intended public contract

```bash
diffwarden --target base:main
diffwarden --target uncommitted --reviewer cursor
diffwarden --target base:main --reviewer claude
diffwarden --target base:main --reviewer claude --model sonnet --effort high
diffwarden --target base:main --reviewer pi --model anthropic/claude-sonnet-4-5
diffwarden --target base:main --reviewer-set 2
diffwarden --target base:main --reviewer cursor --reviewer pi:openrouter-high
diffwarden --target commit:abc123
diffwarden --target base:main --format json
```

## Read order

1. [`SPEC.md`](./SPEC.md) — product and architecture specification.
2. [`REFERENCES.md`](./REFERENCES.md) — upstream documentation and source-of-truth links.
3. [`QUALITY.md`](./QUALITY.md) — current lint, test, coverage, complexity, and e2e commands.

## Current status

Initial TypeScript scaffold is implemented with target resolution, fake reviewer plumbing, review parsing/rendering/validation, `diffwarden.config.json` discovery, reviewer sets, a shared `sdk[:profile]` reviewer-spec parser, Cursor, Claude, and Pi Agent SDK adapters, and thin CLI transport adapters for Codex, Gemini, OpenCode, Grok, Antigravity, plus CLI variants of Cursor, Claude, and Pi. The planned public GitHub repository is `aurokin/diffwarden`, and the CLI binary name is `diffwarden`; npm publishing is not part of the current plan.

The project requires Node `>=22.19.0`, matching the Pi SDK package family.

The intended v1 target surface is:

- `uncommitted`
- `base:<branch>`
- `commit:<sha>`

`--format json` prints the full `ReviewArtifact`, including reviewers, target, result, validation, and timing metadata. Multi-reviewer runs preserve each reviewer result in `reviewers` and aggregate findings into the top-level `result`.

When no `--reviewer` or `--reviewer-set` is provided, config must define `defaultReviewerSet`; otherwise the CLI exits with a config-required error. For local development and credential-free tests, pass `--reviewer fake` explicitly.

Create a starter user config with:

```bash
diffwarden init
```

CLI flags take precedence over environment defaults. Supported defaults are:

```bash
DIFFWARDEN_REVIEWERS=cursor,claude,pi:openrouter-high
DIFFWARDEN_REVIEWER_SET=2
DIFFWARDEN_MODEL=anthropic/claude-sonnet-4-5
DIFFWARDEN_EFFORT=high
DIFFWARDEN_TIMEOUT_SECONDS=300
```

Reviewer selector environment defaults are only applied after a config file is discovered. Without config, pass `--reviewer` or `--reviewer-set` explicitly.

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

Set `INTEGRATION_DISABLE=cursor,claude,pi` with any SDK names that should remain disabled during broader live test runs.

The adapter uses `@cursor/sdk`. That SDK currently depends on `sqlite3`, so `package.json` allows pnpm to run the `sqlite3` build script through `pnpm.onlyBuiltDependencies`.

## Claude reviewer

The Claude adapter is available with:

```bash
diffwarden --target uncommitted --reviewer claude
```

It can use either `ANTHROPIC_API_KEY` or a locally authenticated Claude Code executable:

```bash
ANTHROPIC_API_KEY=... pnpm dev -- --target uncommitted --reviewer claude
pnpm dev -- --target uncommitted --reviewer claude
```

The opt-in live smoke test is:

```bash
INTEGRATION_TEST_ON=1 pnpm vitest run test/claude-adapter.test.ts
```

Set `INTEGRATION_DISABLE=claude` to skip this smoke test during broader live test runs.

The adapter uses `@anthropic-ai/claude-agent-sdk` with built-in tools disabled, `permissionMode: "dontAsk"`, isolated setting sources, and native JSON Schema output. If no API key is present and `claude auth status --json` reports a logged-in account, the SDK is pointed at the local `claude` executable so Claude Code auth can be reused. If the SDK does not return structured output, the adapter falls back to text capture.

## Pi reviewer

The Pi adapter is available with:

```bash
diffwarden --target uncommitted --reviewer pi --model anthropic/claude-sonnet-4-5
```

The adapter loads `@earendil-works/pi-coding-agent`, checks environment-backed authenticated models through Pi `AuthStorage` and `ModelRegistry`, runs with a scoped model list, and captures structured output through a terminating `review_output` tool.

Reviewer profile suffixes such as `pi:openrouter-high` resolve through `diffwarden.config.json` when a matching reviewer profile exists. `--model` and `--effort` are available for the single-reviewer override path; multi-reviewer runs should put those choices in named reviewer profiles.

Provider-backed Pi profiles can keep provider-specific auth and base URL wiring in config while leaving the public CLI surface unchanged:

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

Project config is discovered as `diffwarden.config.json` from the current directory upward to the git repo root. User config is discovered at `$XDG_CONFIG_HOME/diffwarden/diffwarden.config.json`, or `~/.config/diffwarden/diffwarden.config.json` when `XDG_CONFIG_HOME` is unset.

The Pi path reports a tool-restricted read-only capability. It passes only `read`, `grep`, `find`, `ls`, and `review_output` as active tools, uses an extension-free resource loader, and keeps tests credential-free by default.

The opt-in live smoke test is:

```bash
INTEGRATION_TEST_ON=1 pnpm vitest run test/pi-adapter.test.ts
```

Set `INTEGRATION_DISABLE=pi` to skip this smoke test during broader live test runs.

By default, the smoke test requests `anthropic/claude-sonnet-4-5` to avoid Pi's deprecated first available Anthropic model. A different authenticated model can be selected with `PI_SMOKE_MODEL`:

```bash
INTEGRATION_TEST_ON=1 PI_SMOKE_MODEL=anthropic/claude-opus-4-5 pnpm vitest run test/pi-adapter.test.ts
```

The smoke test requires real Pi-compatible provider auth in the environment, such as `ANTHROPIC_API_KEY`, and may make a real model request.

## CLI transport reviewers

SDK adapters remain the default for `cursor`, `claude`, and `pi`. CLI-only reviewers use `transport: "cli"` automatically:

```bash
diffwarden --target uncommitted --reviewer codex
diffwarden --target uncommitted --reviewer gemini
diffwarden --target uncommitted --reviewer opencode
diffwarden --target uncommitted --reviewer grok
diffwarden --target uncommitted --reviewer antigravity
```

Configured reviewers can also opt an SDK-backed family into the CLI transport:

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
    }
  ]
}
```

The shared CLI adapter performs executable preflight, runs the selected CLI in its most restrictive documented review mode, and returns either native structured output or text for the core parser. `cliOptions.executable` can point at non-standard installs, such as local `pi` or `agy` binaries. CLI auth is delegated to the underlying executable, so live runs require each tool to be logged in or configured through its own environment variables. Capability metadata is conservative; OpenCode and Antigravity currently report `prompt-only` read-only behavior.

The intended primary reviewer surface is still the Cursor Agent SDK, Claude Agent SDK, and Pi Agent SDK when those SDKs are available. CLI transports exist for engines without a usable SDK path and for subscription-auth workflows where the executable is the stable integration point.

Configuration is required for real SDK runs. The default reviewer should be a configured Pi profile because Pi supports the broadest provider surface. Claude subscription users should configure the Claude Agent SDK, Cursor subscription users should configure the Cursor Agent SDK, and other providers should generally route through Pi profiles.

Model selection is a base CLI option via `--model`. Effort, provider, and SDK-specific settings are represented as reviewer config. Simple single-reviewer runs can use flags like `--model` and `--effort`; multi-reviewer/provider-heavy runs should use named profiles like `pi:openrouter-high`.

The public effort values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Pi clamps requested effort through model metadata and records requested/effective/supported values; Claude maps those values to native effort/thinking controls; Cursor records requested effort as ignored until the SDK exposes an effort control.

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
