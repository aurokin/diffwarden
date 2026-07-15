/**
 * Antigravity transcript-tail debug capture.
 *
 * ⚠️ HARD SAFETY RULE (live-verified 2026-07-15, absolute): NEVER pass
 * speculative or unknown flags to `agy` — in code or in manual probes. agy
 * does not reject unknown flags in print mode; it folds them into the prompt
 * and launches a full PAID, TOOL-EXECUTING agent run (a probe with
 * `--output-format bogus` spawned an agent that investigated the flag and
 * recursively invoked agy). Support probing is limited to `agy --help
 * </dev/null` greps and the existing `--version` min-version gate. Debug
 * capture therefore never touches the invocation: agy 1.1.2 has no
 * machine-readable stdout mode, but it live-appends a per-conversation
 * transcript at
 * `$HOME/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`,
 * and diffwarden runs agy with an ISOLATED HOME — so the spend-free probe is
 * a filesystem poll under that home (exactly one conversation per review;
 * glob because agy never echoes the conversation id), degrading silently if
 * the transcript never appears (undocumented internal surface that may move
 * between agy versions).
 *
 * Lifecycle guarantees: the poll timer is unref'd so the tailer never keeps
 * the process alive, every path swallows errors so debug capture never
 * throws into the review path, and stop() drains the file one final time
 * (treating a trailing newline-less line as complete) after the agy process
 * has exited.
 */

import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CliInvocation } from "./cli-types.js";
import { type ReviewerActivitySink, activitySinkFromDebugOutput } from "./reviewer-activity.js";
import type { ReviewAdapterInput } from "./types.js";

const defaultPollIntervalMs = 300;
const lineFeedByte = 0x0a;

export type AntigravityTranscriptTailer = {
  /** True once the transcript file was discovered under the isolated HOME. */
  transcriptDiscovered(): boolean;
  /** Stop polling and run the final drain. Idempotent; never throws. */
  stop(): Promise<void>;
};

/**
 * Wire transcript capture for an antigravity invocation. Undefined unless the
 * invocation staged an isolated home AND the run requested debug output
 * (`--debug-reviewer-output`; a file tail involves no invocation change, so —
 * matching the always-JSONL engines' convention — capture is not gated on
 * `--ndjson`). Stdout parsing is untouched either way: the terminal stdout
 * stays the source of truth for the review result.
 */
export function antigravityTranscriptDebugCapture(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
): AntigravityTranscriptTailer | undefined {
  const homeDir = invocation.antigravityIsolatedHome;
  if (homeDir === undefined) {
    return undefined;
  }
  const sink = activitySinkFromDebugOutput("antigravity-transcript", input.debugOutput);
  if (sink === undefined) {
    return undefined;
  }
  return startAntigravityTranscriptTail({ homeDir, sink });
}

export function startAntigravityTranscriptTail(options: {
  homeDir: string;
  sink: ReviewerActivitySink;
  pollIntervalMs?: number;
}): AntigravityTranscriptTailer {
  const brainDir = path.join(options.homeDir, ".gemini", "antigravity-cli", "brain");
  const sink = options.sink;
  let transcriptPath: string | undefined;
  let byteOffset = 0;
  let partialLine: Buffer = Buffer.alloc(0);
  let stopped = false;

  // Polls are serialized through this chain so ticks never overlap and
  // stop()'s final drain always runs after any in-flight poll.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(task: () => Promise<void>): Promise<void> {
    chain = chain.then(task).catch(() => {
      // Debug capture never fails or stalls the review.
    });
    return chain;
  }

  async function discoverTranscript(): Promise<string | undefined> {
    if (transcriptPath !== undefined) {
      return transcriptPath;
    }
    let conversations: string[];
    try {
      const entries = await readdir(brainDir, { withFileTypes: true });
      // The isolated HOME holds exactly one conversation per review; the sort
      // keeps discovery deterministic if that invariant ever breaks.
      conversations = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return undefined; // brain dir not created yet
    }
    for (const conversation of conversations) {
      const candidate = path.join(
        brainDir,
        conversation,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      try {
        await stat(candidate);
        transcriptPath = candidate;
        return candidate;
      } catch {
        // Conversation dir exists but the transcript file does not, yet.
      }
    }
    return undefined;
  }

  async function drainAppendedBytes(): Promise<void> {
    const file = await discoverTranscript();
    if (file === undefined) {
      return;
    }
    const size = (await stat(file)).size;
    if (size <= byteOffset) {
      return;
    }
    const handle = await open(file, "r");
    let appended: Buffer;
    try {
      const buffer = Buffer.alloc(size - byteOffset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteOffset);
      appended = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    byteOffset += appended.length;
    emitCompleteLines(Buffer.concat([partialLine, appended]));
  }

  function emitCompleteLines(data: Buffer): void {
    // Complete lines only: the trailing partial line stays buffered until its
    // newline arrives (or until the final drain). Splitting at the byte level
    // is UTF-8-safe — 0x0a never occurs inside a multi-byte sequence — so a
    // multi-byte character torn across two reads stays intact in the buffer.
    const lastNewline = data.lastIndexOf(lineFeedByte);
    if (lastNewline === -1) {
      partialLine = data;
      return;
    }
    partialLine = data.subarray(lastNewline + 1);
    for (const line of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
      emitLine(line);
    }
  }

  function emitLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // torn or non-JSON line: drop silently
    }
    sink.event(event);
  }

  const timer = setInterval(() => {
    if (!stopped) {
      void enqueue(drainAppendedBytes);
    }
  }, options.pollIntervalMs ?? defaultPollIntervalMs);
  // The tailer must never keep the process alive.
  timer.unref();

  return {
    transcriptDiscovered() {
      return transcriptPath !== undefined;
    },
    async stop() {
      if (stopped) {
        await chain;
        return;
      }
      stopped = true;
      clearInterval(timer);
      await enqueue(async () => {
        // Final drain: the agy process has exited, so the file is complete
        // and a trailing line without a newline is treated as complete.
        await drainAppendedBytes();
        if (partialLine.length > 0) {
          emitLine(partialLine.toString("utf8"));
          partialLine = Buffer.alloc(0);
        }
        sink.end();
      });
    },
  };
}
