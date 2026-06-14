# Agent Instructions

## Package Manager

- Use `pnpm`.
- Node must satisfy `>=22.19.0`.

## Commands

| Task | Command |
| --- | --- |
| Run default gate | `pnpm check` |
| Run low-churn unit tests | `pnpm test` |
| Run process-heavy tests | `pnpm test:process` |
| Run real git tests | `pnpm test:git` |
| Run full non-live tests | `pnpm test:full` |
| Run one unit test file | `pnpm vitest run --config vitest.unit.config.ts path/to/file.test.ts` |
| Run one process test file | `pnpm vitest run --config vitest.process.config.ts path/to/file.test.ts` |
| Run one git test file | `pnpm vitest run --config vitest.git.config.ts path/to/file.test.ts` |
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
| Consumer audience and docs boundaries | `docs/consumer-context.md` |
| Configuration and reviewer sets | `docs/configuration.md` |
| Reviewer adapter behavior | `docs/adapters.md` |
| Quality commands | `QUALITY.md` |
| Product and architecture spec | `SPEC.md` |
| Upstream references | `REFERENCES.md` |

## Key Conventions

- Keep the public UX simple: humans call `diffwarden review`; agents call
  `diffwarden review --agent`; scripts and CI use `diffwarden review --json` or
  `diffwarden review --ndjson`.
- Treat consumers as people, scripts, CI jobs, and agents configuring and running
  Diffwarden from another repository. They are not developing Diffwarden itself.
- Keep SDK differences behind adapters.
- Core CLI logic owns target resolution, prompt assembly, parsing, validation, and rendering.
- Adapters only run their engine and return text or structured output.
- Prefer read-only behavior by default.
- Keep tests credential-free by default.
- Live SDK smoke tests must be opt-in through environment variables, including `DIFFWARDEN_ALLOW_MODEL_SPEND=1`.
- Keep the default test loop low-churn. Use `test:process`, `test:git`, `test:e2e`, and `test:live` only when the change needs those heavier paths.
- Do not copy large chunks of upstream SDK docs into this repo.
- Put version-sensitive SDK discoveries near the adapter code that depends on them.
- If vendoring a prompt, schema, or fixture from upstream, include attribution and the upstream commit/package version.
