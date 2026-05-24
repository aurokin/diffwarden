import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { invalidCli } from "./errors.js";
import type { ReviewTargetResolved } from "./schema.js";
import type { ReviewTargetSpec } from "./target.js";

const execFileAsync = promisify(execFile);
const repoLocalReportExclude = ".diffwarden/reports/**";

export type ResolvedDiff = {
  target: ReviewTargetResolved;
  diff: string;
};

export async function resolveGitTarget(cwd: string, spec: ReviewTargetSpec): Promise<ResolvedDiff> {
  const repoRoot = await getRepoRoot(cwd);
  const headSha = await runGit(repoRoot, ["rev-parse", "HEAD"]);

  if (spec.kind === "uncommitted") {
    return resolveUncommittedTarget(repoRoot, headSha);
  }

  if (spec.kind === "base") {
    return resolveBaseTarget(repoRoot, spec.branch, headSha);
  }

  if (spec.kind === "custom") {
    return resolveCustomTarget(repoRoot, headSha, spec.instructions);
  }

  return resolveCommitTarget(repoRoot, spec.sha);
}

async function resolveUncommittedTarget(repoRoot: string, headSha: string): Promise<ResolvedDiff> {
  const [stagedDiff, unstagedDiff, untrackedText, changedText] = await Promise.all([
    runGit(repoRoot, ["diff", "--staged"]),
    runGit(repoRoot, ["diff"]),
    runGit(repoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      `--exclude=${repoLocalReportExclude}`,
    ]),
    runGit(repoRoot, ["diff", "--name-only", "HEAD"]),
  ]);
  const untrackedFiles = lines(untrackedText);
  const untrackedDiffs = await Promise.all(
    untrackedFiles.map((file) => diffUntrackedFile(repoRoot, file)),
  );
  const changedFiles = uniqueSorted([...lines(changedText), ...untrackedFiles]);
  const diff = [stagedDiff, unstagedDiff, ...untrackedDiffs].filter(Boolean).join("\n");

  return {
    diff,
    target: {
      kind: "uncommitted",
      repo_root: repoRoot,
      head_sha: headSha,
      diff_command: `git diff --staged && git diff && git ls-files --others --exclude-standard --exclude=${repoLocalReportExclude}`,
      changed_files: changedFiles,
    },
  };
}

async function resolveBaseTarget(
  repoRoot: string,
  branch: string,
  headSha: string,
): Promise<ResolvedDiff> {
  const mergeBase = await runGit(repoRoot, ["merge-base", "HEAD", branch]);
  const [diff, changedText] = await Promise.all([
    runGit(repoRoot, ["diff", mergeBase, "HEAD"]),
    runGit(repoRoot, ["diff", "--name-only", mergeBase, "HEAD"]),
  ]);

  return {
    diff,
    target: {
      kind: "base",
      repo_root: repoRoot,
      base_ref: branch,
      base_sha: mergeBase,
      head_sha: headSha,
      diff_command: `git diff ${mergeBase} HEAD`,
      changed_files: lines(changedText),
    },
  };
}

async function resolveCommitTarget(repoRoot: string, sha: string): Promise<ResolvedDiff> {
  const commitSha = await runGit(repoRoot, ["rev-parse", sha]);
  const [firstParent] = await commitParents(repoRoot, commitSha);
  const [diff, changedText] =
    firstParent === undefined
      ? await Promise.all([
          runGit(repoRoot, ["diff-tree", "--root", "--patch", "--no-commit-id", commitSha]),
          runGit(repoRoot, [
            "diff-tree",
            "--root",
            "-r",
            "--name-only",
            "--no-commit-id",
            commitSha,
          ]),
        ])
      : await Promise.all([
          runGit(repoRoot, ["diff", firstParent, commitSha]),
          runGit(repoRoot, ["diff", "--name-only", firstParent, commitSha]),
        ]);

  return {
    diff,
    target: {
      kind: "commit",
      repo_root: repoRoot,
      commit_sha: commitSha,
      diff_command:
        firstParent === undefined
          ? `git diff-tree --root --patch --no-commit-id ${commitSha}`
          : `git diff ${firstParent} ${commitSha}`,
      changed_files: lines(changedText),
    },
  };
}

function resolveCustomTarget(
  repoRoot: string,
  headSha: string,
  instructions: string,
): ResolvedDiff {
  return {
    diff: "",
    target: {
      kind: "custom",
      repo_root: repoRoot,
      head_sha: headSha,
      instructions,
      diff_command: "custom instructions",
      changed_files: [],
    },
  };
}

async function commitParents(repoRoot: string, commitSha: string): Promise<string[]> {
  const parentLine = await runGit(repoRoot, ["rev-list", "--parents", "-n", "1", commitSha]);
  const [_commit, ...parents] = parentLine.split(/\s+/).filter(Boolean);
  return parents;
}

async function getRepoRoot(cwd: string): Promise<string> {
  try {
    return await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw invalidCli(`Not a git repository: ${cwd}`);
  }
}

async function diffUntrackedFile(repoRoot: string, file: string): Promise<string> {
  return runGit(
    repoRoot,
    ["diff", "--no-index", "--", "/dev/null", path.join(repoRoot, file)],
    [0, 1],
  );
}

async function runGit(cwd: string, args: string[], allowedExitCodes = [0]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (error) {
    if (isExecError(error) && allowedExitCodes.includes(error.code)) {
      return error.stdout.trimEnd();
    }

    if (isExecError(error)) {
      throw invalidCli(error.stderr.trim() || `git ${args.join(" ")} failed`);
    }

    throw error;
  }
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isExecError(error: unknown): error is { code: number; stdout: string; stderr: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "stdout" in error &&
    "stderr" in error &&
    typeof error.code === "number" &&
    typeof error.stdout === "string" &&
    typeof error.stderr === "string"
  );
}
