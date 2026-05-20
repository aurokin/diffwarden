import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewAdapter } from "../src/adapters/types.js";
import { resolveGitTarget } from "../src/core/git.js";
import { runReview } from "../src/core/runner.js";
import { reviewArtifactSchema } from "../src/core/schema.js";
import { parseTargetSpec } from "../src/core/target.js";

let repo: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
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

  it("runs multiple reviewers and aggregates their artifacts", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createMockAdapter("pi");
    const claudeAdapter = createMockAdapter("claude");

    const artifact = await runReview({
      cwd: repo,
      resolved,
      reviewers: ["pi", "claude"],
      adapters: {
        pi: piAdapter,
        claude: claudeAdapter,
      },
    });

    expect(artifact.sdk).toBeUndefined();
    expect(artifact.reviewers).toHaveLength(2);
    expect(artifact.reviewers?.map((reviewer) => reviewer.sdk)).toEqual(["pi", "claude"]);
    expect(artifact.result.overall_correctness).toBe("patch is correct");
    expect(artifact.result.overall_explanation).toContain("pi: Mock pi review passed.");
    expect(artifact.result.overall_explanation).toContain("claude: Mock claude review passed.");
    expect(piAdapter.calls).toHaveLength(2);
    expect(claudeAdapter.calls).toHaveLength(2);
  });

  it("preflights every selected reviewer before running any reviewer", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const events: string[] = [];
    const piAdapter = createMockAdapter("pi", events);
    const claudeAdapter = createMockAdapter("claude", events);

    await runReview({
      cwd: repo,
      resolved,
      reviewers: ["pi", "claude"],
      adapters: {
        pi: piAdapter,
        claude: claudeAdapter,
      },
    });

    expect(events).toEqual(["pi:preflight", "claude:preflight", "pi:run", "claude:run"]);
  });

  it("preserves unknown verdicts when aggregating reviewers", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    const artifact = await runReview({
      cwd: repo,
      resolved,
      reviewers: ["pi", "claude"],
      adapters: {
        pi: createMockAdapter("pi"),
        claude: createMockAdapter("claude", undefined, {
          overall_correctness: "unknown",
          overall_explanation: "Claude returned unstructured text.",
        }),
      },
    });

    expect(artifact.result.overall_correctness).toBe("unknown");
  });

  it("returns partial multi-reviewer results when one reviewer fails", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    const artifact = await runReview({
      cwd: repo,
      resolved,
      reviewers: ["pi", "claude"],
      adapters: {
        pi: createMockAdapter("pi"),
        claude: createFailingRunAdapter("claude", "Claude exploded"),
      },
    });

    expect(() => reviewArtifactSchema.parse(artifact)).not.toThrow();
    expect(artifact.reviewers).toHaveLength(2);
    expect(artifact.reviewers?.[0]).toMatchObject({ id: "pi", status: "success" });
    expect(artifact.reviewers?.[1]).toMatchObject({
      id: "claude",
      status: "failed",
      error: {
        code: "reviewer_failed",
        message: "Claude exploded",
      },
    });
    expect(artifact.warnings).toEqual(["Reviewer claude failed: Claude exploded"]);
    expect(artifact.result.overall_explanation).toContain("pi: Mock pi review passed.");
  });

  it("fails partial multi-reviewer runs in strict mode", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewers: ["pi", "claude"],
        strict: true,
        adapters: {
          pi: createMockAdapter("pi"),
          claude: createFailingRunAdapter("claude", "Claude exploded"),
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      exitCode: 3,
      message: expect.stringContaining("strict mode"),
    });
  });

  it("fails fallback reviewer output in strict mode", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        strict: true,
        adapters: {
          pi: createTextAdapter("pi", "not json"),
        },
      }),
    ).rejects.toMatchObject({
      code: "parse_failed",
      exitCode: 4,
    });
  });

  it("fails invalid reviewer finding locations in strict mode", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        strict: true,
        adapters: {
          pi: createMockAdapter("pi", undefined, {
            findingFilePath: "/repo/not-changed.ts",
          }),
        },
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      exitCode: 4,
    });
  });

  it("preserves single-reviewer failure codes in strict mode", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        strict: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("fails multi-reviewer runs when every reviewer fails", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewers: ["pi", "claude"],
        adapters: {
          pi: createFailingRunAdapter("pi", "Pi exploded"),
          claude: createFailingRunAdapter("claude", "Claude exploded"),
        },
      }),
    ).rejects.toMatchObject({
      code: "reviewer_failed",
      exitCode: 3,
      message: expect.stringContaining("All reviewers failed"),
    });
  });

  it("expands reviewer sets from config", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createMockAdapter("pi");
    const claudeAdapter = createMockAdapter("claude");

    const artifact = await runReview({
      cwd: repo,
      resolved,
      reviewerSet: "2",
      config: {
        reviewerSets: {
          "2": ["pi:openrouter-high", "claude-deep"],
        },
        reviewers: [
          { id: "pi-openrouter-high", sdk: "pi", profile: "openrouter-high" },
          { id: "claude-deep", sdk: "claude", model: "sonnet" },
        ],
      },
      adapters: {
        pi: piAdapter,
        claude: claudeAdapter,
      },
    });

    expect(artifact.reviewers?.map((reviewer) => reviewer.id)).toEqual([
      "pi-openrouter-high",
      "claude-deep",
    ]);
  });

  it("rejects model overrides for multiple reviewers", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewers: ["pi", "claude"],
        model: "sonnet",
      }),
    ).rejects.toMatchObject({
      code: "invalid_cli",
      exitCode: 2,
    });
  });

  it("times out slow reviewer runs", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createHangingRunAdapter("pi");
    vi.spyOn(Date, "now").mockReturnValue(0);

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        timeoutSeconds: 0.001,
        adapters: {
          pi: piAdapter,
        },
      }),
    ).rejects.toMatchObject(timeoutMatch());
    expect(piAdapter.runSignals[0]?.aborted).toBe(true);
  });

  it("times out slow reviewer preflights before running adapters", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createHangingPreflightAdapter("pi");

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        timeoutSeconds: 0.001,
        adapters: {
          pi: piAdapter,
        },
      }),
    ).rejects.toMatchObject(timeoutMatch());
    expect(piAdapter.calls).toEqual([{ phase: "preflight", reviewer: expect.anything() }]);
    expect(piAdapter.preflightSignals[0]?.aborted).toBe(true);
  });

  it("reports timeout errors even when adapters reject synchronously on abort", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));

    await expect(
      runReview({
        cwd: repo,
        resolved,
        reviewer: "pi",
        timeoutSeconds: 0.001,
        adapters: {
          pi: createAbortRejectingRunAdapter("pi"),
        },
      }),
    ).rejects.toMatchObject(timeoutMatch());
  });

  it("passes only the remaining timeout budget to reviewer runs after preflight", async () => {
    repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const resolved = await resolveGitTarget(repo, parseTargetSpec("uncommitted"));
    const piAdapter = createTimeoutCaptureAdapter("pi");
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_250)
      .mockReturnValue(1_250);

    await runReview({
      cwd: repo,
      resolved,
      reviewer: "pi",
      timeoutSeconds: 1,
      adapters: {
        pi: piAdapter,
      },
    });

    expect(piAdapter.runTimeouts).toEqual([750]);
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

function createMockAdapter(
  name: ReviewAdapter["name"],
  events?: string[],
  resultOverrides?: {
    overall_correctness?: "patch is correct" | "patch is incorrect" | "unknown";
    overall_explanation?: string;
    findingFilePath?: string;
  },
): ReviewAdapter & {
  calls: Array<{ phase: "preflight" | "run"; reviewer: unknown }>;
} {
  const calls: Array<{ phase: "preflight" | "run"; reviewer: unknown }> = [];

  return {
    name,
    calls,
    async preflight(input) {
      events?.push(`${name}:preflight`);
      calls.push({ phase: "preflight", reviewer: input.reviewer });
      return {
        checks: [{ name: "mock", status: "passed" }],
        metadata: {
          readonlyCapability: "tool-restricted",
        },
      };
    },
    async run(input) {
      events?.push(`${name}:run`);
      calls.push({ phase: "run", reviewer: input.reviewer });
      return {
        structured: {
          findings:
            resultOverrides?.findingFilePath === undefined
              ? []
              : [
                  {
                    title: "[P2] Invalid location",
                    body: "Finding body.",
                    confidence_score: 0.8,
                    priority: 2,
                    code_location: {
                      absolute_file_path: resultOverrides.findingFilePath,
                      line_range: {
                        start: 1,
                        end: 1,
                      },
                    },
                  },
                ],
          overall_correctness: resultOverrides?.overall_correctness ?? "patch is correct",
          overall_explanation:
            resultOverrides?.overall_explanation ?? `Mock ${name} review passed.`,
          overall_confidence_score: 0.9,
        },
        metadata: {
          captureMode: "tool-call",
        },
      };
    },
  };
}

function createHangingRunAdapter(name: ReviewAdapter["name"]): ReviewAdapter & {
  runSignals: AbortSignal[];
} {
  const runSignals: AbortSignal[] = [];
  return {
    name,
    runSignals,
    async preflight() {
      return {
        checks: [{ name: "mock", status: "passed" }],
      };
    },
    async run(input) {
      if (input.signal !== undefined) {
        runSignals.push(input.signal);
      }
      return waitForAbort(input.signal);
    },
  };
}

function createHangingPreflightAdapter(name: ReviewAdapter["name"]): ReviewAdapter & {
  calls: Array<{ phase: "preflight"; reviewer: unknown }>;
  preflightSignals: AbortSignal[];
} {
  const calls: Array<{ phase: "preflight"; reviewer: unknown }> = [];
  const preflightSignals: AbortSignal[] = [];
  return {
    name,
    calls,
    preflightSignals,
    async preflight(input) {
      calls.push({ phase: "preflight", reviewer: input.reviewer });
      if (input.signal !== undefined) {
        preflightSignals.push(input.signal);
      }
      return waitForAbort(input.signal);
    },
    async run() {
      throw new Error("run should not be called");
    },
  };
}

function createAbortRejectingRunAdapter(name: ReviewAdapter["name"]): ReviewAdapter {
  return {
    name,
    async preflight() {
      return {
        checks: [{ name: "mock", status: "passed" }],
      };
    },
    async run(input) {
      return new Promise((_, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("adapter aborted")), {
          once: true,
        });
      });
    },
  };
}

