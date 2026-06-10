# Reviewer Feature Matrix

This matrix summarizes currently supported reviewer capabilities in Diffwarden. The
code-owned source of truth is `src/adapters/capabilities.ts`; this page describes
Diffwarden's adapter behavior, not every feature exposed by the underlying vendor tool.
All adapter paths are expected to preserve Diffwarden's shared Codex-derived review
rubric, parsing behavior, validation path, and Markdown/JSON output contract.

Legend:

- `yes`: supported by Diffwarden for that adapter path.
- `no`: not supported by Diffwarden for that adapter path.
- `n/a`: not applicable.
- `enforced`: Diffwarden uses a native read-only/sandbox/spec mode.
- `tool-restricted`: Diffwarden restricts available tools to read-oriented tools.
- `prompt-only`: Diffwarden asks for read-only review behavior, but hard enforcement is not
  proven for that adapter path.

For the cross-transport tool policy, including the rule that optional configured reviewer
timeouts are the only Diffwarden-owned run-level circuit breaker instead of tool-call or step
caps, see
[`adapters.md`](./adapters.md#tool-policy-guidelines).

## Reviewer Selection

| Reviewer spec | Engine | Default transport | Alternate transport | Default executable | Default model |
| --- | --- | --- | --- | --- | --- |
| `fake` | Built-in fake reviewer | n/a | n/a | n/a | n/a |
| `codex` | Codex CLI/app-server | CLI | APP-SERVER | `codex` | CLI default |
| `claude` | Claude Agent SDK | SDK | CLI | `claude` for CLI/local auth | `sonnet` |
| `cursor` | Cursor SDK | SDK | CLI | `cursor-agent` for CLI | `composer-2.5` |
| `pi` | Pi Coding Agent SDK | SDK | CLI | `pi` for CLI | first authenticated Pi model |
| `droid` | Factory Droid SDK | SDK | CLI | `droid` | Droid default |
| `copilot` | GitHub Copilot SDK | SDK | CLI | `copilot` | CLI default |
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
      "engine": "claude",
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
| `codex` APP-SERVER | yes | yes | native structured; text in native review mode | enforced | executable and Codex auth preflight; shared `CODEX_HOME` by default or temporary `CODEX_HOME` with `stdio-isolated` |
| `claude` SDK | yes | yes | native structured with text fallback | tool-restricted | SDK load, auth, and model preflight |
| `claude` CLI | yes | yes | native structured | tool-restricted | executable preflight; CLI owns auth |
| `cursor` SDK | yes | ignored | text | prompt-only | SDK load, `CURSOR_API_KEY`, model preflight, and Cursor review-control metadata |
| `cursor` CLI | yes | no | text | prompt-only | executable preflight; CLI owns auth |
| `pi` SDK | yes | yes | terminating tool call | tool-restricted | SDK load and environment-backed model preflight |
| `pi` CLI | yes | yes | JSONL/text | tool-restricted | executable preflight; CLI owns auth |
| `droid` SDK | yes | yes | native structured with text fallback | enforced | SDK load, executable check, auth warning/pass |
| `droid` CLI | yes | yes | JSON/text | enforced | executable preflight; CLI owns auth |
| `copilot` SDK | yes | yes | text | tool-restricted | SDK load; Copilot runtime owns auth |
| `copilot` CLI | yes | yes | JSONL/text | tool-restricted | executable preflight; CLI owns auth |
| `gemini` CLI | yes | no | JSON/text | tool-restricted | executable preflight; CLI owns auth |
| `opencode` CLI | yes | yes | JSONL/text | prompt-only | executable preflight; CLI owns auth |
| `grok` CLI | yes | yes | JSON/text | enforced | executable preflight; CLI owns auth |
| `antigravity` CLI | no | no | text | tool-restricted | executable preflight; CLI owns auth |

## Adapter Notes

| Adapter path | Notes |
| --- | --- |
| `codex` CLI | Runs `codex exec` with read-only sandboxing, ephemeral execution, an output schema file, and `web_search = "disabled"` by default. Diffwarden uses this path instead of `codex review` because `codex exec` exposes the JSON-schema contract needed by the shared parser. This path is sandbox-enforced, not small-tool allowlisted; `--ignore-rules` is not enabled by default until Diffwarden has version-gated fallback behavior. |
| `codex` APP-SERVER | Opt-in transport that defaults to the shared Codex `CODEX_HOME`, attaches to an existing Unix-socket app-server when available, and launches `codex app-server --listen unix://` only when needed. Structured mode is the default review path and keeps Diffwarden's schema contract. Reviews remain ephemeral and read-only with approval escalations denied, `web_search = "disabled"` by default, no client dynamic tools, and optional experimental native `review/start` mode. Native mode is text-only for Diffwarden artifacts and reports effective web search as disabled because Codex disables web search inside the review task. `appServerOptions.mode: "stdio-isolated"` selects a temporary `CODEX_HOME` stdio app-server and disables broad app/plugin/browser/computer/image/multi-agent features. This path is sandbox-enforced, not small-tool allowlisted. |
| `claude` SDK | Uses `@anthropic-ai/claude-agent-sdk`, restricts built-in tools to `Read`, `Grep`, and `Glob`, pairs those tools with `allowedTools` and `permissionMode: "dontAsk"`, disables settings/MCP/session persistence with strict empty MCP config, and can reuse local Claude Code auth when no `ANTHROPIC_API_KEY` is present. |
| `claude` CLI | Uses `claude -p` with `--tools Read,Grep,Glob`, matching `--allowedTools`, disallowed write/shell/web/broad-agent tools, `--permission-mode dontAsk`, no session persistence, disabled slash commands, strict empty MCP config, and JSON schema output. |
| `cursor` SDK | Uses `@cursor/sdk` in local plan mode with sandbox enabled, auto-review enabled, empty setting sources, no MCP servers, and an ephemeral JSONL local store. Effort is accepted by the public config shape but reported as ignored for Cursor SDK runs. This path remains prompt-only because Cursor does not expose deterministic read/glob/grep-only tool allowlisting. |
| `cursor` CLI | Uses `cursor-agent -p` with JSON output, workspace scoping, plan mode, sandbox enabled, and trusted headless execution. Diffwarden treats read-only as prompt-only because Cursor CLI print mode can still expose broad agent tools and the plan/sandbox behavior is provider-owned. |
| `pi` SDK | Uses a scoped Pi session with `read`, `grep`, `find`, `ls`, and a terminating `review_output` custom tool. Extensions, prompts, themes, and context files are not loaded. |
| `pi` CLI | Uses print JSON mode, disables sessions, extensions, skills, prompt templates, themes, and context files, and restricts tools to `read`, `grep`, `find`, and `ls`. |
| `droid` SDK | Uses Factory Droid spec interaction mode, autonomy off, JSON-schema output, an explicit `Read`/`Glob`/`Grep`/`LS`/`ExitSpecMode` tool allowlist, optional `sdkOptions.machineId`, and Diffwarden session tags. SDK sessions still appear in Factory session history. |
| `droid` CLI | Uses `droid exec --use-spec`, default read-only autonomy, JSON output, an explicit `read-cli`/`glob-search-cli`/`grep_tool_cli`/`ls-cli`/`exit-spec-mode` tool allowlist verified with `--list-tools`, Diffwarden session tags/log group IDs, and model/effort flags where provided. This is the recommended Droid path for routine reviews. |
| `copilot` SDK | Uses `@github/copilot-sdk` in empty mode with a run-scoped Copilot home that stages only auth state plus empty MCP config, config discovery/custom instructions/MCP/apps/extensions/skills/hooks/plugins disabled, repo-hook override env scrubbed, source-qualified `builtin:view`/`builtin:read_file`/`builtin:file_search`/`builtin:grep_search` available tools, matching write/shell/web/delegation exclusions, and a permission handler that approves read requests in the repo plus Copilot's run-scoped tool-output temp directory and rejects other permission kinds. The SDK path waits for `session.idle` instead of `sendAndWait`'s default timeout. |
| `copilot` CLI | Uses `-p/--prompt` for non-interactive JSONL output with a short instruction that points to a run-scoped prompt file, adds only the prompt directory and a run-scoped tool-output temp directory with `--add-dir`, uses a run-scoped `HOME`/`COPILOT_HOME`, scoped Windows AppData paths, and an isolated `GH_CONFIG_DIR` that copies Copilot auth state plus GitHub CLI `hosts.yml`, requires the resolved executable to live outside the reviewed workspace, passes `--available-tools view,read_file,file_search,grep_search`, matching exclusions for write/edit/shell/web/delegation tools, disabled built-in/repo-configured MCP/custom instructions/ask-user/remote, scrubbed `COPILOT_ALLOW_ALL`, Node loader env, and repo-hook override env, and `--allow-all-tools` only because Copilot requires it for non-interactive mode and documents that availability filters still bound the exposed tools. |
| `gemini` CLI | Uses JSON output, plan approval mode, a generated all-modes policy/admin policy allowing only `read_file`, `list_directory`, `glob`, and Gemini grep names (`grep_search` plus legacy alias `search_file_content`), empty MCP allowlisting, disabled extensions, and isolated session trust for headless startup. |
| `opencode` CLI | Uses `opencode run --pure`, stdin prompt input, provider-qualified model support, effort mapped to variant, a generated low-tool `diffwarden-review-*` agent, and an `OPENCODE_PERMISSION` policy that allows only `read`, `glob`, and `grep` by default. It remains marked prompt-only until hard read-only enforcement is proven. |
| `grok` CLI | Uses JSON output, `--permission-mode dontAsk`, `--tools read_file,grep,list_dir`, matching read/search allow rules, deny rules for shell/edit/write/web/MCP, `--sandbox read-only`, disabled subagents, disabled memory, and disabled web search. Diffwarden does not pass `--max-turns`; only an explicitly configured reviewer timeout limits the run. |
| `antigravity` CLI | Uses prompt-bearing print mode with a temp prompt file, sandbox mode, an isolated temporary Antigravity CLI settings profile, empty MCP config, strict tool permission, and deny rules for write, shell, unsandboxed, web, and MCP actions. The profile preserves valid non-policy user settings after filtering policy/control keys, then overrides the review policy so file reads are allowed only inside run-scoped trusted roots for the repository and prompt directory. `agy` runs from the prompt directory with `HOME`/`USERPROFILE` pointed at the isolated profile and Windows drive/path home variables removed; copied auth identity files live outside that cwd and outside trusted roots, with fail-closed handling if the temp home or source `.gemini` directory would resolve inside the repo. Model and effort overrides are rejected for this path. |

## Common Core Features

These features apply across adapter paths:

| Feature | Status |
| --- | --- |
| `uncommitted` targets | yes |
| `base:<branch>` targets | yes |
| `commit:<sha>` targets | yes |
| `custom:<text>` targets | yes |
| Multiple reviewers in one run | yes |
| Reviewer sets from config | yes |
| Markdown output | yes |
| JSON output | yes |
| Opt-in review history reports | yes |
| Finding validation | yes |
| Finding deduplication and attribution | yes |
| External review comment publishing | no |
| `--fail-on-findings` CI gating | yes |

## Target Behavior

Diff-backed targets (`uncommitted`, `base:<branch>`, and `commit:<sha>`) collect a patch,
populate `changed_files`, embed the patch in the reviewer prompt, and validate findings
against the changed files and changed-line ranges.

`custom:<text>` targets use the provided text as repository-scoped review instructions.
They still use the normal reviewer selection, preflight, output parsing, schema validation,
path validation, aggregation, Markdown rendering, and JSON artifact path. They skip diff
collection, patch embedding, `changed_files` population, and changed-line overlap
validation because there is no single target patch.

## CI Gating

`--fail-on-findings <P0|P1|P2|P3>` keeps the normal Markdown or JSON output, then exits `1`
when the final aggregated findings include a prioritized finding at or above the threshold.
For example, `--fail-on-findings P2` fails for P0, P1, and P2 findings but not P3 findings.
Findings without a `priority` do not trigger the gate.
