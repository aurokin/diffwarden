# Diffwarden CLI Specification

Point-in-time spec: 2026-05-14. This document captures the current product and architecture intent for the first implementation of `diffwarden`; re-verify SDK details before relying on them for long-lived decisions.

## 1. Product summary

`diffwarden` is a small command-line tool that lets coding agents request a code review and receive a structured review result.

The public contract should stay boring:

```bash
diffwarden --target base:main
diffwarden --target uncommitted --reviewer cursor
diffwarden --target base:main --reviewer claude
diffwarden --target base:main --reviewer pi
diffwarden --target commit:abc123
diffwarden --target base:main --format json
diffwarden --target base:main --reviewer-set 2
diffwarden --target base:main --reviewer cursor --reviewer pi:openrouter-high
```

Agents call the CLI. The CLI resolves the target diff, runs one or more reviewer agents through SDK adapters, validates the structured result, and prints readable Markdown or JSON.

## 2. Goals

1. Provide a simple CLI that agents can call from any coding workflow.
2. Recreate the useful parts of Codex `/review` outside Codex.
3. Use Codex's review rubric and review output shape as the normalized contract.
4. Support Cursor Agent SDK, Claude Agent SDK, and Pi Agent SDK in v1.
5. Keep SDK differences behind reviewer profiles and adapters without changing the CLI contract.
6. Keep code review read-only by default.
7. Produce output that is useful to both humans and automation.
8. Support one, two, or many reviewer agents in one command, including multiple instances of the same SDK with different provider/model configuration.
9. Ship as a public GitHub repository named `aurokin/diffwarden`; npm distribution is deferred.

## 3. Scope boundaries

Permanent non-goals for this CLI:

1. Do not post PR reviews.
2. Do not post GitHub review comments.
3. Do not let reviewers modify files.
4. Do not expose write-capable tools.
5. Do not require a daemon, service, database, or web UI.

Deferred, but potentially useful later:

1. Direct executable adapters. The v1 integration path is SDK-first; SDKs may invoke their own executables internally if that is how the SDK operates.
2. Custom reviewer instructions.
3. Read-only PR target resolution, if it can preserve the same output contract without adding posting behavior.

## 4. Primary user stories

### 4.1 Agent reviews local changes

A coding agent has edited files and wants a second opinion before reporting completion.

```bash
diffwarden --target uncommitted
```

Expected behavior:

- The CLI finds the git repo root.
- The CLI builds a diff for uncommitted changes.
- The CLI asks the configured reviewer set to inspect the patch.
- The CLI prints a concise Markdown review.

### 4.2 Agent reviews branch against main

A coding agent has completed a branch and wants review relative to `main`.

```bash
diffwarden --target base:main
```

Expected behavior:

- The CLI computes `git merge-base HEAD main`.
- The CLI asks the selected reviewer set to inspect `git diff <merge-base>`.
- Findings must point to changed lines when possible.

### 4.3 Agent reviews a single commit

A coding agent wants review for one completed commit without including unrelated local work.

```bash
diffwarden --target commit:abc123
```

Expected behavior:

- The CLI resolves the commit SHA.
- The CLI builds the patch for that commit.
- The CLI asks the configured reviewer set to inspect only that patch.
- Findings must point to changed lines when possible.

### 4.4 Automation consumes JSON

A script wants machine-readable findings.

```bash
diffwarden --target base:main --format json --out review.json
```

Expected behavior:

- Stdout contains JSON if `--format json` is selected.
- `--out` writes the complete review artifact, including metadata and validation results.

## 5. CLI interface

### 5.1 Command

```bash
diffwarden [options]
```

### 5.2 Options

```text
--target <target>                 Review target. Required unless defaulting to uncommitted.
--reviewer <spec>                  Repeatable reviewer spec. Default: config defaultReviewerSet.
--reviewer-set <name|count>        Named or count-based reviewer set from config.
--cwd <path>                      Working directory. Default: process.cwd().
--model <id>                      Model override for single-reviewer runs.
--effort <level>                  Reasoning/effort override for single-reviewer runs.
--format markdown|json            Output format. Default: markdown.
--out <path>                      Write full ReviewArtifact JSON to a file.
--strict                          Fail if structured output cannot be parsed or validated.
--readonly                        Read-only mode. Default and only supported mode.
--timeout <seconds>               Reviewer timeout.
--fail-on-findings <P0|P1|P2|P3>  Optional CI behavior. Not required in v1.
--verbose                         Include reviewer and validation details.
--help                            Print usage.
```

`--reviewer` is the primary reviewer selection primitive. A single `--reviewer` is a one-reviewer run; repeated `--reviewer` flags are a multi-reviewer run. If no reviewer is provided, the CLI uses `defaultReviewerSet` from config. Config is required for real SDK runs; do not silently run an unconfigured default.

`--reviewer-set` expands to one or more reviewer specs from config. It supports ergonomic defaults for common cases:

```text
diffwarden --reviewer-set 1      Use config reviewerSets["1"].
diffwarden --reviewer-set 2      Use config reviewerSets["2"].
diffwarden --reviewer-set 3      Use config reviewerSets["3"].
diffwarden --reviewer-set deep   Use config reviewerSets["deep"].
```

Reviewer specs should stay compact and SDK-agnostic at the public boundary:

```text
cursor                            Cursor SDK with default config.
claude                            Claude SDK with default config.
pi                                Pi SDK with default config.
pi:openrouter-high                Named Pi reviewer profile or provider config.
claude:sonnet                     Named Claude reviewer profile or model config.
cursor:fast                       Named Cursor reviewer profile or model config.
```

