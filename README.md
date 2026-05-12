# agent-review

A small CLI for agent-callable code review.

`agent-review` lets coding agents request a review of local changes, a branch diff, or eventually a PR, then receive Markdown or structured JSON findings. The CLI owns target resolution, review prompting, parsing, validation, and rendering; engine-specific SDKs live behind adapters.

## Intended public contract

```bash
agent-review --target base:main
agent-review --target uncommitted --engine cursor
agent-review --target pr:123 --format json
```

## Read order

1. [`SPEC.md`](./SPEC.md) — product and architecture specification.
2. [`REFERENCES.md`](./REFERENCES.md) — upstream documentation and source-of-truth links.

## Current status

Documentation scaffold only. No implementation has been created yet.

## Design principles

- Simple CLI first: agents call one command and get a review.
- SDK-agnostic internals: Cursor first, Claude and Pi later.
- Codex-style review semantics and output schema.
- Read-only by default.
- Avoid stale docs: link to upstream SDK docs instead of copying API details here.
