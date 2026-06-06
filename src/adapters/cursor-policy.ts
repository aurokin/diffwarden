import type { AgentModeOption, AgentOptions, LocalAgentOptions } from "@cursor/sdk";

export const cursorReviewMode = "plan" satisfies AgentModeOption;
export const cursorReviewAutoReview = true;
export const cursorReviewSettingSources = [] satisfies NonNullable<
  LocalAgentOptions["settingSources"]
>;
export const cursorReviewSandboxOptions = {
  enabled: true,
} satisfies NonNullable<LocalAgentOptions["sandboxOptions"]>;
export const cursorReviewMcpServers = {} satisfies NonNullable<AgentOptions["mcpServers"]>;

export const cursorCliReviewMode = "plan";
export const cursorCliSandboxMode = "enabled";
