import { describe, expect, it } from "vitest";
import type { ReviewAdapter } from "../src/adapters/types.js";
import type { ResolvedDiff } from "../src/core/git.js";
import { runReviewEvents } from "../src/core/runner.js";
import { type ReviewArtifact, type ReviewEvent, reviewArtifactSchema } from "../src/core/schema.js";

describe("runReviewEvents", () => {
  it("streams lifecycle events and a final aggregate that matches the return value", async () => {
    const { cwd, resolved } = await uncommittedTarget();

    const { events, returnValue } = await collect(
      runReviewEvents({
        cwd,
        resolved,
        reviewers: ["pi", "claude"],
        adapters: {
          pi: createSuccessAdapter("pi"),
          claude: createSuccessAdapter("claude"),
        },
      }),
    );

    expect(types(events)[0]).toBe("run_started");
    expect(last(events).type).toBe("final_result");
    expectTerminalFrameGuarantee(events);

    // All preflight_started precede any preflight_finished.
    expect(indexOfType(events, "preflight_finished")).toBeGreaterThan(
      lastIndexOfType(events, "preflight_started"),
    );
    // All reviewers start before any reviewer result is emitted.
    expect(indexOfType(events, "reviewer_result")).toBeGreaterThan(
      lastIndexOfType(events, "reviewer_started"),
    );

    const finalEvent = last(events);
    if (finalEvent.type !== "final_result") {
      throw new Error("expected final_result");
    }
    expect(finalEvent.artifact).toBe(returnValue);
    expect(() => reviewArtifactSchema.parse(finalEvent.artifact)).not.toThrow();
    expect(finalEvent.artifact.reviewers?.map((reviewer) => reviewer.id)).toEqual(["pi", "claude"]);
  });

  it("marks per-reviewer results provisional", async () => {
    const { cwd, resolved } = await uncommittedTarget();

    const { events } = await collect(
      runReviewEvents({
        cwd,
        resolved,
        reviewer: "pi",
        adapters: { pi: createSuccessAdapter("pi") },
      }),
    );

    const result = events.find((event) => event.type === "reviewer_result");
    expect(result).toBeDefined();
    if (result?.type === "reviewer_result") {
      expect(result.provisional).toBe(true);
      expect(result.reviewer_id).toBe("pi");
    }
  });

  it("emits reviewer results in completion order while preserving aggregation order", async () => {
    const { cwd, resolved } = await uncommittedTarget();

    // pi is selected first but finishes last; claude finishes first.
    const { events, returnValue } = await collect(
      runReviewEvents({
        cwd,
        resolved,
        reviewers: ["pi", "claude"],
        adapters: {
          pi: createSuccessAdapter("pi", { runDelayMs: 40 }),
          claude: createSuccessAdapter("claude", { runDelayMs: 0 }),
        },
      }),
    );

    const resultOrder = events
      .filter((event) => event.type === "reviewer_result")
      .map((event) => (event.type === "reviewer_result" ? event.reviewer_id : ""));
    expect(resultOrder).toEqual(["claude", "pi"]);
    // Aggregation order follows selection order, not completion order.
    expect(returnValue?.reviewers?.map((reviewer) => reviewer.id)).toEqual(["pi", "claude"]);
  });

  it("streams a partial final result when one reviewer fails at run time", async () => {
    const { cwd, resolved } = await uncommittedTarget();

    const { events, returnValue } = await collect(
      runReviewEvents({
        cwd,
        resolved,
        reviewers: ["pi", "claude"],
        adapters: {
          pi: createSuccessAdapter("pi"),
          claude: createFailingRunAdapter("claude", "Claude exploded"),
        },
      }),
    );

    expectTerminalFrameGuarantee(events);
    expect(last(events).type).toBe("final_result");
    const failed = events.find((event) => event.type === "reviewer_failed");
    expect(failed?.type === "reviewer_failed" && failed.reviewer_id).toBe("claude");
    expect(failed?.type === "reviewer_failed" && failed.error.message).toBe("Claude exploded");
    expect(returnValue?.warnings).toEqual(["Reviewer claude failed: Claude exploded"]);
  });

  it("emits a terminal error event when every reviewer fails", async () => {
    const { cwd, resolved } = await uncommittedTarget();

    const { events, returnValue } = await collect(
      runReviewEvents({
        cwd,
        resolved,
        reviewers: ["pi", "claude"],
        adapters: {
          pi: createFailingRunAdapter("pi", "Pi exploded"),
          claude: createFailingRunAdapter("claude", "Claude exploded"),
        },
      }),
    );

    expectTerminalFrameGuarantee(events);
    expect(returnValue).toBeUndefined();
    const terminal = last(events);
    expect(terminal.type).toBe("error");
    if (terminal.type === "error") {
      expect(terminal.error.code).toBe("reviewer_failed");
      expect(terminal.error.exit_code).toBe(3);
      expect(terminal.error.message).toContain("All reviewers failed");
    }
  });

  it("emits a terminal error event under strict mode when any reviewer fails", async () => {
    const { cwd, resolved } = await uncommittedTarget();

    const { events, returnValue } = await collect(
      runReviewEvents({
        cwd,
        resolved,
        reviewers: ["pi", "claude"],
        strict: true,
        adapters: {
          pi: createSuccessAdapter("pi"),
          claude: createFailingRunAdapter("claude", "Claude exploded"),
        },
      }),
    );

    expectTerminalFrameGuarantee(events);
    expect(returnValue).toBeUndefined();
    expect(events.some((event) => event.type === "final_result")).toBe(false);
    const terminal = last(events);
    expect(terminal.type).toBe("error");
    if (terminal.type === "error") {
      expect(terminal.error.code).toBe("reviewer_failed");
      expect(terminal.error.exit_code).toBe(3);
      expect(terminal.error.message).toContain("strict mode");
    }
  });

  it("reports preflight failures without starting that reviewer's run", async () => {
    const { cwd, resolved } = await uncommittedTarget();

    const { events, returnValue } = await collect(
      runReviewEvents({
        cwd,
        resolved,
        reviewers: ["pi", "claude"],
        adapters: {
          pi: createFailingPreflightAdapter("pi", "Pi preflight exploded"),
          claude: createSuccessAdapter("claude"),
        },
      }),
    );

    const piPreflight = events.find(
      (event) => event.type === "preflight_finished" && event.reviewer_id === "pi",
    );
    expect(piPreflight?.type === "preflight_finished" && piPreflight.ok).toBe(false);

    // pi never starts a run; claude does.
    const started = events
      .filter((event) => event.type === "reviewer_started")
      .map((event) => (event.type === "reviewer_started" ? event.reviewer_id : ""));
    expect(started).toEqual(["claude"]);

    // The run still completes with a partial result.
    expect(last(events).type).toBe("final_result");
    expect(returnValue?.warnings).toEqual(["Reviewer pi failed: Pi preflight exploded"]);
  });
});

