import path from "node:path";

export const antigravityCliReviewSandbox = "enabled";
export const antigravityCliReviewToolPermission = "strict";
export const antigravityCliReviewArtifactReviewPolicy = "asks-for-review";
export const antigravityCliReviewSettingsFileName = "settings.json";
export const antigravityCliReviewMcpConfigFileName = "mcp_config.json";

export const antigravityCliReviewDeniedPermissions = [
  "write_file(*)",
  "command(*)",
  "unsandboxed(*)",
  "read_url(*)",
  "execute_url(*)",
  "mcp(*)",
] as const;

export const antigravityCliReviewAllowedPermissions = ["read_file(*)"] as const;

export function antigravityCliReviewSettings(input: {
  promptPath: string;
  cwd: string;
}): Record<string, unknown> {
  return {
    allowNonWorkspaceAccess: false,
    artifactReviewPolicy: antigravityCliReviewArtifactReviewPolicy,
    enableTerminalSandbox: true,
    toolPermission: antigravityCliReviewToolPermission,
    trustedWorkspaces: antigravityCliReviewTrustedWorkspaces(input),
    permissions: {
      allow: [...antigravityCliReviewAllowedPermissions],
      deny: [...antigravityCliReviewDeniedPermissions],
      ask: [],
    },
  };
}

export function antigravityCliReviewPolicyMetadata(): Record<string, unknown> {
  return {
    antigravitySandbox: antigravityCliReviewSandbox,
    antigravityToolPermission: antigravityCliReviewToolPermission,
    antigravityArtifactReviewPolicy: antigravityCliReviewArtifactReviewPolicy,
    antigravityDeniedPermissions: [...antigravityCliReviewDeniedPermissions],
    antigravityAllowedPermissions: [...antigravityCliReviewAllowedPermissions],
    antigravitySettingsProfile: "temporary-isolated-home",
    antigravityMcpConfig: "empty-temporary-file",
    antigravityAutoUpdate: "disabled",
  };
}

function antigravityCliReviewTrustedWorkspaces(input: {
  promptPath: string;
  cwd: string;
}): string[] {
  return [...new Set([path.resolve(input.cwd), path.dirname(path.resolve(input.promptPath))])];
}
