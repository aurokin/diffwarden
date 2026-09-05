# Codex review process and instruction delivery

Status: accepted, September 4, 2026.

## Decision

Adapt Codex's detached review-agent inspection process into Diffwarden's fresh,
ephemeral, schema-constrained app-server turn. Deliver the stable review contract as
developer instructions and the resolved target, focus, provenance, and patch as user
input. Preserve Codex's model-specific base instructions.

This is an adaptation of the detached review process, not a native detached request.
Existing native-inline review remains an explicit option. No extra model call or prose
translation stage is introduced.

## Evidence

The original rubric port used Codex `462deb0426bf` on May 28. This refresh inspected
stable `rust-v0.153.4`, including:

- `codex-rs/skills/src/assets/samples/review-agent/SKILL.md`, introduced July 14 by
  `83a4187837`: whole-diff inspection, surrounding code, tests and callers, and no
  recursive delegation.
- `codex-rs/prompts/templates/review/rubric.md`, updated July 21 by `81de4f251c`:
  applicable repository rules and verified attribution in findings.
- `codex-rs/app-server/src/request_processors/turn_processor.rs`: detached review
  clones the server configuration and invokes an agent with a history fork. It does
  not reliably inherit the parent thread's requested model, instructions, and restrictions.
- `codex-rs/ext/agent/src/lib.rs`: the detached invocation does not supply a final
  output schema. The bundled skill requests prose.

Schema generation using the published 0.153.4 binary confirmed that `review/start`
accepts only `threadId`, `target`, and `delivery`. `turn/start` exposes `outputSchema`,
and `thread/start` exposes `developerInstructions` and `ephemeral`.

A separate read-only source review confirmed these blockers before implementation.
An ephemeral parent's suitability for the native persisted-history fork was not
proven; the chosen integration does not depend on that behavior.

## Product constraints

The supplied patch remains authoritative. Project rules cannot override read-only
behavior, review scope, or the output schema. Reviews inspect test source but do not
execute tests, builds, health checks, services, or other agents. They complete without
clarification questions and omit unsubstantiated findings.

Completed review output takes precedence over streamed progress. Async questions and
commentary do not replace the final answer. Cancellation interrupts the review's own
thread before disconnecting, including when using a shared daemon. Monitoring failure
explanations are preserved without automatically continuing the turn.

## Tradeoff and validation

The adaptation retains one-call structured output, bounded scope, and existing
configuration. It does not automatically load future revisions of the upstream skill.
Review-source revision, tested runtime, and selected model are separate maintenance
facts; an installed CLI version is not the rubric's version.

Credential-free tests cover instruction delivery, output schema, async/final ordering,
shared-server cancellation, and failure explanations. Source compatibility and these
tests do not establish equivalent review quality to native detached review. Live model
acceptance remains opt-in and must be reported separately.
