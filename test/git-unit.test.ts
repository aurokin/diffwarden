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
