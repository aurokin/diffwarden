# Agent Review CLI Specification

Point-in-time spec: 2026-05-12 16:53 MDT. This document captures the current product and architecture intent for the first implementation of `agent-review`; re-verify SDK details before relying on them for long-lived decisions.

## 1. Product summary

`agent-review` is a small command-line tool that lets coding agents request a code review and receive a structured review result.

The public contract should stay boring:

```bash
agent-review --target base:main
agent-review --target uncommitted --engine cursor
agent-review --target pr:123 --format json
```

Agents call the CLI. The CLI resolves the target diff, runs a reviewer agent through an SDK adapter, validates the result, and prints Markdown or JSON.

## 2. Goals

1. Provide a simple CLI that agents can call from any coding workflow.
2. Recreate the useful parts of Codex `/review` outside Codex.
3. Use Codex's review rubric and review output shape as the normalized contract.
4. Start with the Cursor Agent SDK.
5. Keep the architecture ready for Claude Agent SDK and Pi Agent SDK without changing the CLI contract.
6. Keep code review read-only by default.
7. Produce output that is useful to both humans and automation.

## 3. Non-goals for the first version

1. Do not build a full PR automation pipeline yet.
2. Do not post GitHub comments in v1.
3. Do not let the reviewer modify files.
4. Do not expose SDK-specific commands to calling agents.
5. Do not require a daemon, service, database, or web UI.
6. Do not solve every possible review target in the first pass.

## 4. Primary user stories

### 4.1 Agent reviews local changes

A coding agent has edited files and wants a second opinion before reporting completion.

```bash
agent-review --target uncommitted
```

Expected behavior:

- The CLI finds the git repo root.
- The CLI builds a diff for uncommitted changes.
- The CLI asks the configured review engine to inspect the patch.
- The CLI prints a concise Markdown review.

### 4.2 Agent reviews branch against main

A coding agent has completed a branch and wants review relative to `main`.

```bash
agent-review --target base:main
```

Expected behavior:

- The CLI computes `git merge-base HEAD main`.
- The CLI asks the review engine to inspect `git diff <merge-base>`.
- Findings must point to changed lines when possible.

### 4.3 Automation consumes JSON

A script wants machine-readable findings.

```bash
agent-review --target base:main --format json --out review.json
```

Expected behavior:

- Stdout contains JSON if `--format json` is selected.
- `--out` writes the complete review artifact, including metadata and validation results.

## 5. CLI interface

### 5.1 Command

```bash
agent-review [options]
```

### 5.2 Options

```text
--target <target>                 Review target. Required unless defaulting to uncommitted.
--engine cursor|claude|pi|codex   Review engine. Default from env/config, then cursor.
--cwd <path>                      Working directory. Default: process.cwd().
--model <id>                      Engine-specific model override.
--format markdown|json            Output format. Default: markdown.
--out <path>                      Write full ReviewArtifact JSON to a file.
--strict                          Fail if structured output cannot be parsed or validated.
--readonly / --no-readonly        Read-only mode. Default: readonly.
--timeout <seconds>               Engine timeout.
--fail-on-findings <P0|P1|P2|P3>  Optional CI behavior. Not required in v1.
--verbose                         Include engine and validation details.
--help                            Print usage.
```

### 5.3 Target syntax

```text
uncommitted                       Review staged, unstaged, and untracked local changes.
base:<branch>                     Review HEAD against merge-base with branch.
commit:<sha>                      Review one commit.
pr:<number|url>                   Review a pull request. Later phase.
custom:<text>                     Custom reviewer instructions. Later phase.
```

### 5.4 Initial v1 targets

Implement first:

- `uncommitted`
- `base:<branch>`
- `commit:<sha>`

Defer:

- `pr:<number|url>`
- `custom:<text>`

## 6. Exit codes

```text
0 = review completed successfully
1 = review completed and findings met --fail-on-findings threshold
2 = invalid CLI usage or configuration
3 = engine execution failed
4 = output parse or validation failed in --strict mode
```

By default, findings should not make the command fail. The most common caller is another agent that needs to read and act on the review.

## 7. Review data model

