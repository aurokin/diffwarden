export const claudeReviewTools = ["Read", "Grep", "Glob"] as const;

export const claudeDisallowedTools = [
  "Bash",
  "PowerShell",
  "Monitor",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Skill",
  "Workflow",
] as const;

export const claudeSdkReviewPolicyCliFlags = [
  "--allowedTools",
  "--disallowedTools",
  "--tools",
  "--strict-mcp-config",
  "--permission-mode",
  "--no-session-persistence",
] as const;

export const claudeCliReviewPolicyCliFlags = [
  ...claudeSdkReviewPolicyCliFlags,
  "--mcp-config",
  "--no-chrome",
  "--disable-slash-commands",
  "--setting-sources",
  "--json-schema",
] as const;

export function claudeReviewToolList(): string[] {
  return [...claudeReviewTools];
}

export function claudeDisallowedToolList(): string[] {
  return [...claudeDisallowedTools];
}

export function claudeCliReviewToolsArg(): string {
  return claudeReviewTools.join(",");
}

export function claudeCliDisallowedToolsArg(): string {
  return claudeDisallowedTools.join(",");
}
