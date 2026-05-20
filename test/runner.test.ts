import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewAdapter } from "../src/adapters/types.js";
import { resolveGitTarget } from "../src/core/git.js";
import { runReview } from "../src/core/runner.js";
import { reviewArtifactSchema } from "../src/core/schema.js";
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
    expect(() => reviewArtifactSchema.parse(artifact)).not.toThrow();
    expect(artifact.reviewers?.[0]?.preflight?.metadata?.readonlyCapability).toBe("enforced");
    expect(artifact.reviewers?.[0]?.adapter_metadata?.captureMode).toBe("native-structured");
    expect(artifact.validation.valid_schema).toBe(true);
    expect(artifact.result.overall_correctness).toBe("patch is correct");
  });

  it("runs the Pi reviewer through the adapter registry", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createMockAdapter("pi");

    const artifact = await runReview({
      cwd: repo,
      resolved,
      reviewer: "pi",
      model: "anthropic/claude-sonnet-4-5",
      adapters: {
        pi: piAdapter,
      },
    });

    expect(artifact.sdk).toBe("pi");
    expect(artifact.reviewers?.[0]?.sdk).toBe("pi");
    expect(artifact.reviewers?.[0]?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(artifact.reviewers?.[0]?.preflight?.metadata?.readonlyCapability).toBe(
      "tool-restricted",
    );
    expect(artifact.reviewers?.[0]?.adapter_metadata?.captureMode).toBe("tool-call");
    expect(piAdapter.calls).toEqual([
      {
        phase: "preflight",
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
          model: "anthropic/claude-sonnet-4-5",
        },
      },
      {
        phase: "run",
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
          model: "anthropic/claude-sonnet-4-5",
        },
      },
    ]);
  });

  it("rejects reviewer profiles before adapter execution", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createMockAdapter("pi");

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi:openrouter-high",
        adapters: {
          pi: piAdapter,
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_cli",
      exitCode: 2,
    });
    expect(piAdapter.calls).toEqual([]);
  });

  it("runs configured reviewer profiles through the matching adapter", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createMockAdapter("pi");

    const artifact = await runReview({
      cwd: repo,
      resolved,
      reviewer: "pi:openrouter-high",
      config: {
        reviewers: [
          {
            id: "pi-openrouter-high",
            sdk: "pi",
            profile: "openrouter-high",
            provider: "openrouter",
            model: "anthropic/claude-sonnet",
          },
        ],
      },
      adapters: {
        pi: piAdapter,
      },
    });

    expect(artifact.reviewers?.[0]).toMatchObject({
      id: "pi-openrouter-high",
      sdk: "pi",
      profile: "openrouter-high",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
    });
    expect(piAdapter.calls[0]?.reviewer).toMatchObject({
      id: "pi-openrouter-high",
      sdk: "pi",
      profile: "openrouter-high",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      readonly: true,
    });
  });

  it("rejects effort before adapter execution", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createMockAdapter("pi");

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        effort: "high",
        adapters: {
          pi: piAdapter,
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_cli",
      exitCode: 2,
    });
    expect(piAdapter.calls).toEqual([]);
  });

  it("fails Pi reviews clearly when no auth is available", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });
});

function createMockAdapter(name: "pi"): ReviewAdapter & {
  calls: Array<{ phase: "preflight" | "run"; reviewer: unknown }>;
} {
  const calls: Array<{ phase: "preflight" | "run"; reviewer: unknown }> = [];

  return {
    name,
    calls,
    async preflight(input) {
      calls.push({ phase: "preflight", reviewer: input.reviewer });
      return {
        checks: [{ name: "mock", status: "passed" }],
        metadata: {
          readonlyCapability: "tool-restricted",
        },
      };
    },
    async run(input) {
      calls.push({ phase: "run", reviewer: input.reviewer });
      return {
        structured: {
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation: "Mock Pi review passed.",
          overall_confidence_score: 0.9,
        },
        metadata: {
          captureMode: "tool-call",
        },
      };
    },
  };
}

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