### 7.1 ReviewResult

The normalized model should mirror Codex's review output event.

```ts
export type ReviewResult = {
  findings: ReviewFinding[];
  overall_correctness: "patch is correct" | "patch is incorrect" | string;
  overall_explanation: string;
  overall_confidence_score: number;
};
```

### 7.2 ReviewFinding

```ts
export type ReviewFinding = {
  title: string;
  body: string;
  confidence_score: number;
  priority: 0 | 1 | 2 | 3;
  code_location: {
    absolute_file_path: string;
    line_range: {
      start: number;
      end: number;
    };
  };
};
```

Rules:

- `title` should start with `[P0]`, `[P1]`, `[P2]`, or `[P3]`.
- `body` should explain why the issue is a bug and when it occurs.
- `line_range` should be as small as possible.
- Findings should only identify issues introduced by the reviewed diff.
- Findings should avoid vague style comments.

### 7.3 ReviewArtifact

The CLI should wrap model output with local metadata.

```ts
export type ReviewArtifact = {
  schema_version: 1;
  engine: "cursor" | "claude" | "pi" | "codex";
  cwd: string;
  target: ReviewTargetResolved;
  result: ReviewResult;
  raw_text?: string;
  validation: ReviewValidation;
  timing_ms?: number;
};
```

### 7.4 ReviewTargetResolved

```ts
export type ReviewTargetResolved = {
  kind: "uncommitted" | "base" | "commit" | "pr" | "custom";
  repo_root: string;
  base_ref?: string;
  base_sha?: string;
  head_sha?: string;
  commit_sha?: string;
  pr?: {
    number?: number;
    url?: string;
  };
  diff_command: string;
  changed_files: string[];
};
```

### 7.5 ReviewValidation

```ts
export type ReviewValidation = {
  parse_mode: "strict-json" | "extracted-json" | "tool-output" | "fallback-text";
  valid_schema: boolean;
  findings_overlap_diff: boolean;
  invalid_locations: Array<{
    index: number;
    reason: string;
  }>;
};
```

## 8. Review prompt requirements

The prompt should be assembled from three parts:

1. Codex review rubric.
2. Target-specific instructions.
3. JSON schema / output instructions.

The rubric should preserve Codex's core semantics:

- Find real bugs, not broad style issues.
- Only report issues introduced by the diff.
- Prefer a small number of high-confidence findings.
- Do not report issues that the author clearly did not change.
- Keep comments concise and actionable.
- Use absolute file paths in structured output.
- Make line ranges overlap changed lines whenever possible.
- Return JSON only when strict or JSON output is requested.

Example target instruction:

```text
Review the code changes in this repository.
The target is base:main.
The merge base is abc123.
Inspect the patch with:

  git diff abc123

Only report bugs introduced by this diff. Return the ReviewResult JSON schema exactly.
```

## 9. Architecture

### 9.1 Module layout

```text
agent-review/
  package.json
  tsconfig.json
  src/
    cli.ts
    core/
      config.ts
      git.ts
      target.ts
      prompt.ts
      schema.ts
      parse.ts
      validate.ts
      render.ts
      errors.ts
    adapters/
      types.ts
      cursor.ts
      claude.ts
      pi.ts
      codex.ts
  test/
    target.test.ts
    parse.test.ts
    validate.test.ts
    render.test.ts
  docs/
    SPEC.md or symlink/reference to root SPEC.md
```

### 9.2 Core pipeline

```text
parse CLI args
  -> load config/env defaults
  -> resolve cwd and git repo root
  -> resolve review target
  -> build review prompt
  -> select engine adapter
  -> run adapter
  -> parse output into ReviewResult
  -> validate schema and locations
  -> render output
  -> write --out artifact if requested
  -> choose exit code
```

### 9.3 Adapter interface

```ts
export interface ReviewEngineAdapter {
  name: "cursor" | "claude" | "pi" | "codex";
  run(input: ReviewEngineInput): Promise<ReviewEngineOutput>;
}

export type ReviewEngineInput = {
  cwd: string;
  prompt: string;
  schema: object;
  model?: string;
  timeoutMs?: number;
  readonly: boolean;
  env?: NodeJS.ProcessEnv;
};

export type ReviewEngineOutput = {
  text?: string;
  structured?: unknown;
  events?: ReviewEngineEvent[];
  usage?: unknown;
};
```

