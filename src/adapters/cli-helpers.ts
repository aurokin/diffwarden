import { invalidCli } from "../core/errors.js";
import { getTransportCapability } from "./capabilities.js";
import type { ReviewerTransportCapability } from "./capabilities.js";
import type { CliEngine } from "./cli-types.js";
import type { ReviewReviewerConfig } from "./types.js";

export function cliExecutable(reviewer: ReviewReviewerConfig, fallback: string): string {
  const executable = reviewer.cliOptions?.executable;
  return typeof executable === "string" && executable.trim() ? executable : fallback;
}

export function cliCapability(
  engine: CliEngine,
): ReviewerTransportCapability & { defaultExecutable: string } {
  const capability = getTransportCapability(engine, "cli");
  if (capability === undefined || capability.defaultExecutable === undefined) {
    throw invalidCli(`${engine} CLI transport is not supported`);
  }
  return capability as ReviewerTransportCapability & { defaultExecutable: string };
}

export function defaultCliExecutable(engine: CliEngine): string {
  return cliCapability(engine).defaultExecutable;
}

export function numberCliOption(reviewer: ReviewReviewerConfig, key: string): number | undefined {
  const value = reviewer.cliOptions?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function codexGlobalArgs(reviewer: ReviewReviewerConfig): string[] {
  const args: string[] = [];
  pushModel(args, reviewer);
  if (reviewer.effort !== undefined && reviewer.effort !== "off") {
    args.push("-c", `model_reasoning_effort="${reviewer.effort}"`);
  }
  return args;
}

export function pushModelAndEffort(
  args: string[],
  reviewer: ReviewReviewerConfig,
  mapEffort: (effort: string) => string,
): void {
  pushModel(args, reviewer);
  if (reviewer.effort !== undefined && reviewer.effort !== "off") {
    args.push("--effort", mapEffort(reviewer.effort));
  }
}

export function pushModel(args: string[], reviewer: ReviewReviewerConfig): void {
  const model = providerQualifiedModel(reviewer);
  if (model !== undefined) {
    args.push("--model", model);
  }
}

export function pushPromptArg(args: string[], prompt: string, engine: CliEngine): void {
  const maxBytes = 128 * 1024;
  const byteLength = Buffer.byteLength(prompt, "utf8");
  if (byteLength > maxBytes) {
    throw invalidCli(
      `${engine} CLI transport requires prompt argv input and the assembled review prompt is too large (${byteLength} bytes)`,
    );
  }
  args.push(prompt);
}

export function providerQualifiedModel(reviewer: ReviewReviewerConfig): string | undefined {
  if (reviewer.model === undefined) {
    return undefined;
  }
  if (reviewer.provider === undefined) {
    return reviewer.model;
  }
  return `${reviewer.provider}/${reviewer.model}`;
}

export function claudeCliEffort(effort: string): string {
  if (effort === "minimal") {
    return "low";
  }
  if (effort === "xhigh") {
    return "max";
  }
  return effort;
}

export function grokCliEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}

export function droidCliEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}
