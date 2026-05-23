# Reviewer Feature Matrix

This matrix summarizes currently supported reviewer capabilities in Diffwarden. The
code-owned source of truth is `src/adapters/capabilities.ts`; this page describes
Diffwarden's adapter behavior, not every feature exposed by the underlying vendor tool.

Legend:

- `yes`: supported by Diffwarden for that adapter path.
- `no`: not supported by Diffwarden for that adapter path.
- `n/a`: not applicable.
- `enforced`: Diffwarden uses a native read-only/sandbox/spec mode.
- `tool-restricted`: Diffwarden restricts available tools to read-oriented tools.
- `prompt-only`: Diffwarden asks for read-only review behavior, but hard enforcement is not
  proven for that adapter path.

## Reviewer Selection

| Reviewer spec | Engine | Default transport | Alternate transport | Default executable | Default model |
| --- | --- | --- | --- | --- | --- |
| `fake` | Built-in fake reviewer | n/a | n/a | n/a | n/a |
| `codex` | Codex CLI | CLI | no | `codex` | CLI default |
| `claude` | Claude Agent SDK | SDK | CLI | `claude` for CLI/local auth | `sonnet` |
| `cursor` | Cursor SDK | SDK | CLI | `cursor-agent` for CLI | `composer-2.5` |
| `pi` | Pi Coding Agent SDK | SDK | CLI | `pi` for CLI | first authenticated Pi model |
| `droid` | Factory Droid SDK | SDK | CLI | `droid` | Droid default |
| `gemini` | Gemini CLI | CLI | no | `gemini` | CLI default |
| `opencode` | OpenCode CLI | CLI | no | `opencode` | CLI default |
| `grok` | Grok CLI | CLI | no | `grok` | CLI default |
| `antigravity` | Antigravity CLI | CLI | no | `agy` | CLI default |

SDK-backed reviewers can opt into CLI transport from config:

```json
{
  "reviewers": [
    {
      "id": "claude-cli",
      "sdk": "claude",
      "transport": "cli"
    }
  ]
}
```

## Capability Matrix

| Adapter path | Model override | Effort override | Capture mode | Read-only capability | Auth/preflight behavior |
| --- | --- | --- | --- | --- | --- |
| `fake` | no | no | native structured | enforced | no external auth |
| `codex` CLI | yes | yes | native structured | enforced | executable preflight; CLI owns auth |
| `claude` SDK | yes | yes | native structured with text fallback | enforced | SDK load, auth, and model preflight |
| `claude` CLI | yes | yes | native structured | tool-restricted | executable preflight; CLI owns auth |
| `cursor` SDK | yes | ignored | text | prompt-only | SDK load, `CURSOR_API_KEY`, and model preflight |
| `cursor` CLI | yes | no | text | prompt-only | executable preflight; CLI owns auth |
| `pi` SDK | yes | yes | terminating tool call | tool-restricted | SDK load and environment-backed model preflight |
| `pi` CLI | yes | yes | JSONL/text | tool-restricted | executable preflight; CLI owns auth |
| `droid` SDK | yes | yes | native structured with text fallback | enforced | SDK load, executable check, auth warning/pass |
| `droid` CLI | yes | yes | JSON/text | enforced | executable preflight; CLI owns auth |
| `gemini` CLI | yes | no | JSON/text | tool-restricted | executable preflight; CLI owns auth |
| `opencode` CLI | yes | yes | JSONL/text | prompt-only | executable preflight; CLI owns auth |
| `grok` CLI | yes | yes | JSON/text | prompt-only | executable preflight; CLI owns auth |
| `antigravity` CLI | no | no | text | prompt-only | executable preflight; CLI owns auth |

## Adapter Notes

| Adapter path | Notes |
| --- | --- |
| `codex` CLI | Runs `codex exec` with read-only sandboxing, ephemeral execution, and an output schema file. Diffwarden uses this path instead of `codex review` because `codex exec` exposes the JSON-schema contract needed by the shared parser. |
| `claude` SDK | Uses `@anthropic-ai/claude-agent-sdk`, disables built-in tools, disables session persistence, and can reuse local Claude Code auth when no `ANTHROPIC_API_KEY` is present. |
| `claude` CLI | Uses `claude -p` with plan mode, read-only tools, disallowed write/bash tools, no session persistence, disabled slash commands, and JSON schema output. |
| `cursor` SDK | Uses `@cursor/sdk` in local mode. Effort is accepted by the public config shape but reported as ignored for Cursor SDK runs. |
| `cursor` CLI | Uses `cursor-agent -p` in plan mode with sandbox enabled. Diffwarden treats read-only as prompt-only until stronger enforcement is proven. |
| `pi` SDK | Uses a scoped Pi session with `read`, `grep`, `find`, `ls`, and a terminating `review_output` custom tool. Extensions, prompts, themes, and context files are not loaded. |
| `pi` CLI | Uses print JSON mode, disables sessions, extensions, skills, prompt templates, themes, and context files, and restricts tools to `read`, `grep`, `find`, and `ls`. |
| `droid` SDK | Uses Factory Droid spec interaction mode, autonomy off, JSON-schema output, optional `sdkOptions.machineId`, and Diffwarden session tags. SDK sessions still appear in Factory session history. |
| `droid` CLI | Uses `droid exec --use-spec`, JSON output, Diffwarden session tags, and model/effort flags where provided. This is the recommended Droid path for routine reviews. |
| `gemini` CLI | Uses JSON output and plan approval mode. |
| `opencode` CLI | Uses `opencode run --pure`, provider-qualified model support, effort mapped to variant, and a restrictive `OPENCODE_PERMISSION` environment policy. It remains marked prompt-only until hard read-only enforcement is proven. |
| `grok` CLI | Uses plan permission mode, disables subagents, disables memory, and disables web search. It remains marked prompt-only until hard read-only enforcement is proven. |
| `antigravity` CLI | Uses print mode, sandbox mode, and adds the reviewed directory. Model and effort overrides are rejected for this path. |

## Common Core Features

These features apply across adapter paths:

| Feature | Status |
| --- | --- |
| `uncommitted` targets | yes |
| `base:<branch>` targets | yes |
| `commit:<sha>` targets | yes |
| `pr:<number\|url>` targets | no |
| `custom:<text>` targets | yes |
| Multiple reviewers in one run | yes |
| Reviewer sets from config | yes |
| Markdown output | yes |
| JSON output | yes |
| Finding validation | yes |
| Finding deduplication and attribution | yes |
| GitHub PR posting | no |
| Inline GitHub review comments | no |
| `--fail-on-findings` CI gating | no |

## Target Behavior

Diff-backed targets (`uncommitted`, `base:<branch>`, and `commit:<sha>`) collect a patch,
populate `changed_files`, embed the patch in the reviewer prompt, and validate findings
against the changed files and changed-line ranges.

`custom:<text>` targets use the provided text as repository-scoped review instructions.
They still use the normal reviewer selection, preflight, output parsing, schema validation,
path validation, aggregation, Markdown rendering, and JSON artifact path. They skip diff
collection, patch embedding, `changed_files` population, and changed-line overlap
validation because there is no single target patch.
