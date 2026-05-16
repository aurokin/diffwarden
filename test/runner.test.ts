import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitTarget } from "../src/core/git.js";
import { runReview } from "../src/core/runner.js";
import { parseTargetSpec } from "../src/core/target.js";

let repo: string | undefined;

afterEach(() => {
  if (repo) {
    rmSync(repo, { force: true, recursive: true });
    repo = undefined;
  }
});

describe("runReview", () => {
  it("runs the fake reviewer and returns an artifact", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    const artifact = await runReview({
      cwd: repo,
      resolved,
      reviewer: "fake",
    });

    expect(artifact.sdk).toBe("fake");
    expect(artifact.schema_version).toBe(1);
    expect(artifact.validation.valid_schema).toBe(true);
    expect(artifact.result.overall_correctness).toBe("patch is correct");
  });
});

function createRepo(): string {
  const newRepo = mkdtempSync(path.join(tmpdir(), "diffwarden-"));
  git(newRepo, ["init", "-b", "main"]);
  git(newRepo, ["config", "user.email", "test@example.com"]);
  git(newRepo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(newRepo, "tracked.txt"), "initial\n");
  git(newRepo, ["add", "tracked.txt"]);
  git(newRepo, ["commit", "-m", "initial"]);
  return newRepo;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
