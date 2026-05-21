import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import type {
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewReviewerConfig,
} from "../../src/adapters/types.js";
import { resolveGitTarget } from "../../src/core/git.js";
import { parseReviewOutput } from "../../src/core/parse.js";
import { buildReviewPrompt } from "../../src/core/prompt.js";
import type { ReviewArtifact } from "../../src/core/schema.js";
import { parseTargetSpec } from "../../src/core/target.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sentinelFile = "sentinel-do-not-edit.txt";
const trackedFile = "tracked.txt";
const sentinelText = "do not edit\n";

export type LiveFixture = {
  repo: string;
  cleanup(): void;
};

export type LiveRunResult = {
  stdout: string;
  stderr: string;
};

export function createLiveFixture(prefix = "diffwarden-live-"): LiveFixture {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repo, trackedFile), "initial\n");
  writeFileSync(path.join(repo, sentinelFile), sentinelText);
  git(repo, ["add", trackedFile, sentinelFile]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  writeFileSync(path.join(repo, trackedFile), "changed\n");

  return {
    repo,
    cleanup() {
      rmSync(repo, { force: true, recursive: true });
    },
  };
}

export function liveReviewPrompt(): string {
  return [
    "This is a diffwarden live smoke test.",
    "Review only the provided diff.",
    "Do not modify files.",
    "Return a valid review result.",
    "If there are no issues, return an empty findings array.",
  ].join(" ");
}

export async function createLiveAdapterInput(
  fixture: LiveFixture,
  reviewer: ReviewReviewerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReviewAdapterInput> {
  const resolved = await resolveGitTarget(fixture.repo, parseTargetSpec("uncommitted"));
  return {
    cwd: fixture.repo,
    reviewer,
    target: resolved.target,
    diff: resolved.diff,
    changedFiles: resolved.target.changed_files,
    prompt: buildReviewPrompt(resolved.target, resolved.diff),
    readonly: true,
    env,
  };
}

export function expectLiveAdapterOutput(output: ReviewAdapterOutput): void {
  const parsed =
    output.structured !== undefined
      ? parseReviewOutput({ structured: output.structured })
      : parseReviewOutput({ text: output.text ?? "" });

  expect(parsed.validation.valid_schema).toBe(true);
  expect(parsed.result.findings).toEqual(expect.any(Array));
  expect(["patch is correct", "patch is incorrect"]).toContain(parsed.result.overall_correctness);
  expect(parsed.result.overall_explanation).toEqual(expect.any(String));
  expect(parsed.result.overall_confidence_score).toEqual(expect.any(Number));
}

export function expectLiveArtifact(artifact: ReviewArtifact): void {
  expect(artifact.validation.valid_schema).toBe(true);
  expect(artifact.result.findings).toEqual(expect.any(Array));
  expect(["patch is correct", "patch is incorrect"]).toContain(artifact.result.overall_correctness);
  expect(artifact.result.overall_explanation).toEqual(expect.any(String));
  expect(artifact.result.overall_confidence_score).toEqual(expect.any(Number));
}

export function expectFixtureReadOnly(repo: string): void {
  expect(readFileSync(path.join(repo, sentinelFile), "utf8")).toBe(sentinelText);
  expect(git(repo, ["status", "--short"])).toBe(` M ${trackedFile}`);
}

export async function runBuiltDiffwarden(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveRunResult> {
  const cliPath = path.join(projectRoot, readPackageBinPath());
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function readPackageBinPath(): string {
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const binPath = packageJson.bin?.diffwarden;
  if (typeof binPath !== "string") {
    throw new Error("package.json is missing bin.diffwarden");
  }
  return binPath;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
