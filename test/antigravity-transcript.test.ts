import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AntigravityTranscriptTailer,
  startAntigravityTranscriptTail,
} from "../src/adapters/antigravity-transcript.js";
import { createReviewerActivitySink } from "../src/adapters/reviewer-activity.js";

const SENTINEL = "LEAK_ME";

let root: string | undefined;
let activeTailer: AntigravityTranscriptTailer | undefined;

afterEach(async () => {
  await activeTailer?.stop();
  activeTailer = undefined;
  if (root !== undefined) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

function createBrainLayout(conversationId = "11111111-2222-4333-8444-555555555555") {
  root = mkdtempSync(path.join(tmpdir(), "diffwarden-agy-tail-"));
  const homeDir = path.join(root, "antigravity-home");
  const logsDir = path.join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  return {
    homeDir,
    transcriptPath: path.join(logsDir, "transcript.jsonl"),
    createLogsDir() {
      mkdirSync(logsDir, { recursive: true });
    },
  };
}

function startCollectingTailer(homeDir: string, pollIntervalMs = 10) {
  const lines: string[] = [];
  const tailer = startAntigravityTranscriptTail({
    homeDir,
    pollIntervalMs,
    sink: createReviewerActivitySink("antigravity-transcript", (text) => lines.push(text)),
  });
  activeTailer = tailer;
  return { lines, tailer };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function plannerLine(content: string, toolNames: string[] = []): string {
  return `${JSON.stringify({
    type: "PLANNER_RESPONSE",
    content,
    thinking: SENTINEL,
    tool_calls: toolNames.map((name) => ({ name, args: { secret: SENTINEL } })),
  })}\n`;
}

describe("startAntigravityTranscriptTail", () => {
  it("discovers the single conversation transcript and renders live appends", async () => {
    const layout = createBrainLayout();
    layout.createLogsDir();
    writeFileSync(
      layout.transcriptPath,
      `${JSON.stringify({ type: "USER_INPUT", content: "echoed review prompt" })}\n`,
      "utf8",
    );
    const { lines, tailer } = startCollectingTailer(layout.homeDir);

    await waitFor(() => lines.length >= 1);
    expect(lines).toEqual(["[USER_INPUT 20 chars]"]);
    expect(tailer.transcriptDiscovered()).toBe(true);

    // Mid-run live append, including a partial trailing line.
    appendFileSync(layout.transcriptPath, plannerLine("checking the diff", ["view_file"]), "utf8");
    const toolLine = JSON.stringify({ type: "VIEW_FILE", content: SENTINEL });
    appendFileSync(layout.transcriptPath, toolLine.slice(0, 12), "utf8");

    await waitFor(() => lines.length >= 2);
    // The partial line is held until its newline arrives — no torn JSON parse.
    expect(lines).toEqual(["[USER_INPUT 20 chars]", "checking the diff"]);

    appendFileSync(layout.transcriptPath, `${toolLine.slice(12)}\n`, "utf8");
    await waitFor(() => lines.length >= 3);
    expect(lines).toEqual([
      "[USER_INPUT 20 chars]",
      "checking the diff",
      "[tool_use view_file]",
    ]);
    // Offset tracking: already-rendered lines never re-render.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lines).toHaveLength(3);
    expect(lines.join("")).not.toContain(SENTINEL);

    await tailer.stop();
    expect(lines).toHaveLength(3);
  });

  it("discovers a transcript that appears only after the tailer started", async () => {
    const layout = createBrainLayout();
    const { lines, tailer } = startCollectingTailer(layout.homeDir);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(tailer.transcriptDiscovered()).toBe(false);
    expect(lines).toEqual([]);

    layout.createLogsDir();
    writeFileSync(layout.transcriptPath, plannerLine("late transcript"), "utf8");
    await waitFor(() => lines.length >= 1);
    expect(lines).toEqual(["late transcript"]);
    expect(tailer.transcriptDiscovered()).toBe(true);
  });

  it("degrades silently when the transcript never appears", async () => {
    const layout = createBrainLayout();
    const { lines, tailer } = startCollectingTailer(layout.homeDir);

    await new Promise((resolve) => setTimeout(resolve, 40));
    await tailer.stop();

    expect(tailer.transcriptDiscovered()).toBe(false);
    expect(lines).toEqual([]);
    // stop() is idempotent and still never throws.
    await expect(tailer.stop()).resolves.toBeUndefined();
  });

  it("drains the whole transcript on stop, treating a trailing newline-less line as complete", async () => {
    const layout = createBrainLayout();
    layout.createLogsDir();
    // A huge poll interval guarantees no interval tick ever fires: everything
    // below is caught exclusively by stop()'s final drain.
    const { lines, tailer } = startCollectingTailer(layout.homeDir, 3_600_000);

    writeFileSync(
      layout.transcriptPath,
      `${plannerLine("final drain prose", ["run_command"])}${JSON.stringify({
        type: "RUN_COMMAND",
        output: SENTINEL,
      })}\n${JSON.stringify({ type: "PLANNER_RESPONSE", content: "trailing line", thinking: SENTINEL })}`,
      "utf8",
    );

    await tailer.stop();

    expect(lines).toEqual(["final drain prose", "[tool_use run_command]", "trailing line"]);
    expect(tailer.transcriptDiscovered()).toBe(true);
    expect(lines.join("")).not.toContain(SENTINEL);
  });

  it("drops torn or non-JSON lines without derailing later lines", async () => {
    const layout = createBrainLayout();
    layout.createLogsDir();
    writeFileSync(
      layout.transcriptPath,
      `not json at all\n${plannerLine("still renders")}`,
      "utf8",
    );
    const { lines, tailer } = startCollectingTailer(layout.homeDir, 3_600_000);

    await tailer.stop();
    expect(lines).toEqual(["still renders"]);
  });

  it("keeps multi-byte characters intact across a mid-character append boundary", async () => {
    const layout = createBrainLayout();
    layout.createLogsDir();
    const line = Buffer.from(
      `${JSON.stringify({ type: "PLANNER_RESPONSE", content: "café résumé" })}\n`,
      "utf8",
    );
    // Split inside the 2-byte UTF-8 sequence for the first é.
    const splitAt = line.indexOf(0xc3) + 1;
    writeFileSync(layout.transcriptPath, line.subarray(0, splitAt));
    const { lines, tailer } = startCollectingTailer(layout.homeDir);

    await waitFor(() => tailer.transcriptDiscovered());
    // Give the poller a beat with only the torn prefix on disk.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lines).toEqual([]);

    appendFileSync(layout.transcriptPath, line.subarray(splitAt));
    await waitFor(() => lines.length >= 1);
    expect(lines).toEqual(["café résumé"]);
  });

  it("never throws into the review path when the sink emit throws", async () => {
    const layout = createBrainLayout();
    layout.createLogsDir();
    writeFileSync(layout.transcriptPath, plannerLine("boom"), "utf8");
    const tailer = startAntigravityTranscriptTail({
      homeDir: layout.homeDir,
      pollIntervalMs: 3_600_000,
      sink: createReviewerActivitySink("antigravity-transcript", () => {
        throw new Error("recorder failed");
      }),
    });
    activeTailer = tailer;

    await expect(tailer.stop()).resolves.toBeUndefined();
    expect(tailer.transcriptDiscovered()).toBe(true);
  });
});
