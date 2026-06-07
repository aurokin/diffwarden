export const grokCliReviewOutputFormat = "json";
export const grokCliReviewPermissionMode = "dontAsk";
export const grokCliReviewSandbox = "read-only";

export const grokCliReviewTools = ["read_file", "grep", "list_dir"] as const;

export const grokCliDisallowedTools = [
  "web_search",
  "web_fetch",
  "search_replace",
  "write_file",
  "run_terminal_cmd",
  "Agent",
] as const;

export const grokCliAllowRules = ["Read", "Grep"] as const;

export const grokCliDenyRules = ["Bash", "Edit", "Write", "WebFetch", "MCPTool"] as const;

export const grokCliReviewPolicyCliFlags = [
  "--prompt-file",
  "--cwd",
  "--output-format",
  "--permission-mode",
  "--allow",
  "--deny",
  "--tools",
  "--disallowed-tools",
  "--sandbox",
  "--no-subagents",
  "--no-memory",
  "--disable-web-search",
] as const;

export function grokCliReviewToolsArg(): string {
  return grokCliReviewTools.join(",");
}

export function grokCliDisallowedToolsArg(): string {
  return grokCliDisallowedTools.join(",");
}

export function grokCliReviewPolicyMetadata(): Record<string, unknown> {
  return {
    grokPermissionMode: grokCliReviewPermissionMode,
    grokSandboxMode: grokCliReviewSandbox,
    grokAllowedTools: [...grokCliReviewTools],
    grokDisallowedTools: [...grokCliDisallowedTools],
    grokAllowRules: [...grokCliAllowRules],
    grokDenyRules: [...grokCliDenyRules],
    grokWebSearch: "disabled",
    grokSubagents: "disabled",
    grokMemory: "disabled",
  };
}
