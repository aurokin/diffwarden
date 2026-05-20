# Quality Checks

This project currently reports quality metrics without enforcing coverage or complexity limits.
Use the numbers to decide whether a future threshold would improve confidence.

## Default Gate

```bash
pnpm check
```

Runs Biome linting, strict TypeScript type checking, and the default Vitest suite.
The default suite excludes black-box e2e tests and live SDK smoke tests.

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

```bash
pnpm test:live
```

Runs the opt-in SDK smoke tests with `INTEGRATION_TEST_ON=1`. These tests may require real
credentials and may make live model requests. Use `INTEGRATION_DISABLE=cursor,claude,pi` to
skip specific SDKs during live runs.

## Combined Metrics

```bash
pnpm metrics
```

Runs the complexity report followed by coverage reporting. This command is for inspection, not
for gating.
