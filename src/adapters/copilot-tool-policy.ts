import { realpath } from "node:fs/promises";
import path from "node:path";
import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type { PermissionHandler } from "@github/copilot-sdk";

export const copilotReviewReadTools = ["view", "read_file"] as const;
export const copilotReviewSearchTools = ["file_search", "grep_search"] as const;
export const copilotReviewAvailableTools = [
  ...copilotReviewReadTools,
  ...copilotReviewSearchTools,
] as const;
export const copilotSdkReviewAvailableTools = copilotReviewAvailableTools.map(
  (tool) => `builtin:${tool}`,
);

export const copilotReviewExcludedTools = [
  "create",
  "edit",
  "insert",
  "str_replace_editor",
  "bash",
  "shell",
  "web_fetch",
  "web_search",
  "delegate",
  "fleet",
  "task",
  "subagent",
  "memory",
] as const;

export const copilotCliReviewDeniedToolPatterns = ["write", "shell", "url"] as const;
export const copilotCliDisableMcpServerFlag = "--disable-mcp-server";

export const copilotCliReviewPolicyCliFlags = [
  "-C",
  "-p",
  "--output-format",
  "--stream",
  "--available-tools",
  "--excluded-tools",
  "--allow-all-tools",
  "--deny-tool",
  "--disable-builtin-mcps",
  "--no-custom-instructions",
  "--no-ask-user",
  "--no-remote",
  "--no-auto-update",
  "--add-dir",
] as const;

export function copilotCliReviewPolicyFlagsForArgs(args: readonly string[]): string[] {
  const flags: string[] = [...copilotCliReviewPolicyCliFlags];
  for (const optionalFlag of [copilotCliDisableMcpServerFlag, "--model", "--effort"]) {
    if (args.includes(optionalFlag)) {
      flags.push(optionalFlag);
    }
  }
  return flags;
}

export const copilotReviewPolicyName = "read-search-allowlist";

export function copilotReviewAvailableToolsArg(): string {
  // Copilot CLI 1.0.60 documents bare --available-tools names; source-qualified
  // builtin:* filters are available through the SDK session options instead. CLI runs
  // use a run-scoped home/settings file, disabled extensions/plugins/MCP, and deny rules
  // to keep same-name non-builtin tools out of the review surface.
  return copilotReviewAvailableTools.join(",");
}

export function copilotReviewExcludedToolsArg(): string {
  return copilotReviewExcludedTools.join(",");
}

export function copilotReviewPolicyMetadata(): Record<string, unknown> {
  return {
    copilotToolPolicy: copilotReviewPolicyName,
    copilotAllowedTools: [...copilotReviewAvailableTools],
    copilotSdkAllowedTools: [...copilotSdkReviewAvailableTools],
    copilotAllowedToolSources: ["builtin"],
    copilotReadTools: [...copilotReviewReadTools],
    copilotSearchTools: [...copilotReviewSearchTools],
    copilotExcludedTools: [...copilotReviewExcludedTools],
    copilotDeniedToolPatterns: [...copilotCliReviewDeniedToolPatterns],
    copilotCliPromptTransport: "prompt-file",
    copilotCliHome: "run-scoped",
    copilotCliToolFilterFormat: "bare-tool-names",
    copilotBuiltinMcps: "disabled",
    copilotConfiguredMcps: "disabled",
    copilotCustomInstructions: "disabled",
    copilotSkills: "run-scoped-home",
    copilotPlugins: "run-scoped-home",
    copilotHooks: "disabled",
    copilotAskUser: "disabled",
    copilotRemoteControl: "disabled",
    copilotTempDirAccess: "run-scoped-tool-output-dir",
  };
}

export function createCopilotSdkPermissionHandler(
  cwd: string,
  extraReadRoots: readonly string[] = [],
): PermissionHandler {
  const roots = [cwd, ...extraReadRoots].map((root) => path.resolve(root));
  return async (request) => copilotSdkPermissionHandler(request, roots);
}

async function copilotSdkPermissionHandler(
  request: PermissionRequest,
  roots: readonly string[],
): Promise<PermissionRequestResult> {
  if (request.kind !== "read") {
    return {
      kind: "reject",
      feedback: `Diffwarden Copilot reviews allow read/search tools only; denied ${request.kind} permission request.`,
    };
  }

  for (const root of roots) {
    const requestedPath = path.resolve(root, request.path);
    if (await isPathWithinDirectory(requestedPath, root)) {
      return { kind: "approve-once" };
    }
  }

  return {
    kind: "reject",
    feedback:
      "Diffwarden Copilot reviews only approve reads inside the review workspace or run-scoped tool-output temp directory.",
  };
}

async function isPathWithinDirectory(candidate: string, root: string): Promise<boolean> {
  const [resolvedCandidate, resolvedRoot] = await Promise.all([
    realpath(candidate).catch(() => candidate),
    realpath(root).catch(() => root),
  ]);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
