# Agent Instructions

This repository is for `agent-review`, a CLI that coding agents can call to obtain a code review.

## Read order

1. `README.md`
2. `SPEC.md`
3. `REFERENCES.md`

## Repo posture

- Keep the public UX simple: agents call `agent-review` and receive Markdown or JSON.
- Keep SDK differences behind adapters.
- Do not expose SDK-specific commands as the main user contract.
- Preserve Codex-style review semantics where practical.
- Prefer read-only behavior by default.
- Defer external side effects, such as posting GitHub review comments, until explicitly implemented and guarded by dry-run behavior.

## Documentation policy

- Do not copy large chunks of upstream SDK docs into this repo.
- Use `REFERENCES.md` as the stable route map to upstream documentation.
- Put version-sensitive SDK discoveries near the adapter code that depends on them.
- If vendoring a prompt, schema, or fixture from upstream, include attribution and the upstream commit/package version.
- Mark point-in-time research notes clearly as point-in-time artifacts.

## Implementation policy

- Core CLI logic should own target resolution, prompt assembly, parsing, validation, and rendering.
- Adapters should only run their engine and return text or structured output.
- Keep tests credential-free by default. Live SDK smoke tests should be opt-in through environment variables.