async function uncommittedTarget(): Promise<{
  cwd: string;
  resolved: ResolvedDiff;
}> {
  const cwd = "/repo";
  return {
    cwd,
    resolved: {
      diff: [
        "diff --git a/tracked.txt b/tracked.txt",
        "index e79c5e8..2d95f3b 100644",
        "--- a/tracked.txt",
        "+++ b/tracked.txt",
        "@@ -1 +1 @@",
        "-initial",
        "+changed",
      ].join("\n"),
      target: {
        kind: "uncommitted",
        repo_root: cwd,
        head_sha: "head-sha",
        diff_command: "git diff --staged && git diff",
        changed_files: ["tracked.txt"],
      },
    },
  };
}

async function collect(
  stream: ReturnType<typeof runReviewEvents>,
): Promise<{ events: ReviewEvent[]; returnValue: ReviewArtifact | undefined }> {
  const events: ReviewEvent[] = [];
  let next = await stream.next();
  while (next.done !== true) {
    events.push(next.value);
    next = await stream.next();
  }
  return { events, returnValue: next.value };
}

function types(events: ReviewEvent[]): string[] {
  return events.map((event) => event.type);
}

function last(events: ReviewEvent[]): ReviewEvent {
  const value = events.at(-1);
  if (value === undefined) {
    throw new Error("no events emitted");
  }
  return value;
}

function indexOfType(events: ReviewEvent[], type: ReviewEvent["type"]): number {
  return events.findIndex((event) => event.type === type);
}

function lastIndexOfType(events: ReviewEvent[], type: ReviewEvent["type"]): number {
  return events.map((event) => event.type).lastIndexOf(type);
}

function expectTerminalFrameGuarantee(events: ReviewEvent[]): void {
  const terminals = events.filter(
    (event) => event.type === "final_result" || event.type === "error",
  );
  expect(terminals).toHaveLength(1);
  expect(last(events)).toBe(terminals[0]);
}

function createSuccessAdapter(
  name: ReviewAdapter["name"],
  options?: { runDelayMs?: number },
): ReviewAdapter {
  return {
    name,
    async preflight() {
      return {
        checks: [{ name: "mock", status: "passed" }],
        metadata: { readonlyCapability: "tool-restricted" },
      };
    },
    async run() {
      if (options?.runDelayMs) {
        await delay(options.runDelayMs);
      }
      return {
        structured: {
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation: `Mock ${name} review passed.`,
          overall_confidence_score: 0.9,
        },
        metadata: { captureMode: "tool-call" },
      };
    },
  };
}

function createFailingRunAdapter(name: ReviewAdapter["name"], message: string): ReviewAdapter {
  return {
    name,
    async preflight() {
      return { checks: [{ name: "mock", status: "passed" }] };
    },
    async run() {
      throw new Error(message);
    },
  };
}

function createFailingPreflightAdapter(
  name: ReviewAdapter["name"],
  message: string,
): ReviewAdapter {
  return {
    name,
    async preflight() {
      throw new Error(message);
    },
    async run() {
      throw new Error("run should not be called");
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
