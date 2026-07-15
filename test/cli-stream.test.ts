import { describe, expect, it } from "vitest";

import {
  createCliStreamChunkParser,
  extractClaudeStreamResultStdout,
  extractDroidStreamResultStdout,
  extractGrokStreamResultStdout,
} from "../src/adapters/cli-stream.js";
import {
  createDeltaCoalescer,
  deltaCoalescerBufferCapChars,
} from "../src/adapters/reviewer-activity.js";

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

describe("createCliStreamChunkParser (cursor-stream-json)", () => {
  it("renders claude-shaped summaries and drops top-level thinking delta events", () => {
    const parser = createCliStreamChunkParser("cursor-stream-json");
    const rendered = parser.push(
      line({ type: "system", subtype: "init", session_id: "s-1", model: "test-model" }) +
        // Cursor emits top-level thinking delta events; the universal
        // reasoning drop removes them before the renderer runs (otherwise
        // one noisy [thinking] marker would print per delta).
        line({ type: "thinking", subtype: "delta", text: "secret reasoning" }) +
        line({ type: "thinking", subtype: "completed" }) +
        // Cursor re-echoes the review prompt as a user event (live-observed);
        // it reduces to a size marker so the prompt never re-renders.
        line({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "echoed review prompt" }] },
          session_id: "s-1",
        }) +
        line({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "checking the diff" }] },
          session_id: "s-1",
        }) +
        // tool_call shape is unverified (no tools triggered in captures);
        // the payload-free [type] fallback is the required behavior.
        line({ type: "tool_call", subtype: "started", session_id: "s-1" }) +
        // Cursor result events carry no num_turns; the summary omits turns.
        line({ type: "result", subtype: "success", duration_ms: 12, result: "done" }),
    );

    expect(rendered).toEqual([
      "[system:init]\n",
      "[user message 47 chars]\n",
      "checking the diff\n",
      "[tool_call]\n",
      "[result:success duration_ms=12]\n",
    ]);
    expect(rendered.join("")).not.toContain("secret reasoning");
    expect(rendered.join("")).not.toContain("echoed review prompt");
    expect(rendered.join("")).not.toContain("[thinking]");
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

describe("createCliStreamChunkParser (grok-streaming-json)", () => {
  it("coalesces token-level text deltas into per-turn blocks, excluding thought deltas", () => {
    const parser = createCliStreamChunkParser("grok-streaming-json");
    const rendered = parser.push(
      line({ type: "thought", data: "secret reasoning" }) +
        line({ type: "thought", data: " more secret reasoning" }) +
        line({ type: "text", data: "I'll" }) +
        line({ type: "text", data: " read" }) +
        line({ type: "text", data: " the files." }) +
        line({ type: "thought", data: "hidden turn-two reasoning" }) +
        line({ type: "text", data: "beta" }) +
        line({ type: "text", data: " is 2" }) +
        line({
          type: "end",
          stopReason: "EndTurn",
          sessionId: "s-1",
          usage: { input_tokens: 10 },
          num_turns: 2,
        }),
    );

    // One block per turn plus the terminal summary — never one line per token.
    expect(rendered).toEqual(["I'll read the files.\n", "beta is 2\n", "[end:EndTurn turns=2]\n"]);
    expect(rendered.join("")).not.toContain("secret");
    expect(rendered.join("")).not.toContain("hidden");
  });

  it("drains a pending text block on flush when no end event arrived", () => {
    const parser = createCliStreamChunkParser("grok-streaming-json");
    expect(
      parser.push(
        line({ type: "text", data: "partial" }) + line({ type: "text", data: " answer" }),
      ),
    ).toEqual([]);
    expect(parser.flush()).toEqual(["partial answer\n"]);
    expect(parser.flush()).toEqual([]);
  });

  it("coalesces a trailing text delta without a newline on flush", () => {
    const parser = createCliStreamChunkParser("grok-streaming-json");
    expect(parser.push(line({ type: "text", data: "head" }))).toEqual([]);
    expect(parser.push(JSON.stringify({ type: "text", data: " tail" }))).toEqual([]);
    expect(parser.flush()).toEqual(["head tail\n"]);
  });

  it("drains the coalesced block before degrading to raw passthrough", () => {
    const parser = createCliStreamChunkParser("grok-streaming-json");
    expect(parser.push(line({ type: "text", data: "buffered answer" }))).toEqual([]);
    expect(parser.push("plain text output\n")).toEqual([
      "buffered answer\n",
      "plain text output\n",
    ]);
    // Every later chunk stays raw, valid JSON or not.
    expect(parser.push(line({ type: "text", data: "x" }))).toEqual([
      line({ type: "text", data: "x" }),
    ]);
    expect(parser.flush()).toEqual([]);
  });
});

