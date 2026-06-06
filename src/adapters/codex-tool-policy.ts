export const codexCliReviewBaseArgs = [
  "exec",
  "--json",
  "--sandbox",
  "read-only",
  "--ephemeral",
] as const;

export const codexCliOutputSchemaArg = "--output-schema";
export const codexCliOutputLastMessageArg = "--output-last-message";
export const codexCliCwdArg = "--cd";
export const codexCliPromptStdinArg = "-";
export const codexCliIgnoredRulesArg = "--ignore-rules";
export const codexCliIgnoredUserConfigArg = "--ignore-user-config";

export const codexAppServerExecEnabled = true;

export const codexAppServerThreadPermissionParams = {
  approvalPolicy: "never",
  sandbox: "read-only",
} as const;

export const codexAppServerReviewThreadParams = {
  ...codexAppServerThreadPermissionParams,
  ephemeral: true,
  experimentalRawEvents: false,
  persistExtendedHistory: false,
} as const;

export const codexAppServerTurnSandboxPolicy = {
  type: "readOnly",
  access: { type: "fullAccess" },
  networkAccess: false,
} as const;

export const codexAppServerTurnPermissionParams = {
  approvalPolicy: "never",
  sandboxPolicy: codexAppServerTurnSandboxPolicy,
} as const;

export const codexAppServerIsolatedDisabledFeatures = [
  "plugins",
  "apps",
  "computer_use",
  "browser_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
] as const;

export const codexAppServerIsolatedDisableArgs: readonly string[] =
  codexAppServerIsolatedDisabledFeatures.flatMap((feature) => ["--disable", feature]);

export const codexNativeReviewOutput = "rendered-text";
export const codexNativeReviewStructuredFindings = false;
export const codexNativeReviewEffectiveWebSearchReason = "codex-native-review-disables-web-search";

export const codexAppServerDeveloperInstructions = [
  "You are running inside Diffwarden as a read-only code reviewer.",
  "Inspect the requested repository state and return only the requested review result.",
  "Do not modify files. Do not ask for permission to modify files.",
  "Command execution is currently enabled for this app-server transport, but approval escalations are denied and the sandbox is read-only.",
].join("\n");
