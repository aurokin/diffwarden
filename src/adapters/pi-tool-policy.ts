export const piReadOnlyTools = ["read", "grep", "find", "ls"] as const;
export const piReviewOutputToolName = "review_output";
export const piSdkReviewTools = [...piReadOnlyTools, piReviewOutputToolName] as const;
export const piCliToolsArgument = piReadOnlyTools.join(",");
export const piCliAmbientDisableArgs = [
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
] as const;

export const piCliReviewSurfaceArgs = [
  "--no-session",
  "--tools",
  piCliToolsArgument,
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
] as const;