Central rule: adapters should not resolve diffs, validate findings, or render output. They only run an engine.

## 10. Engine adapters

### 10.1 Cursor adapter, v1

Use Cursor Agent SDK local mode.

Expected API shape from inspected SDK:

- `Agent.create({ apiKey, model, local: { cwd } })`
- `agent.send(prompt)`
- `run.stream()`
- `run.wait()`

Initial behavior:

- Pass a strict prompt asking for ReviewResult JSON.
- Collect streamed text and final result text.
- Return `{ text }`.
- Let centralized parser extract and validate JSON.

Open question:

- Whether a local MCP `review_output` tool can make Cursor output strict structured data. This is a later improvement, not required for v1.

### 10.2 Claude adapter, v2

Use Claude Agent SDK `query()`.

Expected API shape from inspected SDK:

- `query({ prompt, options })`
- `options.cwd`
- `options.model`
- `options.permissionMode`
- `options.allowedTools`
- `options.outputFormat: { type: "json_schema", schema }`

Initial behavior:

- Use native JSON schema output.
- Return `{ structured }` when possible.
- Use this adapter as the strict-output baseline.

Important caveat:

- Claude Agent SDK auth may differ from Claude Code subscription or Max auth. If preserving existing Claude Code CLI auth matters, implement a separate `claude-cli` adapter later.

### 10.3 Pi adapter, v3

Start with a CLI adapter, then improve with SDK structured output.

CLI mode:

- Invoke `pi -p` or `pi --mode json`.
- Restrict tools to read-only repo inspection where possible.
- Return text for centralized parsing.

SDK strict mode:

- Use `createAgentSession()`.
- Add a custom terminating `review_output` tool.
- Tool captures `ReviewResult` and terminates the run.

### 10.4 Codex adapter, optional

Codex remains the semantic reference. A Codex adapter can be added later if the local Codex CLI exposes review behavior in a stable way.

## 11. Git behavior

### 11.1 Repo detection

Use git commands from `cwd`:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
```

If no git repo is found, exit `2` with a helpful error.

### 11.2 Uncommitted target

Need to include:

- staged changes
- unstaged changes
- untracked files

Implementation notes:

- `git diff --staged`
- `git diff`
- `git ls-files --others --exclude-standard`
- For untracked files, include file path and content summary or synthesize a diff using `git diff --no-index /dev/null <file>`.

### 11.3 Base target

For `base:main`:

```bash
git merge-base HEAD main
git diff <merge-base>
```

### 11.4 Commit target

For `commit:<sha>`:

```bash
git show --format=fuller --stat --patch <sha>
```

Or:

```bash
git diff <sha>^ <sha>
```

Use the simpler reliable version first.

## 12. Validation behavior

Validation should happen after parsing and before rendering.

Checks:

1. Result matches the ReviewResult schema.
2. `priority` is one of `0`, `1`, `2`, `3`.
3. `confidence_score` is between `0` and `1`.
4. `absolute_file_path` exists or maps to a changed file.
5. `line_range.start <= line_range.end`.
6. Line ranges overlap changed lines when diff hunk data is available.
7. Titles include a priority prefix.

Strict mode:

- Any schema parse failure exits `4`.
- Invalid locations are reported and exit `4`.

Non-strict mode:

- Render what can be rendered.
- Include validation warnings in verbose mode or artifact JSON.

## 13. Output formats

### 13.1 Markdown default

Example:

```markdown
# Code Review

Engine: cursor
Target: base:main
Verdict: patch is incorrect
Confidence: 0.84

## Findings

### [P1] Null response can crash retry loop

`src/client.ts:42-44`

When the API returns 204, `response.body` is null, but this code unconditionally calls `response.body.getReader()`, causing retries to fail before the fallback path runs.

## Overall explanation