Candidate reviewer-spec grammars:

1. Recommended: `sdk[:profile]`, for example `pi`, `claude`, `cursor`, `pi:openrouter-high`, `cursor:fast`. The suffix is always a named config profile, not an inline model or provider expression. This keeps parsing simple, avoids shell-escaping problems, and pushes provider-heavy options into `diffwarden.config.json`.
2. Direct model shorthand: `sdk/model`, for example `claude/sonnet` or `pi/anthropic/claude-sonnet`. This is concise for single-reviewer use but becomes ambiguous for provider-qualified model IDs that already contain `/`.
3. Query-string style: `sdk?model=sonnet&effort=high`. This is expressive but awkward in shells and too much like exposing adapter internals as the public contract.

Use option 1 for v1. Model and effort still have first-class single-reviewer flags through `--model` and `--effort`; profile suffixes are for reusable named reviewer configs.

If any `--reviewer` flags are present, they define the full reviewer set. If both `--reviewer` and `--reviewer-set` are provided, exit `2`.

Model, effort, provider, and SDK-specific options should be handled in two layers:

1. Simple one-off flags for the single-reviewer path, such as `--reviewer claude --model sonnet --effort high`.
2. Named reviewer profiles for multi-reviewer or provider-heavy setups, such as `--reviewer pi:openrouter-high`.

Avoid turning the main CLI into a generic SDK option transport. Provider API keys, base URLs, OpenRouter/OpenCode-style provider selection, effort mappings, and SDK-specific options should live in config profiles and be passed to adapters as structured reviewer config.

### 5.3 Model and effort selection

Model selection is a first-class CLI concern:

```bash
diffwarden --target base:main --reviewer claude --model sonnet
diffwarden --target base:main --reviewer pi --model anthropic/claude-sonnet --effort high
diffwarden --target base:main --reviewer pi:openrouter-high
```

Rules:

- `--model` applies to single-reviewer runs.
- Multi-reviewer runs should put model selection in named reviewer profiles.
- If more than one reviewer is selected and `--model` or `--effort` is provided, exit `2`.
- `--effort` is a closed public enum aligned with Pi's thinking levels. Initial values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Invalid effort values fail during CLI/config validation with exit `2`.
- Invalid model values fail gracefully with a specific error. Prefer local validation against the selected reviewer/profile model catalog; if the SDK/provider rejects the model during preflight or execution, surface that as a reviewer setup/execution failure with exit `3`.
- Effort is best understood as requested reasoning intensity. Adapters may record a different effective effort when the SDK or model maps/clamps the requested value.

Pi effort handling should be the reference implementation:

- Pi exposes `ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` in `/Users/auro/code/upstream/pi-mono/packages/agent/src/types.ts`.
- Pi model metadata includes `reasoning` and optional `thinkingLevelMap` values.
- Pi's `getSupportedThinkingLevels()` and `clampThinkingLevel()` in `/Users/auro/code/upstream/pi-mono/packages/ai/src/models.ts` compute model-supported levels and map unsupported requests to a nearby supported value.
- `diffwarden` should pass Pi profiles a requested thinking level and record both requested and effective values when available. Do not hardcode provider-specific effort tables outside the adapter.
- Claude should map `xhigh` to its highest supported native level such as `max` when available.
- Cursor should report effort as best-effort/ignored unless the SDK exposes a concrete control.

Adapters should implement a preflight step before running review:

1. Verify SDK package/runtime requirements are available.
2. Verify any required executable used internally by the SDK is available, when applicable.
3. Verify required authentication is present.
4. Verify selected provider/profile options are coherent.
5. Verify selected model and effort can be mapped or rejected with a clear message.

### 5.4 Target syntax

```text
uncommitted                       Review staged, unstaged, and untracked local changes.
base:<branch>                     Review HEAD against merge-base with branch.
commit:<sha>                      Review one commit.
pr:<number|url>                   Review a pull request. Later phase.
custom:<text>                     Custom reviewer instructions. Later phase.
```

### 5.5 Initial v1 targets

Implement in v1:

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
3 = reviewer execution failed
4 = output parse or validation failed in --strict mode
```

By default, findings should not make the command fail. The most common caller is another agent that needs to read and act on the review.

Error handling rules:

- Invalid target syntax, invalid reviewer spec, invalid effort value, unknown configured profile, and locally invalid model values exit `2`.
- Missing SDK package/runtime requirements, missing SDK-required executable, missing authentication, provider setup failure, timeout, and SDK execution failure exit `3`.
- If an SDK/provider rejects a model that could not be validated locally, exit `3` and print a model-specific message.
- In Markdown mode, errors should be concise human-readable text on stderr.
- In JSON mode, errors should be a stable JSON error object on stdout or stderr. Choose one stream during implementation and document it in `--help`.

Suggested JSON error shape:

```ts
export type ReviewError = {
  schema_version: 1;
  error: {
    code:
      | "invalid_cli"
      | "invalid_config"
      | "invalid_model"
      | "invalid_effort"
      | "missing_requirement"
      | "missing_auth"
      | "reviewer_failed"
      | "timeout"
      | "parse_failed"
      | "validation_failed";
    message: string;
    reviewer_id?: string;
    sdk?: "cursor" | "claude" | "pi";
    hint?: string;
  };
};
```

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
  sdk?: "cursor" | "claude" | "pi";
  reviewers?: ReviewReviewerArtifact[];
  cwd: string;
  target: ReviewTargetResolved;
  result: ReviewResult;
  raw_text?: string;
  validation: ReviewValidation;
  timing_ms?: number;
};
```

