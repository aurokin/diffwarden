import { invalidCli } from "../core/errors.js";
import type { ReviewReviewerConfig } from "./types.js";

export type CodexWebSearchPolicy = "enabled" | "disabled" | "inherit";
export type CodexWebSearchMode = "live" | "disabled";
export type CodexAppServerReviewMode = "structured" | "native";

export function codexCliWebSearchPolicy(reviewer: ReviewReviewerConfig): CodexWebSearchPolicy {
  return parseCodexWebSearchPolicy(reviewer.cliOptions?.webSearch, "cliOptions.webSearch");
}

export function codexAppServerWebSearchPolicy(
  reviewer: ReviewReviewerConfig,
): CodexWebSearchPolicy {
  return parseCodexWebSearchPolicy(
    reviewer.appServerOptions?.webSearch,
    "appServerOptions.webSearch",
  );
}

export function codexWebSearchMode(policy: CodexWebSearchPolicy): CodexWebSearchMode | undefined {
  if (policy === "inherit") {
    return undefined;
  }
  return policy === "enabled" ? "live" : "disabled";
}

export function codexWebSearchMetadata(
  policy: CodexWebSearchPolicy,
): Record<string, CodexWebSearchMode | CodexWebSearchPolicy> {
  const mode = codexWebSearchMode(policy);
  return {
    webSearchPolicy: policy,
    ...(mode !== undefined ? { webSearchMode: mode } : {}),
  };
}

export function codexAppServerReviewMode(reviewer: ReviewReviewerConfig): CodexAppServerReviewMode {
  const value = reviewer.appServerOptions?.reviewMode;
  if (value === undefined) {
    return "structured";
  }
  if (value === "structured" || value === "native") {
    return value;
  }
  throw invalidCli(`Invalid Codex appServerOptions.reviewMode: ${String(value)}`);
}

function parseCodexWebSearchPolicy(value: unknown, optionName: string): CodexWebSearchPolicy {
  if (value === undefined) {
    return "disabled";
  }
  if (value === "enabled" || value === "disabled" || value === "inherit") {
    return value;
  }
  throw invalidCli(`Invalid Codex ${optionName}: ${String(value)}`);
}