function createFailingRunAdapter(name: ReviewAdapter["name"], message: string): ReviewAdapter {
  return {
    name,
    async preflight() {
      return {
        checks: [{ name: "mock", status: "passed" }],
      };
    },
    async run() {
      throw new Error(message);
    },
  };
}

function createTextAdapter(name: ReviewAdapter["name"], text: string): ReviewAdapter {
  return {
    name,
    async preflight() {
      return {
        checks: [{ name: "mock", status: "passed" }],
      };
    },
    async run() {
      return { text };
    },
  };
}

function createTimeoutCaptureAdapter(name: ReviewAdapter["name"]): ReviewAdapter & {
  runTimeouts: Array<number | undefined>;
} {
  const runTimeouts: Array<number | undefined> = [];
  return {
    name,
    runTimeouts,
    async preflight() {
      return {
        checks: [{ name: "mock", status: "passed" }],
      };
    },
    async run(input) {
      runTimeouts.push(input.timeoutMs);
      return {
        structured: {
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation: `Mock ${name} review passed.`,
          overall_confidence_score: 0.9,
        },
      };
    },
  };
}

function waitForAbort<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise((_, reject) => {
    const rejectWithAbortReason = (): void => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) {
      rejectWithAbortReason();
      return;
    }
    signal?.addEventListener("abort", rejectWithAbortReason, { once: true });
  });
}

function timeoutMatch(): { code: "timeout"; exitCode: 3 } {
  return {
    code: "timeout",
    exitCode: 3,
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