For single-reviewer runs, `sdk` and `result` are enough for simple consumers. For multi-reviewer runs, `reviewers` contains each individual reviewer result and `result` is the merged or selected summary used for rendering.

```ts
export type ReviewReviewerArtifact = {
  id: string;
  sdk: "cursor" | "claude" | "pi";
  profile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  result: ReviewResult;
  raw_text?: string;
  adapter_metadata?: ReviewAdapterOutput["metadata"];
  validation: ReviewValidation;
  timing_ms?: number;
};
```

### 7.4 ReviewReviewerConfig

Reviewer config is the internal representation produced from CLI flags, environment variables, and config files.

```ts
export type ReviewReviewerConfig = {
  id: string;
  sdk: "cursor" | "claude" | "pi";
  profile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  modelCatalog?: string[];
  effortCatalog?: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string>;
  timeoutMs?: number;
  readonly: boolean;
  sdkOptions?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
};
```

Rules:

- `model` is the model identifier passed to the adapter when supported.
- `modelCatalog` is an optional allow-list used for local validation. If present, a model outside the list is an exit `2` configuration error.
- `effort` is a normalized intent, not a guaranteed cross-SDK value. Each adapter maps it to the closest SDK-specific setting and records requested/effective values in verbose metadata when possible.
- `effortCatalog` defaults to `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Values outside the selected catalog are an exit `2` configuration error.
- `provider` and `providerOptions` are mainly for SDKs that route through configurable providers, such as Pi profiles that target OpenRouter or other backends.
- `sdkOptions` is an escape hatch for version-sensitive adapter configuration. Keep it out of the public CLI unless a specific option becomes common enough to promote.

### 7.5 ReviewTargetResolved

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

### 7.6 ReviewValidation

```ts
export type ReviewValidation = {
  parse_mode: "strict-json" | "extracted-json" | "tool-output" | "fallback-text";
  valid_schema: boolean;
  findings_overlap_diff: boolean;
  valid_locations: boolean;
  invalid_locations: Array<{
    index: number;
    reason: string;
  }>;
};
```

`parse_mode` describes how core normalized adapter output into `ReviewResult`:

- `strict-json`: adapter output was parsed directly as the expected JSON object.
- `extracted-json`: core recovered the expected JSON object from surrounding text.
- `tool-output`: adapter output came from a structured tool or native structured-output handoff.
- `fallback-text`: core could not recover a valid JSON object and preserved useful text in `overall_explanation`.

## 8. Review prompt requirements

The prompt should be assembled from three parts:

1. Codex review rubric.
2. Target-specific instructions.
3. ReviewResult schema / structured-output instructions.

The rubric should preserve Codex's core semantics:

- Find real bugs, not broad style issues.
- Only report issues introduced by the diff.
- Prefer a small number of high-confidence findings.
- Do not report issues that the author clearly did not change.
- Keep comments concise and actionable.
- Use absolute file paths in structured output.
- Make line ranges overlap changed lines whenever possible.
- Always produce the normalized structured result through the adapter when possible.
- Let the CLI decide whether to render that result as Markdown or JSON.

Example target instruction:

```text
Review the code changes in this repository.
The target is base:main.
The merge base is abc123.
Inspect the patch with:

  git diff abc123

Only report bugs introduced by this diff. Emit the ReviewResult structure exactly through the configured structured-output mechanism.
```

## 9. Architecture

### 9.1 Module layout

```text
diffwarden/
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
      codex.ts                  optional later
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
  -> select reviewer adapter
  -> run adapter
  -> parse output into ReviewResult
  -> validate schema and locations
  -> render output
  -> write --out artifact if requested
  -> choose exit code
```

### 9.3 Adapter interface

```ts
export interface ReviewAdapter {
  name: "cursor" | "claude" | "pi";
  run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput>;
}

export type ReviewAdapterInput = {
  cwd: string;
  reviewer: ReviewReviewerConfig;
  target: ReviewTargetResolved;
  diff: string;
  changedFiles: string[];
  changedLineRanges?: Record<string, Array<{ start: number; end: number }>>;
  prompt: string;
  schema: object;
  timeoutMs?: number;
  readonly: boolean;
  env?: NodeJS.ProcessEnv;
};

