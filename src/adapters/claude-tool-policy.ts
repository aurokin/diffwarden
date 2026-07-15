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

/** Probed against `--help`; absence degrades behavior instead of failing preflight. */
export const claudeCliOptionalCliFlags = [
  "--system-prompt",
  "--bare",
  "--fallback-model",
  "--max-budget-usd",
  // Not a flag: the --output-format value that gates stream-mode switching.
  // Probed with the same help-text inclusion check as the flags above.
  "stream-json",
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
