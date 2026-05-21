# Agent Instructions

## Package Manager

- Use `pnpm`.
- Node must satisfy `>=22.19.0`.

## Commands

| Task | Command |
| --- | --- |
| Run default gate | `pnpm check` |
| Run tests | `pnpm test` |
| Run one test file | `pnpm vitest run path/to/file.test.ts` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Build | `pnpm build` |
| Run e2e tests | `pnpm test:e2e` |
| Report coverage | `pnpm test:coverage` |
| Report complexity | `pnpm complexity` |
| Check live tool discovery | `pnpm live:doctor` |

## Read Order

| Need | File |
| --- | --- |
| Overview and current status | `README.md` |
| Configuration and reviewer sets | `docs/configuration.md` |
| Reviewer adapter behavior | `docs/adapters.md` |
| Quality commands | `QUALITY.md` |
| Product and architecture spec | `SPEC.md` |
| Upstream references | `REFERENCES.md` |

## Key Conventions

- Keep the public UX simple: agents call `diffwarden` and receive Markdown or JSON.
- Keep SDK differences behind adapters.
- Core CLI logic owns target resolution, prompt assembly, parsing, validation, and rendering.
- Adapters only run their engine and return text or structured output.
- Prefer read-only behavior by default.
- Keep tests credential-free by default.
- Live SDK smoke tests must be opt-in through environment variables.
- Do not copy large chunks of upstream SDK docs into this repo.
- Put version-sensitive SDK discoveries near the adapter code that depends on them.
- If vendoring a prompt, schema, or fixture from upstream, include attribution and the upstream commit/package version.
