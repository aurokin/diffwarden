# Quality Checks

This project currently reports quality metrics without enforcing coverage or complexity limits.
Use the numbers to decide whether a future threshold would improve confidence.

## Default Gate

```bash
pnpm check
```

Runs Biome linting, strict TypeScript type checking, and the default Vitest suite. The
default `pnpm test`, `pnpm test:coverage`, and `pnpm test:e2e` commands force
`INTEGRATION_TEST_ON=0`, so inherited shell environment cannot accidentally trigger live
model calls.

## Coverage

```bash
pnpm test:coverage
```

Runs the default Vitest suite with V8 coverage reporting. Reports are written to `coverage/`
with terminal text, JSON summary, and HTML output. No coverage thresholds are enforced.

## Complexity

```bash
pnpm complexity
```

Reports cyclomatic complexity, maximum control-flow nesting, and function length for
`src/**/*.ts`. The terminal output shows the highest-complexity functions, and the full JSON
report is written to `reports/complexity.json`. No complexity thresholds are enforced.

## E2E

```bash
pnpm test:e2e
```

Runs credential-free black-box CLI tests against temporary Git repositories using the fake
reviewer. These tests exercise the CLI entry point, Git target resolution, Markdown output,
JSON output, and CLI error handling.

## Live Smoke Tests

Live tests are opt-in because they require local tools, may require credentials, and may make
real model requests.

Check local tool discovery first:

```bash
pnpm live:doctor
```

Run SDK smoke tests:

```bash
pnpm test:live:sdk
```

Run CLI transport smoke tests:

```bash
pnpm test:live:cli
```

Run built-binary e2e smoke tests for selected reviewers:

```bash
DIFFWARDEN_LIVE_E2E_REVIEWERS=codex,claude pnpm test:live:e2e
DIFFWARDEN_LIVE_E2E_REVIEWERS=droid DIFFWARDEN_LIVE_DROID_EFFORT=low pnpm test:live:e2e
```

Run all live suites:

```bash
pnpm test:live
```

Use `INTEGRATION_DISABLE=cursor,claude,pi,droid,codex` to skip specific SDKs or CLIs during live
runs. Use `DIFFWARDEN_LIVE_CLI=codex,claude,gemini` to restrict CLI live tests to a subset.
Live CLI and e2e tests also honor `DIFFWARDEN_LIVE_<REVIEWER>_PROVIDER`,
`DIFFWARDEN_LIVE_<REVIEWER>_MODEL`, `DIFFWARDEN_LIVE_<REVIEWER>_EFFORT`, and
`DIFFWARDEN_LIVE_<REVIEWER>_EXECUTABLE`.

The `v0.1.0` release machine verified every implemented live path:

- SDK smoke tests: Cursor SDK, Claude SDK, and Pi SDK.
- CLI smoke tests: Codex, Claude, Cursor, Gemini, OpenCode, Pi, Grok, and Antigravity.
- Built-binary e2e smoke test with all eight CLI reviewers selected through
  `DIFFWARDEN_LIVE_E2E_REVIEWERS`.

Droid SDK and CLI live smoke tests were added after `v0.1.0`; use `pnpm live:doctor` to
confirm the local `droid` executable and Factory auth before running them.

## Combined Metrics

```bash
pnpm metrics
```

Runs the complexity report followed by coverage reporting. This command is for inspection, not
for gating.