describe("createDeltaCoalescer", () => {
  it("aggregates deltas and emits the block once on flush", () => {
    const coalescer = createDeltaCoalescer();
    expect(coalescer.push("text", "a")).toEqual([]);
    expect(coalescer.push("text", "b")).toEqual([]);
    expect(coalescer.flush()).toEqual(["ab"]);
    // Emitted-length dedupe: a second flush never re-emits.
    expect(coalescer.flush()).toEqual([]);
  });

  it("flushes the pending block on an item-key transition", () => {
    const coalescer = createDeltaCoalescer();
    expect(coalescer.push("item-1", "first")).toEqual([]);
    expect(coalescer.push("item-2", "second")).toEqual(["first"]);
    expect(coalescer.flush()).toEqual(["second"]);
  });

  it("emits early at the buffer cap without re-emitting drained chars", () => {
    const coalescer = createDeltaCoalescer(8);
    expect(coalescer.push("text", "abcd")).toEqual([]);
    expect(coalescer.push("text", "efgh")).toEqual(["abcdefgh"]);
    // Emitted-length dedupe: only chars after the overflow drain emit later.
    expect(coalescer.push("text", "ij")).toEqual([]);
    expect(coalescer.flush()).toEqual(["ij"]);
  });

  it("defaults the per-item buffer cap to 64 KiB", () => {
    const coalescer = createDeltaCoalescer();
    const chunk = "x".repeat(deltaCoalescerBufferCapChars - 1);
    expect(coalescer.push("text", chunk)).toEqual([]);
    expect(coalescer.push("text", "yz")).toEqual([`${chunk}yz`]);
    expect(coalescer.flush()).toEqual([]);
  });
});

