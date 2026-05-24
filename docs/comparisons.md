# Comparisons

Use this guide when deciding whether Diffwarden is the right review runner for a
workflow, and when choosing SDK or CLI transports for a reviewer.

## Diffwarden vs Codex Review

Codex has a first-class review path. This comparison was dated May 23, 2026, when the
latest GitHub release was
[`0.133.0` / `rust-v0.133.0`](https://github.com/openai/codex/releases/tag/rust-v0.133.0)
(published May 21, 2026). The source inspection used upstream commit
[`7d47056ea4`](https://github.com/openai/codex/tree/7d47056ea4). The relevant source paths
are:

- `codex-rs/exec/src/cli.rs` and `codex-rs/exec/src/lib.rs` for `codex review`.
- `codex-rs/core/src/review_prompts.rs` for target-specific review prompts.
- `codex-rs/core/src/session/review.rs` and `codex-rs/core/src/tasks/review.rs` for the
  review child session.
- `codex-rs/protocol/src/protocol.rs` for the review request/output schema.

Codex exposes non-interactive review through `codex review` and accepts these targets:

- `--uncommitted`
- `--base <branch>`
- `--commit <sha>`
- custom review instructions as a prompt

Codex also exposes the same review concept through app-server `review/start`, where the
review can run inline on the current thread or detached in a new review thread.

### What Codex Does

The Codex review path is session-native:

1. `codex review` builds a `ReviewRequest` target from CLI args.
2. The exec client sends app-server `review/start`.
3. The app-server submits `Op::Review` to the target thread.
4. Core resolves a target-specific prompt. For base-branch reviews it tries to compute the
   merge base and embeds the merge-base SHA in the prompt; otherwise it falls back to
   instructing the reviewer to compute it.
5. Core spawns an isolated review child task using the Codex review rubric from
   `core/review_prompt.md`.
6. The review task disables web search, view-image behavior, CSV spawning, collaboration,
   and multi-agent features for the review child.
7. The review child uses `review_model` from Codex config when set; otherwise it uses the
   parent session model.
8. The review task parses the last assistant message as `ReviewOutputEvent` JSON, or
   extracts the first JSON object substring, or falls back to plain text in
   `overall_explanation`.
9. Core emits `EnteredReviewMode` and `ExitedReviewMode` events and records a user/assistant
   summary back into the parent session history.

Codex review is therefore the best fit when the caller is already inside Codex and wants a
single Codex-owned review experience. It is integrated with Codex thread state, review-mode
UI, Codex's review rubric, Codex history, and Codex's model/runtime selection.

Diffwarden is useful when code review needs to be agent-callable outside Codex or
needs orchestration that Codex review does not own:

- A single CLI contract for Codex, Claude, Cursor, Pi, Droid, Gemini, OpenCode, Grok,
  Antigravity, and fake reviewers.
- Multi-reviewer runs through repeated `--reviewer` flags or configured reviewer sets.
- Aggregation, attribution, validation, deduplication, Markdown rendering, and JSON output
  owned by Diffwarden core instead of by any one reviewer engine.
- Repo and user config for reviewer profiles, provider wiring, executable overrides,
  model defaults, effort defaults, timeouts, and reviewer sets.
- Preflight-only checks through `diffwarden doctor`, including SDK model/auth checks where
  the adapter supports them.
- A bundled `$diffwarden` skill for agents that are using Diffwarden from another repo.

The overlap is intentional. Diffwarden borrows Codex-style review semantics, but keeps the
review runner independent from the Codex app/session model.

### Feature Comparison

| Feature | Codex review | Diffwarden |
| --- | --- | --- |
| Primary use case | Native Codex review inside a Codex thread/session | Agent-callable review runner across multiple engines |
| Reviewer engines | Codex only | Codex, Claude, Cursor, Pi, Droid, Gemini, OpenCode, Grok, Antigravity, fake |
| Multi-reviewer orchestration | No | Yes, via repeated `--reviewer` flags or reviewer sets |
| Review targets | Uncommitted, base branch, commit, custom instructions | Uncommitted, base branch, commit, custom instructions |
| Base branch handling | Review prompt embeds merge-base SHA when Codex can compute it | Core computes merge base and passes an actual diff |
| Commit handling | Prompt instructs the reviewer to inspect the commit, with optional title | Core computes the commit diff, including root commits |
| Diff materialization | Reviewer is prompted to inspect the repo/diff | Core captures the patch and embeds it in the prompt |
| Structured output | `ReviewOutputEvent` parsed from reviewer text | Shared ReviewResult schema, structured SDK/CLI paths, fallback parsing |
| Schema validation | Deserializes review JSON or falls back to explanation text | Zod schema validation, strict mode, location validation, parse-mode metadata |
| Finding aggregation | Single reviewer output | Multi-reviewer aggregation, deduplication, reviewer attribution |
| Machine-readable artifact | Review events and rendered text in Codex protocol/session | Stable Markdown or full JSON artifact, plus optional `--out` JSON |
| Model defaults | `review_model` config override, otherwise parent session model | Per-reviewer defaults and config overrides; `doctor` can verify SDK model IDs |
| Effort controls | Inherits Codex session/config behavior | Per-reviewer effort where supported, with adapter-specific mapping |
| Read-only controls | Review child disables selected features and uses `AskForApproval::Never` | Per-adapter read-only/sandbox/tool restriction metadata and validation |
| Session integration | Strong: review mode events and parent history integration | Deliberately external; no Codex thread UI integration |
| Agent portability | Codex-specific | Designed for any agent that can call a CLI |
| Custom review instructions | Yes | Yes, through `custom:<text>` |

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
- You want preflight checks for reviewer runtime/auth/model settings before running a review.

Diffwarden supports `uncommitted`, `base:<branch>`, `commit:<sha>`, and `custom:<text>`
targets.

Current Codex review is narrower than Diffwarden in orchestration: it is a Codex-native
single-reviewer workflow. It does not provide Diffwarden's multi-engine reviewer sets,
cross-reviewer aggregation, or adapter feature matrix.

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
