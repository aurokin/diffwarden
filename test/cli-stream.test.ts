import { describe, expect, it } from "vitest";

import {
  createCliStreamChunkParser,
  extractClaudeStreamResultStdout,
  extractDroidStreamResultStdout,
} from "../src/adapters/cli-stream.js";

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

describe("createCliStreamChunkParser (claude-stream-json)", () => {
  it("renders compact summaries and drops thinking blocks", () => {
    const parser = createCliStreamChunkParser("claude-stream-json");
    const rendered = parser.push(
      line({ type: "system", subtype: "init" }) +
        line({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "secret reasoning" },
              { type: "text", text: "looking at the diff" },
              { type: "tool_use", name: "Read" },
            ],
          },
        }) +
        line({
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "abcdefgh" }],
          },
        }) +
        line({ type: "rate_limit_event" }) +
        // Top-level reasoning-typed events are dropped entirely (no marker).
        line({ type: "thinking", thinking: "secret reasoning" }) +
        line({ type: "result", subtype: "success", num_turns: 3, duration_ms: 42 }),
    );

    expect(rendered).toEqual([
      "[system:init]\n",
      "looking at the diff\n[tool_use Read]\n",
      "[tool_result 8 chars]\n",
      "[rate_limit_event]\n",
      "[result:success turns=3 duration_ms=42]\n",
    ]);
    expect(rendered.join("")).not.toContain("secret reasoning");
  });

  it("buffers partial lines across chunk boundaries", () => {
    const parser = createCliStreamChunkParser("claude-stream-json");
    const full = line({ type: "system", subtype: "init" });

    expect(parser.push(full.slice(0, 10))).toEqual([]);
    expect(parser.push(full.slice(10))).toEqual(["[system:init]\n"]);
  });

  it("renders a trailing line without a newline on flush", () => {
    const parser = createCliStreamChunkParser("claude-stream-json");

    expect(parser.push(JSON.stringify({ type: "result", subtype: "success" }))).toEqual([]);
    expect(parser.flush()).toEqual(["[result:success]\n"]);
    expect(parser.flush()).toEqual([]);
  });

  it("skips blank lines silently", () => {
    const parser = createCliStreamChunkParser("claude-stream-json");
    expect(parser.push(`\n\n${line({ type: "system", subtype: "init" })}\n`)).toEqual([
      "[system:init]\n",
    ]);
  });

  it("degrades to raw passthrough when a line is not JSON", () => {
    const parser = createCliStreamChunkParser("claude-stream-json");

    expect(parser.push(line({ type: "system", subtype: "init" }))).toEqual(["[system:init]\n"]);
    // The offending line plus everything already buffered is surfaced raw.
    expect(parser.push("plain text output\npartial")).toEqual(["plain text output\npartial"]);
    // Every later chunk stays raw, valid JSON or not.
    expect(parser.push(line({ type: "result", subtype: "success" }))).toEqual([
      line({ type: "result", subtype: "success" }),
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it("returns a non-JSON trailing line raw on flush", () => {
    const parser = createCliStreamChunkParser("claude-stream-json");
    expect(parser.push("not json without newline")).toEqual([]);
    expect(parser.flush()).toEqual(["not json without newline"]);
  });
});

describe("createCliStreamChunkParser (droid-stream-json)", () => {
  it("summarizes events and excludes reasoning", () => {
    const parser = createCliStreamChunkParser("droid-stream-json");
    const rendered = parser.push(
      line({ type: "system", subtype: "init", session_id: "s-1" }) +
        line({ type: "message", role: "user", text: "review prompt" }) +
        line({ type: "reasoning", text: "secret reasoning" }) +
        line({ type: "thinking_delta", text: "more secret reasoning" }) +
        line({ type: "message", role: "assistant", text: "reading files" }) +
        line({ type: "tool_call", name: "read-cli" }) +
        line({ type: "completion", finalText: "done", numTurns: 2, durationMs: 17 }),
    );

    expect(rendered).toEqual([
      "[system:init]\n",
      "[user message 13 chars]\n",
      "reading files\n",
      "[tool_call read-cli]\n",
      "[completion turns=2 duration_ms=17]\n",
    ]);
    expect(rendered.join("")).not.toContain("secret reasoning");
  });
});

describe("extractClaudeStreamResultStdout", () => {
  it("returns the last result event line verbatim", () => {
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      structured_output: { verdict: "ok" },
    });
    const stdout = `${
      line({ type: "system", subtype: "init" }) +
      line({ type: "result", subtype: "success", result: "stale" })
    }${resultLine}\n`;

    expect(extractClaudeStreamResultStdout(stdout)).toBe(resultLine);
  });

  it("returns undefined when the transcript has no result event", () => {
    const stdout = `${line({ type: "system", subtype: "init" })}not json\n`;
    expect(extractClaudeStreamResultStdout(stdout)).toBeUndefined();
  });
});

describe("extractDroidStreamResultStdout", () => {
  it("maps the completion event onto the json result envelope", () => {
    const stdout =
      line({ type: "system", subtype: "init", session_id: "s-1" }) +
      line({ type: "message", role: "assistant", text: "reading" }) +
      line({
        type: "completion",
        finalText: "final review text",
        numTurns: 4,
        durationMs: 99,
        session_id: "s-1",
        usage: { input_tokens: 10 },
      });

    const extracted = extractDroidStreamResultStdout(stdout);
    expect(extracted).toBeDefined();
    expect(JSON.parse(extracted as string)).toEqual({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "final review text",
      duration_ms: 99,
      num_turns: 4,
      session_id: "s-1",
      usage: { input_tokens: 10 },
    });
  });

  it("returns undefined without a completion event or finalText", () => {
    expect(
      extractDroidStreamResultStdout(line({ type: "message", role: "assistant", text: "x" })),
    ).toBeUndefined();
    expect(
      extractDroidStreamResultStdout(line({ type: "completion", numTurns: 1 })),
    ).toBeUndefined();
  });
});