describe("createCliStreamChunkParser (always-JSONL dialects)", () => {
  it("summarizes codex --json events, deduping item updates", () => {
    const parser = createCliStreamChunkParser("codex-json");
    const rendered = parser.push(
      line({ type: "thread.started", thread_id: "th_1" }) +
        line({
          type: "item.completed",
          item: { id: "i_0", type: "reasoning", text: "secret reasoning" },
        }) +
        line({
          type: "item.updated",
          item: { id: "i_1", type: "agent_message", text: "partial" },
        }) +
        line({
          type: "item.completed",
          item: { id: "i_1", type: "agent_message", text: "codex answer" },
        }) +
        line({
          type: "item.completed",
          item: { id: "i_2", type: "command_execution", aggregated_output: "abcdefgh" },
        }) +
        line({ type: "turn.completed" }),
    );

    expect(rendered).toEqual([
      "[thread.started]\n",
      "codex answer\n",
      "[command_execution 8 chars]\n",
      "[turn.completed]\n",
    ]);
    expect(rendered.join("")).not.toContain("secret reasoning");
  });

  it("summarizes opencode --format json events from part payloads", () => {
    const parser = createCliStreamChunkParser("opencode-json");
    const rendered = parser.push(
      line({ type: "reasoning", part: { type: "reasoning", text: "secret reasoning" } }) +
        line({ type: "text", part: { type: "text", text: "opencode answer" } }) +
        line({
          type: "tool",
          part: { type: "tool", tool: "grep", state: { output: "abcdefgh" } },
        }) +
        line({ type: "step_finish", part: { type: "step_finish", reason: "stop" } }),
    );

    expect(rendered).toEqual([
      "opencode answer\n",
      "[tool_use grep] [output 8 chars]\n",
      "[step_finish reason=stop]\n",
    ]);
    expect(rendered.join("")).not.toContain("secret reasoning");
  });

  it("summarizes copilot json events through the strict allowlist", () => {
    const parser = createCliStreamChunkParser("copilot-json");
    const rendered = parser.push(
      line({ type: "session.started", sessionId: "sess-1" }) +
        line({ type: "assistant.message_delta", data: { content: "secret partial" } }) +
        line({
          type: "assistant.message",
          data: { content: "copilot answer", toolRequests: [{ name: "grep_search" }] },
        }),
    );

    expect(rendered).toEqual(["[session.started]\n", "copilot answer\n[tool_use grep_search]\n"]);
    expect(rendered.join("")).not.toContain("secret partial");
    expect(rendered.join("")).not.toContain("sess-1");
  });

  it("summarizes pi --mode json events without message_update duplication", () => {
    const parser = createCliStreamChunkParser("pi-json");
    const rendered = parser.push(
      line({ type: "agent_start" }) +
        line({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: "partial secret" }] },
        }) +
        line({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "secret reasoning" },
              { type: "text", text: "pi answer" },
            ],
          },
        }) +
        line({ type: "agent_end", messages: [{ role: "assistant", content: [] }] }),
    );

    expect(rendered).toEqual(["[agent_start]\n", "pi answer\n", "[agent_end]\n"]);
    expect(rendered.join("")).not.toContain("secret");
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

  it("extracts cursor's result event, which shares the claude envelope", () => {
    // Cursor reuses this extractor verbatim; its result event has the same
    // shape as its json-mode stdout, minus num_turns (cosmetic only).
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 12,
      result: "cursor review text",
      session_id: "s-1",
    });
    const stdout = `${
      line({ type: "system", subtype: "init", session_id: "s-1", model: "test-model" }) +
      line({ type: "thinking", subtype: "delta", text: "secret reasoning" })
    }${resultLine}\n`;

    expect(extractClaudeStreamResultStdout(stdout)).toBe(resultLine);
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

describe("extractGrokStreamResultStdout", () => {
  it("synthesizes the json envelope from the end event and in-order text deltas", () => {
    const stdout =
      line({ type: "thought", data: "secret reasoning" }) +
      line({ type: "text", data: "I'll read the files." }) +
      line({ type: "thought", data: "hidden turn-two reasoning" }) +
      line({ type: "text", data: "beta" }) +
      line({ type: "text", data: " is 2" }) +
      line({
        type: "end",
        stopReason: "EndTurn",
        sessionId: "s-1",
        requestId: "r-1",
        usage: { input_tokens: 10 },
        num_turns: 2,
        modelUsage: { "grok-test-model": { modelCalls: 2 } },
      });

    const extracted = extractGrokStreamResultStdout(stdout);
    expect(extracted).toBeDefined();
    // Field passthrough (end minus type) plus in-order text concat: json
    // mode's .text itself merges multi-turn text with no separator
    // (live-verified 2026-07-15), so naive concat matches json semantics.
    expect(JSON.parse(extracted as string)).toEqual({
      stopReason: "EndTurn",
      sessionId: "s-1",
      requestId: "r-1",
      usage: { input_tokens: 10 },
      num_turns: 2,
      modelUsage: { "grok-test-model": { modelCalls: 2 } },
      text: "I'll read the files.beta is 2",
    });
    expect(extracted).not.toContain("secret");
    expect(extracted).not.toContain("hidden");
  });

  it("omits thought from the envelope even if a future end event carries one", () => {
    const stdout =
      line({ type: "text", data: "answer" }) +
      line({ type: "end", stopReason: "EndTurn", thought: "secret reasoning" });
    const extracted = extractGrokStreamResultStdout(stdout);
    expect(extracted).toBeDefined();
    expect(JSON.parse(extracted as string)).toEqual({ stopReason: "EndTurn", text: "answer" });
  });

  it("returns undefined without an end event", () => {
    expect(
      extractGrokStreamResultStdout(line({ type: "text", data: "partial answer" })),
    ).toBeUndefined();
    expect(extractGrokStreamResultStdout("not json\n")).toBeUndefined();
    expect(extractGrokStreamResultStdout("")).toBeUndefined();
  });
});
