import { describe, expect, it } from "vitest";
import { type GitRunner, resolveGitTarget } from "../src/core/git.js";
import { parseTargetSpec } from "../src/core/target.js";

describe("resolveGitTarget with a fake git runner", () => {
  it("resolves uncommitted tracked and untracked changes without launching git", async () => {
    const calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }> = [];
    const git = fakeGit(calls, {
      "/repo/subdir\0rev-parse --show-toplevel": "/repo",
      "/repo\0rev-parse HEAD": "head-sha",
      "/repo\0diff --staged": "",
      "/repo\0diff": "tracked diff",
      "/repo\0ls-files --others --exclude-standard --exclude=.diffwarden/reports/**": "new.txt",
      "/repo\0diff --name-only HEAD": "tracked.txt",
      "/repo\0diff --no-index -- /dev/null /repo/new.txt": "untracked diff",
    });

    const resolved = await resolveGitTarget("/repo/subdir", parseTargetSpec("uncommitted"), {
      runGit: git,
    });

    expect(resolved.target).toMatchObject({
      kind: "uncommitted",
      repo_root: "/repo",
      head_sha: "head-sha",
      changed_files: ["new.txt", "tracked.txt"],
    });
    expect(resolved.diff).toBe("tracked diff\nuntracked diff");
    expect(calls).toContainEqual({
      cwd: "/repo",
      args: ["diff", "--no-index", "--", "/dev/null", "/repo/new.txt"],
      allowedExitCodes: [0, 1],
    });
    expect(resolved.target.diff_command).toContain("--exclude='.diffwarden/reports/**'");
  });

  it("resolves base branch changes from the merge base", async () => {
    const calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }> = [];
    const git = fakeGit(calls, {
      "/repo\0rev-parse --show-toplevel": "/repo",
      "/repo\0rev-parse HEAD": "head-sha",
      "/repo\0merge-base HEAD main": "merge-base-sha",
      "/repo\0diff merge-base-sha HEAD": "feature diff",
      "/repo\0diff --name-only merge-base-sha HEAD": "tracked.txt",
    });

    const resolved = await resolveGitTarget("/repo", parseTargetSpec("base:main"), {
      runGit: git,
    });

    expect(resolved.target).toMatchObject({
      kind: "base",
      repo_root: "/repo",
      base_ref: "main",
      base_sha: "merge-base-sha",
      head_sha: "head-sha",
      diff_command: "git diff merge-base-sha HEAD",
      changed_files: ["tracked.txt"],
    });
    expect(resolved.diff).toBe("feature diff");
    expect(calls).toContainEqual({
      cwd: "/repo",
      args: ["merge-base", "HEAD", "main"],
    });
  });

  it("resolves commit diffs through the first parent", async () => {
    const calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }> = [];
    const git = fakeGit(calls, {
      "/repo\0rev-parse --show-toplevel": "/repo",
      "/repo\0rev-parse HEAD": "head-sha",
      "/repo\0rev-parse feature-sha": "commit-sha",
      "/repo\0rev-list --parents -n 1 commit-sha": "commit-sha parent-sha",
      "/repo\0diff parent-sha commit-sha": "commit diff",
      "/repo\0diff --name-only parent-sha commit-sha": "tracked.txt",
    });

    const resolved = await resolveGitTarget("/repo", parseTargetSpec("commit:feature-sha"), {
      runGit: git,
    });

    expect(resolved.target).toMatchObject({
      kind: "commit",
      repo_root: "/repo",
      commit_sha: "commit-sha",
      diff_command: "git diff parent-sha commit-sha",
      changed_files: ["tracked.txt"],
    });
    expect(resolved.diff).toBe("commit diff");
  });

  it("resolves nested changed files for commit targets", async () => {
    const calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }> = [];
    const git = fakeGit(calls, {
      "/repo\0rev-parse --show-toplevel": "/repo",
      "/repo\0rev-parse HEAD": "head-sha",
      "/repo\0rev-parse feature-sha": "commit-sha",
      "/repo\0rev-list --parents -n 1 commit-sha": "commit-sha parent-sha",
      "/repo\0diff parent-sha commit-sha": "nested diff",
      "/repo\0diff --name-only parent-sha commit-sha": "src/nested/file.txt",
    });

    const resolved = await resolveGitTarget("/repo", parseTargetSpec("commit:feature-sha"), {
      runGit: git,
    });

    expect(resolved.target.changed_files).toEqual(["src/nested/file.txt"]);
    expect(resolved.diff).toBe("nested diff");
  });

  it("resolves merge commit changes against the first parent", async () => {
    const calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }> = [];
    const git = fakeGit(calls, {
      "/repo\0rev-parse --show-toplevel": "/repo",
      "/repo\0rev-parse HEAD": "head-sha",
      "/repo\0rev-parse merge-sha": "merge-commit-sha",
      "/repo\0rev-list --parents -n 1 merge-commit-sha":
        "merge-commit-sha first-parent second-parent",
      "/repo\0diff first-parent merge-commit-sha": "feature diff",
      "/repo\0diff --name-only first-parent merge-commit-sha": "feature.txt",
    });

    const resolved = await resolveGitTarget("/repo", parseTargetSpec("commit:merge-sha"), {
      runGit: git,
    });

    expect(resolved.target).toMatchObject({
      kind: "commit",
      commit_sha: "merge-commit-sha",
      diff_command: "git diff first-parent merge-commit-sha",
      changed_files: ["feature.txt"],
    });
    expect(resolved.diff).toBe("feature diff");
    expect(calls).not.toContainEqual({
      cwd: "/repo",
      args: ["diff", "second-parent", "merge-commit-sha"],
    });
  });

  it("resolves root commit changes with diff-tree", async () => {
    const calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }> = [];
    const git = fakeGit(calls, {
      "/repo\0rev-parse --show-toplevel": "/repo",
      "/repo\0rev-parse HEAD": "head-sha",
      "/repo\0rev-parse root-sha": "root-commit-sha",
      "/repo\0rev-list --parents -n 1 root-commit-sha": "root-commit-sha",
      "/repo\0diff-tree --root --patch --no-commit-id root-commit-sha": "root diff",
      "/repo\0diff-tree --root -r --name-only --no-commit-id root-commit-sha": "tracked.txt",
    });

    const resolved = await resolveGitTarget("/repo", parseTargetSpec("commit:root-sha"), {
      runGit: git,
    });

    expect(resolved.target).toMatchObject({
      kind: "commit",
      commit_sha: "root-commit-sha",
      diff_command: "git diff-tree --root --patch --no-commit-id root-commit-sha",
      changed_files: ["tracked.txt"],
    });
    expect(resolved.diff).toBe("root diff");
  });

  it("resolves custom instructions without collecting a diff", async () => {
    const calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }> = [];
    const git = fakeGit(calls, {
      "/repo/subdir\0rev-parse --show-toplevel": "/repo",
      "/repo\0rev-parse HEAD": "head-sha",
    });

    const resolved = await resolveGitTarget(
      "/repo/subdir",
      parseTargetSpec("custom:Review auth paths"),
      {
        runGit: git,
      },
    );

    expect(resolved.diff).toBe("");
    expect(resolved.target).toMatchObject({
      kind: "custom",
      repo_root: "/repo",
      head_sha: "head-sha",
      instructions: "Review auth paths",
      diff_command: "custom instructions",
      changed_files: [],
    });
    expect(calls).toEqual([
      { cwd: "/repo/subdir", args: ["rev-parse", "--show-toplevel"] },
      { cwd: "/repo", args: ["rev-parse", "HEAD"] },
    ]);
  });
});

function fakeGit(
  calls: Array<{ cwd: string; args: string[]; allowedExitCodes?: number[] }>,
  responses: Record<string, string>,
): GitRunner {
  return async (cwd, args, allowedExitCodes) => {
    calls.push({ cwd, args, ...(allowedExitCodes !== undefined ? { allowedExitCodes } : {}) });
    const key = `${cwd}\0${args.join(" ")}`;
    const response = responses[key];
    if (response === undefined) {
      throw new Error(`Unexpected git call: ${key}`);
    }
    return response;
  };
}