export type ReviewAdapterOutput = {
  text?: string;
  structured?: unknown;
  events?: ReviewAdapterEvent[];
  usage?: unknown;
  metadata?: {
    captureMode?: "native-structured" | "tool-call" | "text";
    agentId?: string;
    runId?: string;
    readonlyCapability?: "enforced" | "tool-restricted" | "prompt-only";
    [key: string]: unknown;
  };
};
```

Central rule: adapters should not resolve diffs, validate findings, merge reviewer results, or render output. They only run the selected SDK-backed reviewer and return structured output when the SDK can provide it. The richer input object is for adapter observability, logging, and SDKs that can consume structured context; the core CLI still owns target resolution and prompt assembly.

The adapter contract should be shared across SDKs:

1. Use the same review prompt and schema for every SDK.
2. Use the SDK's native schema, tool, or structured-response mechanism when it is available and reliable.
3. Return `structured` when the SDK provides a structured handoff.
4. Return `text` when the SDK's reliable output surface is terminal text.
5. Always let the centralized parser normalize adapter output into `ReviewResult`.
6. Record the capture mode so validation and rendering can distinguish native structured output, tool calls, and terminal text.

`captureMode` describes how the adapter captured output from the SDK. `parse_mode` describes how core parsed that captured output. For example, Cursor can have `captureMode: "text"` with `parse_mode: "extracted-json"`, while Pi can have `captureMode: "tool-call"` with `parse_mode: "tool-output"`.

Codex's built-in review flow is the reference pattern: prompt the reviewer for an exact JSON review object, parse exact JSON first, attempt to extract a JSON object from surrounding text, and preserve useful plain text as a fallback rather than making the adapter responsible for rendering.

## 10. Review runner

The review runner coordinates one or more adapter invocations for the same resolved target.

Responsibilities:

- Expand repeated `--reviewer` flags into concrete reviewer configs.
- Expand no reviewer to the configured `defaultReviewerSet`, then to `reviewerSets["1"]`.
- Expand `--reviewer-set <name|count>` to configured reviewer sets.
- Run reviewers concurrently up to a configurable limit.
- Support multiple instances of the same SDK, such as two Pi reviewers with different provider profiles.
- Preserve each reviewer result separately in `ReviewArtifact.reviewers`.
- Produce a deterministic aggregate `ReviewResult` for default Markdown rendering.

Initial aggregation behavior should be conservative:

- Default Markdown should sort findings by priority and location, with reviewer attribution on each finding.
- Verbose Markdown and full JSON should preserve findings grouped by reviewer.
- Deduplicate only when file path, line range, priority, and normalized title are the same. Do not merge fuzzy or merely related findings in v1.
- If reviewers disagree, preserve the disagreement rather than pretending there is one consensus. Default Markdown should show lightweight attribution such as `Reported by: claude, pi-openrouter-high` or `Only reported by: cursor-fast`.

Failure behavior:

- Single-reviewer run: any reviewer execution failure exits `3`.
- Multi-reviewer run: render successful partial results with a warning if at least one reviewer succeeds.
- Multi-reviewer run: exit `3` if every reviewer fails.
- `--strict` makes any reviewer failure fatal.
- `ReviewArtifact.reviewers` must preserve per-reviewer success/failure metadata so automation can decide whether partial results are acceptable.

## 11. Engine adapters

### 11.1 Cursor adapter, v1

Use Cursor Agent SDK local mode.

Expected API shape from inspected SDK:

- `Agent.create({ apiKey, model, local: { cwd } })`
- `agent.send(prompt)`
- `run.stream()`
- `run.wait()`

Initial behavior:

- Implement adapter preflight for SDK availability, auth, model, effort, and read-only capability reporting.
- Use the Cursor Agent SDK directly.
- Prove local SDK execution and reliable text capture before adding more SDK-specific plumbing.
- Return `{ text }` from the terminal run result for the first Cursor path, with `metadata.captureMode = "text"`.
- Let the shared parser recover exact JSON, extracted JSON, or fallback text from Cursor output.
- Add a dedicated local MCP `review_output` tool as a reliability upgrade after the text path works.
- When the MCP path is enabled, capture matching SDK `tool_call` stream events and validate the tool args as `ReviewResult`.
- Return `{ structured }` with `metadata.captureMode = "tool-call"` when a valid `review_output` call is captured.
- If the MCP path does not produce a valid tool call, fall back to terminal text and mark the capture mode accordingly.
- Document what `readonly` can and cannot enforce for Cursor local mode before treating it as a hard guarantee.

Verified SDK constraint:

- `@cursor/sdk@1.0.13` types expose `AgentOptions.mcpServers`, `SendOptions.mcpServers`, `run.stream()`, `run.wait()`, and stream `tool_call` events.
- Those types do not expose a Claude-style `outputFormat: { type: "json_schema" }` option or direct typed tool registration.
- Therefore Cursor v1 should prove local SDK review execution and text output first, then prove the MCP `review_output` path as the preferred structured-output upgrade. Prompt-driven JSON is acceptable for the first useful Cursor adapter because centralized parsing and validation are core responsibilities.

### 11.2 Claude adapter, v1

Use Claude Agent SDK `query()`.

Expected API shape from inspected SDK:

- `query({ prompt, options })`
- `options.cwd`
- `options.model`
- `options.permissionMode`
- `options.allowedTools`
- `options.outputFormat: { type: "json_schema", schema }`

Initial behavior:

- Implement adapter preflight for SDK availability, auth, model, effort, and read-only capability reporting.
- Use native JSON schema output.
- Return `{ structured }`.

Important caveat:

- Claude Agent SDK auth may differ from Claude Code subscription or Max auth. If preserving existing Claude Code CLI auth matters, implement a separate `claude-cli` adapter later.

### 11.3 Pi adapter, v1

Use Pi Agent SDK directly.

- Implement adapter preflight for SDK availability, SDK-required executable availability if applicable, auth, provider/profile coherence, model, effort, and read-only capability reporting.
- Use `createAgentSession()`.
- Add a custom terminating `review_output` tool.
- Tool captures `ReviewResult` and terminates the run.
- Return `{ structured }`.
- Support named provider/profile configuration so callers can run multiple Pi reviewers with different providers.

### 11.4 Codex adapter, optional

Codex remains the semantic reference. A Codex adapter can be added later if the local Codex CLI exposes review behavior in a stable way.

### 11.5 Point-in-time SDK research

Point-in-time research date: 2026-05-14. Re-check upstream docs and local clones before implementation.

#### Cursor Agent SDK

Sources:

- Local skill: `/Users/auro/code/upstream/skills-cursor-2026-05-02/cursor-sdk/SKILL.md`
- Official release post: https://cursor.com/blog/typescript-sdk
- Cursor model docs: https://docs.cursor.com/models
- Cursor model-list API docs: https://docs.cursor.com/en/background-agent/api/list-models
- NPM package inspected: `@cursor/sdk@1.0.13`

Findings:

- The TypeScript SDK supports local and cloud runs through `@cursor/sdk`.
- Local SDK examples use `Agent.create({ apiKey, model: { id }, local: { cwd } })`, `agent.send()`, `run.stream()`, and `run.wait()`.
- `Agent.prompt()` is the simplest one-shot path and disposes automatically.
- The SDK has a model-list API surface through `Cursor.models.list(...)`; use it for model preflight where possible.
- Cursor docs emphasize model IDs can change; local validation should call the model catalog rather than hardcoding unusual IDs.
- Cursor startup/config/auth/network failures throw `CursorAgentError`; a run that starts and then fails returns a terminal run result with error status. The adapter must map those separately.
- Local runs should pass `local: { cwd }` explicitly.
- Cloud behavior can open PRs when configured. This CLI must not use cloud PR creation features.
- Current `@cursor/sdk@1.0.13` package types do not expose a native `outputFormat: json_schema` equivalent.
- Cursor's first adapter should use local SDK execution and terminal text capture to prove the end-to-end review contract quickly.
- The package types do expose MCP server configuration and stream `tool_call` events, so a later Cursor structured-result path should use a local MCP `review_output` tool whose args are validated as `ReviewResult`.
- Text JSON extraction is an ordinary core parser path, not Cursor-specific adapter logic. The validation artifact must still record whether the output came from native structure, a tool call, extracted JSON, or fallback text.

#### Claude Agent SDK

Sources:

- Official structured output docs: https://docs.claude.com/en/docs/agent-sdk/structured-outputs
- Official TypeScript reference: https://docs.claude.com/en/docs/agent-sdk/typescript
- Local upstream clone: `/Users/auro/code/upstream/claude-agent-sdk-typescript`

Findings:

- Claude Agent SDK supports structured outputs by passing `options.outputFormat: { type: "json_schema", schema }` to `query()`.
- The result message includes `structured_output` on success.
- The SDK validates schema output and retries on mismatch; if validation still fails, the result is an error rather than structured data.
- TypeScript options include `model`, `fallbackModel`, `cwd`, `env`, `executable`, `pathToClaudeCodeExecutable`, `tools`, `mcpServers`, `settingSources`, `stderr`, and related execution controls.
- The SDK may spawn a native Claude Code binary through optional per-platform dependencies. Preflight must check runtime/package/binary availability.
- The local changelog exports an `EffortLevel` type with `low`, `medium`, `high`, and `max`; it also exposes model capability metadata such as supported effort levels. The CLI's public `xhigh` should map to Claude `max` if supported.

#### Pi Agent SDK

Sources:

- Official SDK docs: https://pi.dev/docs/latest/sdk
- Local upstream clone: `/Users/auro/code/upstream/pi-mono` at commit `f2b105dd56`
- Local docs: `packages/coding-agent/docs/sdk.md`, `packages/coding-agent/docs/models.md`, `packages/agent/README.md`, `packages/ai/README.md`
- Local source: `packages/agent/src/types.ts`, `packages/ai/src/models.ts`, `packages/coding-agent/src/core/sdk.ts`

Findings:

- Pi exposes `createAgentSession()` through `@earendil-works/pi-coding-agent`.
- Model selection uses `getModel(...)` and `ModelRegistry`; `modelRegistry.find(...)` can include custom models, and `modelRegistry.getAvailable()` filters to models with valid credentials.
- Auth resolution flows through `AuthStorage`: runtime overrides, stored `auth.json`, environment variables, then custom provider fallback.
- Pi supports `thinkingLevel`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Pi computes supported thinking levels from model metadata. Non-reasoning models support only `off`; models with `thinkingLevelMap` can disable levels with `null` or map `xhigh` to provider-specific values such as `max`.
- Pi exposes `clampThinkingLevel(model, level)`, which maps unsupported requested levels to the nearest supported level. `diffwarden` should use that behavior through the Pi adapter and record requested/effective effort values.
- The lower-level agent package supports TypeBox-schema tools, validated tool arguments, `beforeToolCall`, `afterToolCall`, and tool results with `terminate: true`.
- A typed terminating `review_output` tool is the preferred structured-output path for Pi.
- Pi includes read-only tool factory exports, including `createReadOnlyTools`, plus individual read/search/list tool factories. The adapter should construct an explicitly read-only tool set rather than relying on defaults.
- Pi's provider/model system supports OpenRouter, OpenCode-family providers, provider compatibility flags, model overrides, custom models, and provider-specific reasoning controls. These belong in reviewer profiles and `providerOptions`/`sdkOptions`, not in the main CLI flag surface.

#### Multi-reviewer design implication

The current runner design should stay in v1 even if aggregation starts conservative. Single-reviewer, two-reviewer, and fully customized reviewer sets are the same runtime shape:

```bash
diffwarden --target base:main
diffwarden --target base:main --reviewer cursor --reviewer claude
diffwarden --target base:main --reviewer cursor:fast --reviewer claude:sonnet-high --reviewer pi:openrouter-high
```

The runner should treat default review as a one-element reviewer set. This avoids special casing and keeps multi-reviewer behavior foundational rather than bolted on later.

## 12. Git behavior

### 12.1 Repo detection

Use git commands from `cwd`:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
```