The patch is mostly sound, but the new streaming branch mishandles empty responses.
```

### 13.2 JSON output

`--format json` prints the full `ReviewArtifact` unless we later add `--json-result-only`.

## 14. Configuration

Initial precedence:

1. CLI flags
2. environment variables
3. config file
4. defaults

Possible environment variables:

```text
AGENT_REVIEW_ENGINE=cursor
AGENT_REVIEW_MODEL=<engine-model-id>
AGENT_REVIEW_TIMEOUT_SECONDS=300
CURSOR_API_KEY=...
ANTHROPIC_API_KEY=...
```

Optional config file later:

```json
{
  "engine": "cursor",
  "model": "composer-2",
  "readonly": true,
  "timeoutSeconds": 300
}
```

## 15. Security and side effects

Default posture:

- Read-only.
- No file modification.
- No GitHub posting.
- No network side effects beyond the selected SDK/API.
- No secret printing.

If an engine requires shell access, restrict the prompt and adapter policy to read/grep/find/git inspection. Treat write-capable tools as a separate opt-in future feature.

## 16. Test plan

Use fixtures for core behavior before live SDK calls.

### 16.1 Unit tests

- target parsing
- git target resolution with temp repos
- prompt assembly
- JSON extraction from messy model output
- schema validation
- diff hunk overlap validation
- Markdown rendering

### 16.2 Adapter smoke tests

Adapter smoke tests should be opt-in because they may require credentials and spend money.

Suggested flags:

```bash
AGENT_REVIEW_LIVE_CURSOR=1 npm test -- cursor-live
AGENT_REVIEW_LIVE_CLAUDE=1 npm test -- claude-live
AGENT_REVIEW_LIVE_PI=1 npm test -- pi-live
```

### 16.3 End-to-end fixture

Create a tiny fixture repo with an obvious bug:

- base commit has a safe implementation
- branch introduces a null dereference or off-by-one
- expected review contains at least one P1/P2 finding on the changed line

## 17. Implementation phases

### Phase 1: Scaffold and core CLI

Deliverables:

- TypeScript package scaffold.
- CLI arg parsing.
- target parser.
- git repo resolution.
- prompt builder.
- output parser.
- Markdown renderer.
- tests for core functions.

### Phase 2: Cursor adapter

Deliverables:

- `src/adapters/cursor.ts`
- local SDK run support
- text collection and parse
- live smoke command

### Phase 3: Validation hardening

Deliverables:

- diff hunk parser
- location overlap checks
- strict mode
- JSON artifact output

### Phase 4: Claude adapter

Deliverables:

- `src/adapters/claude.ts`
- native JSON-schema output
- live smoke command

### Phase 5: Pi adapter

Deliverables:

- CLI fallback adapter
- optional SDK structured-output adapter

### Phase 6: PR/GitHub integration

Deliverables:

- `pr:<number|url>` target resolution
- `gh` integration
- dry-run inline comments
- optional post-review flow

## 18. Acceptance criteria for v1

1. Running `agent-review --target uncommitted --engine cursor` from a git repo completes and prints Markdown.
2. Running `agent-review --target base:main --format json --out review.json` writes a valid ReviewArtifact.
3. The CLI exits `2` for invalid targets or non-git directories.
4. The parser can recover JSON from typical fenced-code model output.
5. The renderer displays findings, file paths, line ranges, verdict, and confidence.
6. No files are modified by default.
7. Core tests pass without live SDK credentials.

## 19. Open decisions

1. Final package name: `agent-review`, `cursor-review`, or another name.
2. Default engine: likely `cursor` for the first build.
3. Whether `--format json` should output `ReviewArtifact` or only `ReviewResult`.
4. Whether to add a separate `claude-cli` adapter for Claude Code subscription auth.
5. Whether Cursor can be made strict through MCP tool calling.
6. Whether to initialize GitHub posting as a separate command, e.g. `agent-review publish`.

## 20. First implementation recommendation

Start with the smallest useful tool:

```bash
agent-review --target uncommitted --engine cursor
agent-review --target base:main --engine cursor --format json
```

Build the core around Codex's review schema and prompt, then add SDK adapters behind the same `ReviewEngineAdapter` interface.
