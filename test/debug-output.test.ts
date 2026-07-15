import { describe, expect, it } from "vitest";
import {
  createDebugOutputRecorder,
  debugOutputMaxBytesPerStream,
  debugOutputMaxEventTextBytes,
} from "../src/core/debug-output.js";

describe("debug output recorder", () => {
  it("records chunks within budget without truncation", () => {
    const recorder = createDebugOutputRecorder();

    expect(recorder.record("stdout", "hello ")).toEqual([
      { stream: "stdout", text: "hello ", truncated: false },
    ]);
    expect(recorder.record("stdout", "world\n")).toEqual([
      { stream: "stdout", text: "world\n", truncated: false },
    ]);
    expect(recorder.record("stderr", "warn\n")).toEqual([
      { stream: "stderr", text: "warn\n", truncated: false },
    ]);

    expect(recorder.finalize()).toEqual({
      stdout: "hello world\n",
      stdout_bytes: 12,
      stdout_truncated: false,
      stderr: "warn\n",
      stderr_bytes: 5,
      stderr_truncated: false,
    });
  });

  it("returns undefined from finalize when nothing was recorded", () => {
    expect(createDebugOutputRecorder().finalize()).toBeUndefined();
  });

  it("splits chunks larger than the per-event limit", () => {
    const recorder = createDebugOutputRecorder({ maxEventTextBytes: 4 });

    const chunks = recorder.record("stdout", "abcdefghij");
    expect(chunks).toEqual([
      { stream: "stdout", text: "abcd", truncated: false },
      { stream: "stdout", text: "efgh", truncated: false },
      { stream: "stdout", text: "ij", truncated: false },
    ]);
  });

  it("truncates at the per-stream budget and marks the final chunk", () => {
    const recorder = createDebugOutputRecorder({ maxBytesPerStream: 8, maxEventTextBytes: 4 });

    const chunks = recorder.record("stdout", "abcdefghij");
    expect(chunks).toEqual([
      { stream: "stdout", text: "abcd", truncated: false },
      { stream: "stdout", text: "efgh", truncated: true },
    ]);

    // Later chunks still count toward the total but emit nothing.
    expect(recorder.record("stdout", "klmno")).toEqual([]);

    expect(recorder.finalize()).toEqual({
      stdout: "abcdefgh",
      stdout_bytes: 15,
      stdout_truncated: true,
      stderr: "",
      stderr_bytes: 0,
      stderr_truncated: false,
    });
  });

  it("emits one empty truncated event when the budget was exactly consumed", () => {
    const recorder = createDebugOutputRecorder({ maxBytesPerStream: 4 });

    expect(recorder.record("stdout", "abcd")).toEqual([
      { stream: "stdout", text: "abcd", truncated: false },
    ]);
    expect(recorder.record("stdout", "e")).toEqual([
      { stream: "stdout", text: "", truncated: true },
    ]);
    expect(recorder.record("stdout", "f")).toEqual([]);

    const finalized = recorder.finalize();
    expect(finalized?.stdout).toBe("abcd");
    expect(finalized?.stdout_bytes).toBe(6);
    expect(finalized?.stdout_truncated).toBe(true);
  });

  it("never splits a multi-byte character at budget or event boundaries", () => {
    // "é" is 2 bytes in UTF-8; a 5-byte budget keeps two of them (4 bytes).
    const recorder = createDebugOutputRecorder({ maxBytesPerStream: 5, maxEventTextBytes: 3 });

    const chunks = recorder.record("stdout", "ééé");
    expect(chunks).toEqual([
      { stream: "stdout", text: "é", truncated: false },
      { stream: "stdout", text: "é", truncated: true },
    ]);

    const finalized = recorder.finalize();
    expect(finalized?.stdout).toBe("éé");
    expect(finalized?.stdout_bytes).toBe(6);
    expect(finalized?.stdout_truncated).toBe(true);
  });

  it("tracks stdout and stderr budgets independently", () => {
    const recorder = createDebugOutputRecorder({ maxBytesPerStream: 4 });

    recorder.record("stdout", "abcdef");
    expect(recorder.record("stderr", "xyz")).toEqual([
      { stream: "stderr", text: "xyz", truncated: false },
    ]);

    expect(recorder.finalize()).toEqual({
      stdout: "abcd",
      stdout_bytes: 6,
      stdout_truncated: true,
      stderr: "xyz",
      stderr_bytes: 3,
      stderr_truncated: false,
    });
  });

  it("uses the documented default limits", () => {
    expect(debugOutputMaxBytesPerStream).toBe(262_144);
    expect(debugOutputMaxEventTextBytes).toBe(8_192);
  });
});
