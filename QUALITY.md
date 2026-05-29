# Quality Checks

This project currently reports quality metrics without enforcing coverage or complexity limits.
Use the numbers to decide whether a future threshold would improve confidence.

## Default Gate

```bash
pnpm check
```

Runs Biome linting, strict TypeScript type checking, and the low-churn unit Vitest suite.
The default `pnpm test`, `pnpm test:unit`, `pnpm test:coverage`, and `pnpm test:e2e` commands
force `INTEGRATION_TEST_ON=0`, so inherited shell environment cannot accidentally trigger
live model calls.

The default unit suite excludes tests that intentionally spawn fake reviewer executables or
create real Git repositories. Those process-heavy paths are still covered by explicit suites
listed below.

Keep default unit tests free of real Git repositories and spawned reviewer executables unless the
behavior under test is specifically process or Git integration. Use synthetic resolved targets or
fake runners for core orchestration tests, then cover the boundary in `test:process`, `test:git`,
or `test:e2e`.

## Test Tiers

```bash
pnpm test:unit
pnpm test:process
pnpm test:git
pnpm test:full
```

`test:unit` is the default local loop and avoids real Git subprocesses, fake CLI launches, and
model calls. Prefer pure seams here for command construction, parsing, validation, rendering,
runner orchestration, and resolver command selection.

`test:process` covers fake CLI/app-server process canaries: executable resolution, stdio capture,
exit classification, abort/reaping, and app-server lifecycle behavior. Do not add process tests
just to inspect deterministic argv/env construction or parser behavior; cover those in
`test:unit`.

`test:git` covers real Git target-resolution canaries. Keep broad resolver behavior in fake-runner
unit tests, and reserve this tier for compatibility with actual Git behavior. `test:full` runs all
three tiers in sequence.

Process and Git suites run test files serially with one worker. Several tests create temporary
Git repositories or short-lived child processes; on macOS, parallelizing those tests can amplify
`syspolicyd`/`trustd` executable validation work enough to affect the whole machine.

For CI, prefer separate jobs for `pnpm check`, `pnpm test:process`, and `pnpm test:git` instead of
one serial job. Keep `pnpm check` as the required fast gate, then run the process and real-Git
suites as credential-free integration gates. Run `pnpm test:e2e` where built CLI coverage is
required, and keep live tests manual or scheduled with explicit spend opt-in.

## Coverage

```bash
pnpm test:coverage
```

Runs the low-churn unit Vitest suite with V8 coverage reporting. Reports are written to `coverage/`
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

Keep e2e tests focused on built-binary behavior that smaller tiers cannot prove: CLI startup,
config loading, output framing, report writes, exit codes, and a small number of real
target-resolution paths. The e2e suite should stay close to canaries for version output,
Markdown/JSON/NDJSON review output, fail-on-findings, report writes, doctor output, reviewer-list
redaction, and one representative CLI error path. When an e2e case only re-checks parser,
renderer, fake-reviewer, or resolver internals, move the coverage to unit, process, or real-Git
canaries instead.

## Live Smoke Tests

Live tests are opt-in because they require local tools, may require credentials, and may make
real model requests. Live test scripts require both `INTEGRATION_TEST_ON=1` from the script and
`DIFFWARDEN_ALLOW_MODEL_SPEND=1` from the caller.

Check local tool discovery first:

```bash
pnpm live:doctor
```

Run SDK smoke tests:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:sdk
```

Run CLI transport smoke tests:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live:cli
```

Run built-binary e2e smoke tests for selected reviewers:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 DIFFWARDEN_LIVE_E2E_REVIEWERS=codex,claude pnpm test:live:e2e
DIFFWARDEN_ALLOW_MODEL_SPEND=1 DIFFWARDEN_LIVE_E2E_REVIEWERS=droid DIFFWARDEN_LIVE_DROID_EFFORT=low pnpm test:live:e2e
```

Run all live suites:

```bash
DIFFWARDEN_ALLOW_MODEL_SPEND=1 pnpm test:live
```

Use `INTEGRATION_DISABLE=cursor,claude,pi,droid,codex` to skip specific SDKs or CLIs during live
runs. Use `DIFFWARDEN_LIVE_CLI=codex,claude,gemini` to restrict CLI live tests to a subset.
Live CLI and e2e tests also honor `DIFFWARDEN_LIVE_<REVIEWER>_PROVIDER`,
`DIFFWARDEN_LIVE_<REVIEWER>_MODEL`, `DIFFWARDEN_LIVE_<REVIEWER>_EFFORT`, and
`DIFFWARDEN_LIVE_<REVIEWER>_EXECUTABLE`.
Droid SDK live tests also honor `DIFFWARDEN_LIVE_DROID_MACHINE_ID`, but SDK runs still
create Factory session-history entries. Use the Droid CLI live path when validating the
recommended Droid reviewer behavior.

The `v0.1.0` release machine verified every implemented live path:

- SDK smoke tests: Cursor SDK, Claude SDK, and Pi SDK.
- CLI smoke tests: Codex, Claude, Cursor, Gemini, OpenCode, Pi, Grok, and Antigravity.
- Built-binary e2e smoke test with all eight CLI reviewers selected through
  `DIFFWARDEN_LIVE_E2E_REVIEWERS`.

Droid SDK and CLI live smoke tests were added after `v0.1.0`; use `pnpm live:doctor` to
confirm the local `droid` executable and Factory auth before running them. The Droid CLI
path is the recommended live path while the SDK path remains useful for coverage of native
structured output.

## Combined Metrics

```bash
pnpm metrics
```

Runs the complexity report followed by coverage reporting. This command is for inspection, not
for gating.
