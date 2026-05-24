import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitTarget } from "../src/core/git.js";
import { parseTargetSpec } from "../src/core/target.js";

let repos: string[] = [];

afterEach(() => {
  for (const repo of repos) {
    rmSync(repo, { force: true, recursive: true });
  }
  repos = [];
});

describe("resolveGitTarget", () => {
  it("resolves uncommitted tracked and untracked changes", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(path.join(repo, "new.txt"), "new\n");

    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    expect(resolved.target.kind).toBe("uncommitted");
    expect(resolved.target.changed_files).toEqual(["new.txt", "tracked.txt"]);
    expect(resolved.diff).toContain("tracked.txt");
    expect(resolved.diff).toContain("new.txt");
  });

  it("excludes repo-local report history from uncommitted changes", async () => {
    const repo = createRepo();
    mkdirSync(path.join(repo, ".diffwarden", "reports", "2026", "05", "24"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, ".diffwarden", "reports", "2026", "05", "24", "report.json"),
      "{}\n",
    );
    writeFileSync(path.join(repo, "new.txt"), "new\n");

    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    expect(resolved.target.changed_files).toEqual(["new.txt"]);
    expect(resolved.diff).toContain("new.txt");
    expect(resolved.diff).not.toContain(".diffwarden/reports");
  });

  it("resolves base branch changes", async () => {
    const repo = createRepo();
    git(repo, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(repo, "tracked.txt"), "feature\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "feature"]);

    const resolved = await resolveGitTarget(repo, parseTargetSpec("base:main"));

    expect(resolved.target.kind).toBe("base");
    expect(resolved.target.base_ref).toBe("main");
    expect(resolved.target.changed_files).toEqual(["tracked.txt"]);
    expect(resolved.diff).toContain("feature");
  });

  it("excludes unrelated worktree changes from base branch targets", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "worktree.txt"), "base\n");
    git(repo, ["add", "worktree.txt"]);
    git(repo, ["commit", "-m", "add worktree file"]);
    git(repo, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(repo, "tracked.txt"), "feature\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "feature"]);
    writeFileSync(path.join(repo, "worktree.txt"), "uncommitted\n");

    const resolved = await resolveGitTarget(repo, parseTargetSpec("base:main"));

    expect(resolved.target.changed_files).toEqual(["tracked.txt"]);
    expect(resolved.diff).toContain("feature");
    expect(resolved.diff).not.toContain("uncommitted");
  });

  it("resolves commit changes", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "commit\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "change"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);

    const resolved = await resolveGitTarget(repo, parseTargetSpec(`commit:${sha}`));

    expect(resolved.target.kind).toBe("commit");
    expect(resolved.target.commit_sha).toBe(sha);
    expect(resolved.target.changed_files).toEqual(["tracked.txt"]);
    expect(resolved.diff).toContain("commit");
  });

  it("resolves nested changed files for commit targets", async () => {
    const repo = createRepo();
    mkdirSync(path.join(repo, "src", "nested"), { recursive: true });
    writeFileSync(path.join(repo, "src", "nested", "file.txt"), "nested\n");
    git(repo, ["add", "src/nested/file.txt"]);
    git(repo, ["commit", "-m", "nested"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);

    const resolved = await resolveGitTarget(repo, parseTargetSpec(`commit:${sha}`));

    expect(resolved.target.changed_files).toEqual(["src/nested/file.txt"]);
    expect(resolved.diff).toContain("src/nested/file.txt");
  });

  it("resolves merge commit changes against the first parent", async () => {
    const repo = createRepo();
    git(repo, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(repo, "feature.txt"), "feature\n");
    git(repo, ["add", "feature.txt"]);
    git(repo, ["commit", "-m", "feature"]);
    git(repo, ["checkout", "main"]);
    writeFileSync(path.join(repo, "main.txt"), "main\n");
    git(repo, ["add", "main.txt"]);
    git(repo, ["commit", "-m", "main"]);
    git(repo, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
    const mergeSha = git(repo, ["rev-parse", "HEAD"]);

    const resolved = await resolveGitTarget(repo, parseTargetSpec(`commit:${mergeSha}`));

    expect(resolved.target.changed_files).toEqual(["feature.txt"]);
    expect(resolved.diff).toContain("feature.txt");
    expect(resolved.diff).not.toContain("main.txt");
  });

  it("resolves root commit changes", async () => {
    const repo = createRepo();
    const rootSha = git(repo, ["rev-list", "--max-parents=0", "HEAD"]);

    const resolved = await resolveGitTarget(repo, parseTargetSpec(`commit:${rootSha}`));

    expect(resolved.target.kind).toBe("commit");
    expect(resolved.target.commit_sha).toBe(rootSha);
    expect(resolved.target.changed_files).toEqual(["tracked.txt"]);
    expect(resolved.diff).toContain("initial");
  });

  it("resolves custom instructions without a diff", async () => {
    const repo = createRepo();

    const resolved = await resolveGitTarget(repo, parseTargetSpec("custom:Review auth paths"));

    expect(resolved.diff).toBe("");
    expect(resolved.target).toMatchObject({
      kind: "custom",
      repo_root: realpathSync(repo),
      head_sha: git(repo, ["rev-parse", "HEAD"]),
      instructions: "Review auth paths",
      changed_files: [],
    });
  });
});

function createRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "diffwarden-"));
  repos.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