If no git repo is found, exit `2` with a helpful error.

### 12.2 Uncommitted target

Need to include:

- staged changes
- unstaged changes
- untracked files

Implementation notes:

- `git diff --staged`
- `git diff`
- `git ls-files --others --exclude-standard`
- For untracked files, include file path and content summary or synthesize a diff using `git diff --no-index /dev/null <file>`.
- Preserve deleted file, renamed file, binary file, and mode-change metadata in the resolved target.
- For large untracked files, include path, size, and a truncation note rather than sending unlimited content.

### 12.3 Base target

For `base:main`:

```bash
git merge-base HEAD main
git diff <merge-base>
```

### 12.4 Commit target

For `commit:<sha>`:

```bash
git show --format=fuller --stat --patch <sha>
```

Or:

```bash
git diff <sha>^ <sha>
```

Use the simpler reliable version first.

For v1, `commit:<sha>` is part of the required surface. Prefer a patch form that keeps changed-line information easy to validate:

```bash
git diff <sha>^ <sha>
```

Use `git show --format=fuller --stat --patch <sha>` only when the extra commit metadata is needed in the prompt or artifact.

## 13. Validation behavior

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
- Valid schema with invalid locations should be distinguishable from invalid schema in the ReviewArtifact.

Non-strict mode:

- Render what can be rendered.
- Include validation warnings in verbose mode or artifact JSON.
- A review with useful text but bad location mapping should still be readable in Markdown.

## 14. Output formats

### 14.1 Markdown default

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

No-findings example:

```markdown
# Code Review

Engine: cursor
Target: commit:abc123
Verdict: patch is correct
Confidence: 0.78

No findings.

## Overall explanation

The reviewed patch does not appear to introduce correctness issues.
```

### 14.2 JSON output

`--format json` prints the full `ReviewArtifact`. The full artifact is the stable automation contract because callers need reviewer, target, validation, and timing metadata. If a narrower payload becomes useful later, add an explicit `--json-result-only` option.

## 15. Configuration

Initial precedence:

1. CLI flags
2. environment variables
3. project config file
4. user config file
5. built-in defaults for non-reviewer behavior only

Possible environment variables:

```text
DIFFWARDEN_REVIEWERS=cursor,claude,pi:openrouter-high
DIFFWARDEN_REVIEWER_SET=2
DIFFWARDEN_MODEL=<sdk-model-id>
DIFFWARDEN_EFFORT=high
DIFFWARDEN_TIMEOUT_SECONDS=300
CURSOR_API_KEY=...
ANTHROPIC_API_KEY=...
```

Config file is required for real SDK runs. Discover config in this order:

1. `diffwarden.config.json` from `cwd` upward to the git repo root.
2. `$XDG_CONFIG_HOME/diffwarden/diffwarden.config.json`.
3. `~/.config/diffwarden/diffwarden.config.json` when `XDG_CONFIG_HOME` is unset.

If no config exists, exit `2` with a message explaining where to create one. The CLI can still run credential-free unit tests and fake-adapter tests without a user config.

`diffwarden init` should create a starter config at `$XDG_CONFIG_HOME/diffwarden/diffwarden.config.json`, or `~/.config/diffwarden/diffwarden.config.json` when `XDG_CONFIG_HOME` is unset. It should create parent directories as needed, refuse to overwrite an existing config unless a future explicit force flag is added, and print the created path.

```json
{
  "defaultReviewerSet": "1",
  "reviewerSets": {
    "1": ["pi"],
    "2": ["pi", "claude"],
    "3": ["pi", "claude", "cursor"],
    "deep": ["pi:openrouter-high", "claude-deep", "cursor-fast"]
  },
  "reviewers": [
    {
      "id": "pi",
      "sdk": "pi",
      "model": "claude-sonnet-4-20250514",
      "effort": "medium"
    },
    {
      "id": "cursor-fast",
      "sdk": "cursor",
      "model": "composer-2",
      "modelCatalog": ["composer-2"],
      "effort": "medium"
    },
    {
      "id": "claude-deep",
      "sdk": "claude",
      "model": "sonnet",
      "modelCatalog": ["sonnet", "opus"],
      "effort": "high"
    },
    {
      "id": "pi-openrouter-high",
      "sdk": "pi",
      "profile": "openrouter-high",
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet",
      "modelCatalog": ["anthropic/claude-sonnet", "openai/gpt-5.2"],
      "effort": "high",
      "providerOptions": {
        "baseUrlEnv": "OPENROUTER_BASE_URL",
        "apiKeyEnv": "OPENROUTER_API_KEY"
      },
      "sdkOptions": {
        "providerProfile": "openrouter"
      }
    }
  ],
  "readonly": true,
  "timeoutSeconds": 300
}
```

Rules:

- If no reviewer is provided, use `defaultReviewerSet`, then `reviewerSets["1"]`.
- `--reviewer-set <name|count>` must resolve to a configured set.
- `--reviewer <spec>` may reference a built-in SDK id (`pi`, `claude`, `cursor`) or a named profile.
- Config validation is part of CLI startup. Unknown reviewer profiles, malformed reviewer sets, invalid model catalogs, and invalid effort catalogs exit `2`.
- Secrets in config must be env var references only. Do not support literal API keys in committed or user config.
- Pi is the recommended default reviewer profile because it supports the broadest provider surface. Claude subscription users should configure a Claude profile, Cursor subscription users should configure a Cursor profile, and other provider routes should generally use Pi profiles.

