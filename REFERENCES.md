# Upstream References

Point-in-time note: 2026-05-12. This file intentionally avoids copying API details that can go stale. Treat these as pointers to upstream sources of truth, not as a versioned API summary.

## Cursor Agent SDK

- Cursor TypeScript SDK documentation: https://cursor.com/docs/api/sdk/typescript
- Cursor TypeScript SDK release post: https://cursor.com/blog/typescript-sdk
- Cursor cookbook examples: https://github.com/cursor/cookbook
- NPM package: https://www.npmjs.com/package/@cursor/sdk
- Local package inspection on 2026-05-14: `@cursor/sdk@1.0.13`.
- Implemented adapter dependency on 2026-05-18: `@cursor/sdk@1.0.13`; local live tests require pnpm to build the SDK's `sqlite3` dependency.
- Cursor model docs: https://docs.cursor.com/models
- Cursor model-list API docs: https://docs.cursor.com/en/background-agent/api/list-models

Use the official docs and cookbook examples for current SDK usage, authentication, local/cloud execution, and streaming behavior.

## Claude Agent SDK

- Claude Agent SDK TypeScript repository: https://github.com/anthropics/claude-agent-sdk-typescript
- Claude Code / Agent SDK docs index: https://code.claude.com/docs/llms.txt
- NPM package: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- Implemented adapter dependency on 2026-05-18: `@anthropic-ai/claude-agent-sdk@0.3.143`.
- Local inspection on 2026-05-19: Claude Code `2.1.143` supports `claude -p` and `claude auth status --json`; SDK `query()` can use local Claude Code auth by setting `pathToClaudeCodeExecutable: "claude"`.
- Claude native structured output implemented on 2026-05-19 through `options.outputFormat: { type: "json_schema", schema }`; live smoke required `maxTurns` above `1` for the SDK's schema-validation flow.

Use upstream docs for current `query()` options, structured output support, tool permissions, authentication behavior, and SDK version notes.

## Pi Agent SDK

- Pi mono repository: https://github.com/badlogic/pi-mono
- Pi Coding Agent SDK package: https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- Pi Agent Core package: https://www.npmjs.com/package/@earendil-works/pi-agent-core
- Local source inspected on 2026-05-19: `/Users/auro/code/upstream/pi-mono` at commit `48b6510c1`.
- Scaffold target package inspected on 2026-05-19: `@earendil-works/pi-coding-agent@0.75.3`.

Use the upstream repository for the current SDK docs, JSON mode docs, extension examples, structured output patterns, and agent harness lifecycle.

## Codex review reference

- OpenAI Codex repository: https://github.com/openai/codex
- Local reference inspected on 2026-05-14: `/Users/auro/code/upstream/codex` at commit `02a7205250`.

Use Codex as the semantic reference for review behavior, especially its review rubric and review output model. Do not duplicate large Codex prompt or protocol excerpts here; link to the upstream source and copy only what the implementation needs into source-controlled constants with attribution.

## Local upstream clones, if present

These are convenience working copies on Auro's machine, not portable repo dependencies:

```text
/Users/auro/code/upstream/codex
/Users/auro/code/upstream/cursor-cookbook
/Users/auro/code/upstream/claude-agent-sdk-typescript
/Users/auro/code/upstream/pi-mono
```

Do not require these paths for normal development. If implementation needs fixtures or copied prompt text, vendor the minimal stable artifact into this repo with clear attribution.

Before implementing SDK adapters, re-check these local upstream clones and refresh them if needed. The spec should describe product behavior; version-sensitive SDK details belong near adapter code, with the upstream commit or package version noted when the implementation depends on a specific shape.

## Reference policy

Prefer stable pointers over stale summaries:

- Link to official docs, repositories, and NPM packages.
- Avoid embedding detailed API signatures unless the implementation directly depends on them.
- Put version-sensitive SDK details in code comments near the adapter implementation, not in high-level docs.
- If a copied upstream artifact is required, include only the minimum needed, preserve attribution, and note the upstream commit or package version used.
- Keep this file as a route map, not a maintenance burden.
