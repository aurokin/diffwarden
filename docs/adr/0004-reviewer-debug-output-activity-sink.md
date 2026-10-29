# ADR 0004: Reviewer Debug Output and the Reviewer Activity Sink

## Status

Accepted, 2026-07-15. Implemented across the CLI, SDK, and Codex app-server transports.

## Context

`--debug-reviewer-output` started as raw stdout/stderr capture for CLI transports. Extending
it to SDK transports and the Codex app-server raised the same two policies for every engine
dialect: reasoning must stay excluded even when a provider's event protocol drifts, and debug
capture must never fail or change a review. Three designs were compared (minimal reuse, typed
events, and a shared activity sink); the shared sink was chosen, with parts of the other two
kept. User-facing behavior is documented in
[`docs/features.md`](../features.md#debugging-reviewer-output); per-engine stream caveats are in
[`docs/adapters.md`](../adapters.md#stream-mode-research-caveats).

## Decision

### Capture contract

- One per-invocation flag, `--debug-reviewer-output`. No config key or env var, so capture is
  never ambiently on. Without the flag, artifacts and NDJSON are byte-identical.
- `debug_output` lives on the reviewer artifact (`reviewers[i].debug_output`), not in
  `adapter_metadata` and not in a sidecar file. It travels with `--json`, `--out`, and NDJSON
  result frames, `--report-mode full` embeds it, and `--report-mode metadata` never does. A
  sidecar file was rejected because it adds path management, cleanup, and discovery problems
  for agents.
- stdout and stderr are kept separately. The persisted text keeps the head and truncates at
  the cap; `*_bytes` counts everything the transport produced. Multi-attempt runs (repair or
  labeled retry) append in order under one per-reviewer budget so the failing first attempt
  is preserved.
- Budgets: 256 KiB per stream per reviewer per run (UTF-8 bytes), 8 KiB of text per NDJSON
  `reviewer_debug_output` event, and one final `truncated: true` event when a stream budget
  runs out. Debug events are non-authoritative and outside the terminal-frame guarantee.

### Schema

- `schema_version` stays 2 with no schema change. `reviewerDebugOutputSchema` is strict, so
  widening the `stream` enum or adding fields would break pinned consumers.
- Synthesized summaries from SDK and app-server reviewers are recorded as `stream: "stdout"`.
  Sharp edge: for those reviewers `stdout_bytes` counts summary bytes, not a raw transcript.
- SDK and app-server reviewers set `adapter_metadata.debugOutputMode: "event-summary"`.
  Degradation uses the same open record: `debugOutputDropped: "stream-unsupported" |
  "shared-server-unverified"` (Antigravity later added `"transcript-unavailable"`).
- Typed `kind` / `tool_name` event fields are shelved, not shipped: no consumer scrapes the
  markers today. They remain the future additive path. NDJSON consumers must ignore unknown
  fields; new optional fields are additive within a schema version.

### Gating

| Flags | CLI transports | SDK and app-server transports |
| --- | --- | --- |
| neither | nothing | nothing |
| `--debug-reviewer-output` only | raw json-mode stdout/stderr in the artifact | synthesized summaries in the artifact |
| plus `--ndjson` | invocation switches to the native stream mode; live summary events plus summary artifact | same summaries, also streamed live |

`--ndjson` only authorizes an invocation change; SDK adapters and the app-server capture
whenever debug output is requested. Repair and one-shot structured invocations never emit
debug output: `RunStructuredInput` has no debug field, and no adapter threads a sink into
`runStructured`.

### Shared module

`src/adapters/reviewer-activity.ts` turns already-parsed engine events into bounded one-line
summaries (assistant text verbatim, `[tool_use X]` markers). CLI stream parsing keeps only line
framing and delegates rendering to it; each SDK adapter and the app-server feed events into a
sink. Every sink method is wrapped in try/catch so debug capture cannot fail a run.

- Reasoning is dropped at one choke point: a `/reasoning|thinking|thought/i` type or method
  check runs before any dialect renderer. Content blocks are allowlisted to text, tool_use,
  and tool_result; unknown event types render as a bare `[<type>]` marker with no payload.
- Only the per-dialect assistant-text extractors may return engine-authored prose, and only
  from named fields. A sentinel test suite plants `LEAK_ME` values in every other field and
  asserts none render. Tool names are bounded to 128 characters.
- The Claude CLI top-level `thinking` event, previously rendered as `[thinking]`, is dropped.

### Per-transport choices

- Copilot SDK uses a second, debug-only subscription. Ephemeral and delta events are skipped
  because they duplicate the final message. Sub-agent `assistant.message` text is rendered
  verbatim with an `[agent <agentId>] ` prefix.
- Pi SDK drops `message_update` entirely (every update re-embeds the whole message, O(n^2)),
  renders assistant `message_end` text parts only, and reduces user messages, which echo the
  diff, to size markers.
- Cursor SDK prefers `onStep` / `onDelta` callbacks; concurrent `run.stream()` plus
  `run.wait()` is only a guarded fallback, and the last resort is no wiring with
  `debugOutputDropped: "stream-unsupported"`.
- Codex app-server filters notifications by thread before reply assembly and debug. In
  `stdio-isolated` mode a notification is accepted when thread ids match or either is absent.
  In shared-daemon modes (`attach`, `auto`, `launch`) it is accepted only when
  `notifThreadId !== undefined && this.threadId !== undefined && notifThreadId === this.threadId`;
  a plain `===` would also accept two undefined ids. Debug capture in shared-daemon modes is
  withheld (`shared-server-unverified`) until thread ids are verified against a live
  attach-mode capture. Only `stdio-isolated` mode tees child stderr.

## Consequences

- One module enforces reasoning exclusion and never-fail behavior for current and future
  dialects; adding an engine is one renderer plus a few lines of wiring.
- Runner, schema, and debug-output recording code did not change; budgets stay owned by the
  runner's recorder.
- A delta coalescer (per-item emitted-length tracking with a buffer cap, so completion never
  duplicates streamed deltas) was deferred from the first rollout; it later shipped for Grok
  token deltas and app-server agent-message deltas.
- Left open at decision time: Pi `message_end`-only granularity, whether the CLI path also sets
  `debugOutputMode`, a synthetic stderr notice for attach mode, and `[retry N]` delimiters.