The public `effort` vocabulary follows Pi thinking levels: `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Adapters are responsible for mapping those values to SDK-specific controls, clamping through model metadata where available, or reporting best-effort/ignored behavior when unsupported.

## 16. Security and side effects

Default posture:

- Read-only.
- No file modification.
- No PR posting.
- No GitHub review comments.
- No network side effects beyond the selected SDK/API.
- No secret printing.

If a reviewer adapter requires shell access, restrict the prompt and adapter policy to read/grep/find/git inspection. Write-capable tools are permanently out of scope for this CLI.

Reviewers should be allowed to inspect surrounding code with read-only tools. A diff alone is often insufficient for a high-quality review. The reviewed surface remains the target diff, but adapters may expose safe context tools that allow reading files, listing/searching files, and running read-only git/shell inspection commands.

Codex review reference, refreshed from `/Users/auro/code/upstream/codex` at commit `02a7205250` on 2026-05-14:

- Codex review runs as a sub-Codex review task with review-specific prompts from `codex-rs/core/src/review_prompts.rs`.
- Codex sets the review subagent base instructions to `REVIEW_PROMPT`, uses `review_model` when configured, and sets approval policy to never in `codex-rs/core/src/tasks/review.rs`.
- The newer review-thread path disables web search for reviews and keeps review execution constrained while preserving repository inspection context in `codex-rs/core/src/session/review.rs`.
- Codex review output parsing first tries to deserialize the final agent message as `ReviewOutputEvent`, then extracts the first JSON object substring, then falls back to putting plain text into `overall_explanation` in `codex-rs/core/src/tasks/review.rs`.
- The Codex tool registry includes shell/unified exec, MCP resource listing/reading, planning/goal tools, view-image, apply-patch, and multi-agent tools depending on configuration in `codex-rs/core/src/tools/spec_plan.rs`.
- For `diffwarden`, only the read-only subset should be exposed: file read/list/search, `git diff`, `git show`, `git status`, `git grep`, `rg`, `sed`, `nl`, and equivalent inspection commands. Do not expose apply-patch, edit/write tools, web search, PR posting, GitHub comment tools, or multi-agent spawning inside reviewer adapters.

Each adapter must document its read-only capability level:

- `enforced`: SDK or sandbox policy prevents writes.
- `tool-restricted`: adapter only exposes read-only tools, but enforcement depends on the SDK.
- `prompt-only`: the adapter asks for read-only behavior but cannot enforce it.

The CLI should surface this in verbose output and ReviewArtifact metadata once adapter capability reporting exists.

Cursor local mode can be `best_effort` for v1. Document the exact Cursor SDK/sandbox controls used by the adapter, and do not imply hard read-only enforcement unless the SDK provides it.

## 17. Test plan

Use fixtures for core behavior before live SDK calls.

### 17.1 Unit tests

- target parsing
- git target resolution with temp repos
- prompt assembly
- JSON extraction from messy model output
- schema validation
- diff hunk overlap validation
- Markdown rendering
- reviewer config expansion
- model and effort validation
- adapter preflight error mapping
- multi-reviewer aggregation

### 17.2 Adapter smoke tests

Adapter smoke tests should be opt-in because they may require credentials and spend money.

Integration test controls:

```bash
INTEGRATION_TEST_ON=1 npm test -- --runInBand
INTEGRATION_TEST_ON=1 INTEGRATION_DISABLE=cursor npm test
INTEGRATION_TEST_ON=1 INTEGRATION_DISABLE=cursor,claude npm test
```

`INTEGRATION_TEST_ON=1` enables live SDK tests. `INTEGRATION_DISABLE` is a comma-separated denylist for SDKs that are not authenticated or should not spend tokens in the current environment.

### 17.3 End-to-end fixture

Create a tiny fixture repo with an obvious bug:

- base commit has a safe implementation
- branch introduces a null dereference or off-by-one
- expected review contains at least one P1/P2 finding on the changed line

### 17.4 Tooling

Use a TypeScript CLI stack:

- `tsx` for local TypeScript execution.
- `vitest` for unit and integration tests.
- `zod` for CLI/config/artifact validation.
- `pnpm` for package scripts and lockfile.
- strong `tsconfig` with strict type checking.
- linting, formatting, and complexity checks in CI.
- Prefer Biome for formatting/linting if it covers the needed rules.
- Add complexity enforcement immediately, even if it requires a second tool beyond Biome.

## 18. Implementation phases

### Phase 1: Scaffold, core CLI, and structured contract

Deliverables:

- TypeScript package scaffold.
- `pnpm`, `tsx`, `vitest`, `zod`, strict TypeScript config, formatting, linting, and complexity-check setup.
- CLI arg parsing.
- target parser.
- git repo resolution.
- `uncommitted`, `base:<branch>`, and `commit:<sha>` target resolution.
- prompt builder.
- output parser.
- Markdown renderer.
- JSON ReviewArtifact output.
- reviewer config expansion.
- `diffwarden.config.json` project/user discovery and validation.
- `diffwarden init` for creating the user-level config under XDG config paths.
- default reviewer-set expansion from config.
- review runner interface for one or more reviewers.
- tests for core functions.

### Phase 2: SDK adapters

Deliverables:

- `src/adapters/cursor.ts`
- `src/adapters/claude.ts`
- `src/adapters/pi.ts`
- SDK-backed execution only; no direct executable adapter as the primary path.
- shared adapter output handling for `{ structured }`, `{ text }`, capture metadata, timeout, and execution errors.
- structured output support where each SDK has a reliable schema/tool mechanism.
- Cursor text-output proof through local SDK execution first; then structured-output proof through a local MCP `review_output` tool and captured SDK `tool_call` event args.
- Claude structured-output implementation through `query({ options: { outputFormat: { type: "json_schema", schema } } })`.
- Pi structured-output implementation through a typed terminating `review_output` tool.
- preflight checks for SDK/runtime requirements, auth, provider/profile coherence, model, and effort.
- graceful error messages for invalid model, invalid effort, missing requirements, missing auth, timeout, and SDK execution failures.
- live smoke commands gated by `INTEGRATION_TEST_ON` and `INTEGRATION_DISABLE`.
- model, effort, provider, `sdkOptions`, and `providerOptions` mapping per adapter.

### Phase 3: Multi-reviewer runner

Deliverables:

- repeated `--reviewer` support.
- `--reviewer-set <name|count>` support.
- concurrent reviewer execution with timeout handling.
- support for multiple reviewer configs using the same SDK.
- per-reviewer artifacts plus deterministic aggregate rendering.
- default Markdown sorted by priority/location with reviewer attribution.
- verbose Markdown grouped by reviewer.

### Phase 4: Validation hardening

Deliverables:

- diff hunk parser
- location overlap checks
- strict mode
- clear schema-vs-location validation reporting

### Phase 5: Deferred read-only target expansion

Deliverables:

- optional `pr:<number|url>` target resolution if it remains read-only.
- no PR posting.
- no GitHub review comments.
- no write-capable tools.

## 19. Acceptance criteria for v1

1. Running `diffwarden --target uncommitted` from a git repo uses the default reviewer set from config.
2. Running `diffwarden --target uncommitted` without any project or user config exits `2` with a clear config-required message.
3. Running `diffwarden --target base:main --reviewer pi` completes through the Pi Agent SDK and prints Markdown.
4. Running `diffwarden --target base:main --reviewer claude` completes through the Claude Agent SDK and prints Markdown.
5. Running `diffwarden --target base:main --reviewer cursor` completes through the Cursor Agent SDK and prints Markdown.
6. Running `diffwarden --target commit:<sha> --reviewer cursor` reviews only that commit.
7. Running `diffwarden --target base:main --reviewer-set 2 --format json --out review.json` writes a valid multi-reviewer ReviewArtifact.
8. Running `diffwarden --target base:main --reviewer cursor --reviewer claude --reviewer pi:openrouter-high --format json --out review.json` writes a valid explicit multi-reviewer ReviewArtifact.
9. Default multi-reviewer Markdown sorts findings by priority/location and includes reviewer attribution; verbose Markdown can group by reviewer.
10. Multi-reviewer runs render partial successful results with warnings unless all reviewers fail or `--strict` is set.
11. The CLI exits `2` for invalid targets or non-git directories.
12. The CLI exits `2` with a clear message for invalid effort values and locally invalid model values.
13. The CLI exits `3` with a clear message for missing SDK/runtime requirements, missing SDK-required executables, missing auth, provider setup failures, timeouts, and SDK execution failures.
14. Claude adapter returns `structured` from native structured output.
15. Pi adapter returns `structured` from a terminating `review_output` tool.
16. Cursor adapter documents and tests local SDK text capture and the later MCP `review_output` structured-output path; if Cursor does not call the tool, terminal text capture and centralized parser metadata remain explicit.
17. The parser can recover JSON from typical fenced-code model output for adapters that cannot produce structured output directly.
18. The renderer displays findings, file paths, line ranges, verdict, confidence, and a clear no-findings state.
19. No files are modified by default.
20. Core tests pass without live SDK credentials.

## 20. Open decisions

1. Exact public `effort` adapter mappings after SDK spikes.
2. Whether to add a separate direct executable adapter for Claude Code subscription auth later.

Resolved design decisions:

- Reviewer spec grammar: use `sdk[:profile]` for v1. Inline model/provider expressions are deferred.
- Multi-reviewer deduplication: exact file, exact line range, exact priority, and normalized-title match only. Do not fuzzy-merge findings in v1.
- Adapter shape: adapters run SDKs and capture output; core code owns prompt assembly, parsing, validation, rendering, and aggregation.
- Cursor sequencing: prove local SDK execution and terminal text capture first; then add a local MCP `review_output` tool with streamed `tool_call` capture as the preferred structured-output upgrade, based on `@cursor/sdk@1.0.13` exposing MCP config and tool-call events but no native JSON-schema output option.
- Package/repository/CLI name: `diffwarden`; public GitHub repo is `aurokin/diffwarden`; npm publishing is deferred.
- Config file name is `diffwarden.config.json`.
- Config is required for real SDK runs and should be discovered through project config, then XDG user config.
- `diffwarden init` creates the user-level config.
- `ReviewArtifact.schema_version` is locked at `1`; breaking artifact changes require a future schema version.
- Integration tests are gated by `INTEGRATION_TEST_ON` with `INTEGRATION_DISABLE` as an SDK denylist.
- License: MIT.
- Package manager/tooling: `pnpm`, `tsx`, `vitest`, `zod`, strict TypeScript, formatting, linting, and complexity enforcement from the first scaffold.

## 21. First implementation recommendation

Start with the smallest useful SDK-backed tool that proves the full shape and answers SDK uncertainty before broader implementation:

```bash
diffwarden --target uncommitted
diffwarden --target base:main --reviewer claude --format json
diffwarden --target base:main --reviewer pi --format json
diffwarden --target commit:abc123 --reviewer cursor
diffwarden --target base:main --reviewer-set 2
diffwarden --target base:main --reviewer cursor --reviewer claude --reviewer pi:openrouter-high
```

Build the core around Codex's review schema and prompt, then implement fake adapters that return fixture `ReviewResult`s. Once the contract is proven, implement the Cursor text-capture spike first because it answers whether the CLI can get useful review output from Cursor with a thin adapter. Then implement Claude native structured output, Pi terminating-tool output, and Cursor's MCP `review_output` upgrade. Keep Markdown as the default renderer because humans and coding agents can both read it, and make full JSON available for automation.
