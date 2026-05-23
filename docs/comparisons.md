# Comparisons

Use this guide when deciding whether Diffwarden is the right review runner for a
workflow, and when choosing SDK or CLI transports for a reviewer.

## Diffwarden vs Codex Review

Codex has a first-class review path. In the upstream Codex repository at commit
[`7d47056ea4`](https://github.com/openai/codex/tree/7d47056ea4), Codex exposes
non-interactive review through `codex review` and accepts these targets:

- `--uncommitted`
- `--base <branch>`
- `--commit <sha>`
- custom review instructions as a prompt

Codex review is the best fit when the caller is already inside Codex and wants a
single Codex-owned review experience. It is integrated with Codex session state,
review-mode UI, Codex's review rubric, and Codex's own model/runtime selection.

Diffwarden is useful when code review needs to be agent-callable outside Codex or
needs orchestration that Codex review does not own:

- A single CLI contract for Codex, Claude, Cursor, Pi, Droid, Gemini, OpenCode, Grok,
  Antigravity, and fake reviewers.
- Multi-reviewer runs through repeated `--reviewer` flags or configured reviewer sets.
- Aggregation, attribution, validation, deduplication, Markdown rendering, and JSON output
  owned by Diffwarden core instead of by any one reviewer engine.
- Repo and user config for reviewer profiles, provider wiring, executable overrides,
  model defaults, effort defaults, timeouts, and reviewer sets.
- A bundled `$diffwarden` skill for agents that are using Diffwarden from another repo.

The overlap is intentional. Diffwarden borrows Codex-style review semantics, but keeps the
review runner independent from the Codex app/session model.

Choose Codex review when:

- The user is in Codex and wants the built-in Codex review flow.
- One Codex reviewer is enough.
- Session-integrated review UI matters more than cross-agent portability.

Choose Diffwarden when:

- Another coding agent needs a stable review command.
- You want multiple reviewers or reviewer sets.
- You want the same target, prompt, parse, validation, and render behavior across
  different engines.
- You want machine-readable JSON artifacts independent of a specific agent product.

Current Diffwarden target support is narrower than upstream Codex review: Diffwarden
supports `uncommitted`, `base:<branch>`, and `commit:<sha>`. Custom prompt targets and PR
targets are not implemented.

## SDK vs CLI Transports

Diffwarden supports two adapter families:

- SDK adapters import a provider SDK from Node and call it directly.
- CLI transports spawn an installed agent CLI with read-only review flags where available.

The core pipeline is the same either way:

```text
target resolution -> diff collection -> prompt assembly -> adapter run -> parsing -> validation -> rendering
```

Adapters should stay thin. They select the engine, apply the safest available read-only
mode, pass model/effort options when supported, and return text or structured output.

### SDK Strengths

- Usually better access to native structured output or tool-call capture.
- Better opportunity for auth/model preflight before the review starts.
- Fewer assumptions about terminal output formatting.
- Easier to pass abort signals, metadata, usage, and SDK-native options.

### SDK Costs

- More dependency churn inside this package.
- More version-sensitive implementation detail.
- Each SDK has its own lifecycle, auth, session, and tool-permission model.
- Some SDKs may create provider-side sessions in ways that are visible in product UI.

### CLI Strengths

- Follows the same surface area users already run manually.
- Reuses local CLI auth and config.
- Fastest way to support tools that do not have a stable public SDK.
- Keeps provider SDK dependency code out of Diffwarden.

### CLI Costs

- Output may be text or JSONL rather than native structured output.
- Read-only guarantees depend on the CLI's flags; some paths are prompt-only until proven.
- CLI flags can change independently of package APIs.
- The executable must be installed and authenticated on the machine running Diffwarden.

### Default Rule

Prefer the SDK path when it gives stronger structured output, model/auth preflight, or
read-only enforcement. Prefer the CLI path when it is the provider's current recommended
automation surface, when it better matches real user behavior, or when the SDK has product
side effects that the CLI avoids.

For Droid specifically, Diffwarden currently recommends `droid-cli` for routine reviews.
The SDK path remains available for native structured-output coverage and machine-targeted
runs, but current SDK runs still appear in Factory session history.

See [`features.md`](./features.md) for the supported feature matrix.
