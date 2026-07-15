import { describe, expect, it } from "vitest";

import {
  type ActivityDialect,
  type ActivityRenderer,
  activitySinkFromDebugOutput,
  claudeStreamEventText,
  createReviewerActivitySink,
  droidStreamEventText,
  renderActivityEvent,
} from "../src/adapters/reviewer-activity.js";

const SENTINEL = "LEAK_ME";

/** Every dialect renderer must run through the shared policy wrapper. */
const dialectRenderers: Array<[ActivityDialect, ActivityRenderer]> = [
  ["claude-stream-json", claudeStreamEventText],
  ["droid-stream-json", droidStreamEventText],
];

/**
 * Shared adversarial fixture set. Whatever a dialect renderer does with these,
 * the invariants hold: never throws, the sentinel never renders, unknown types
 * render a payload-free `[type]` marker or drop.
 */
const adversarialEvents: Array<[string, unknown]> = [
  // Reasoning-typed events with sentinels in payloads (universal type drop).
  ["reasoning event", { type: "reasoning", text: SENTINEL }],
  ["thinking event", { type: "thinking", thinking: SENTINEL }],
  ["thinking delta", { type: "thinking_delta", text: SENTINEL }],
  ["thought delta", { type: "thought", data: SENTINEL }],
  ["namespaced reasoning", { type: "assistant.reasoning_delta", data: { content: SENTINEL } }],
  ["JSON-RPC reasoning method", { method: "item/reasoning/delta", params: { text: SENTINEL } }],
  // Sentinels planted in non-allowlisted fields (structural prose invariant).
  [
    "thinking content block",
    { type: "assistant", message: { content: [{ type: "thinking", thinking: SENTINEL }] } },
  ],
  [
    "redacted thinking block",
    { type: "assistant", message: { content: [{ type: "redacted_thinking", data: SENTINEL }] } },
  ],
  [
    "unknown content block",
    { type: "assistant", message: { content: [{ type: "new_block", text: SENTINEL }] } },
  ],
  [
    "tool_result content",
    { type: "user", message: { content: [{ type: "tool_result", content: SENTINEL }] } },
  ],
  [
    "tool_use input params",
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { secret: SENTINEL } }] },
    },
  ],
  ["user message text", { type: "message", role: "user", text: `${SENTINEL} prompt` }],
  ["tool_call args", { type: "tool_call", name: "read-cli", args: { path: SENTINEL } }],
  ["unknown event params", { type: "custom_event", params: { secret: SENTINEL } }],
  ["unknown event payload", { type: "weird_event", payload: SENTINEL }],
  // Huge payloads.
  ["huge unknown payload", { type: "burst", data: SENTINEL.repeat(200_000) }],
  [
    "huge thinking block",
    {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: SENTINEL.repeat(200_000) }] },
    },
  ],
  // Renamed / unknown types.
  ["renamed type", { type: "totally_new_event", text: SENTINEL }],
  ["method-only event", { method: "some/method", params: { text: SENTINEL } }],
];

const nonRecordEvents: unknown[] = [null, undefined, [], [{ type: "text" }], "a string", 42, true];

describe("renderActivityEvent invariants (every dialect)", () => {
  for (const [dialect, render] of dialectRenderers) {
    describe(dialect, () => {
      it("never throws and never renders a sentinel", () => {
        for (const [name, event] of adversarialEvents) {
          let rendered: string | undefined;
          expect(() => {
            rendered = renderActivityEvent(render, event);
          }, name).not.toThrow();
          expect(rendered ?? "", name).not.toContain(SENTINEL);
        }
      });

      it("drops every reasoning-flavored type before the renderer runs", () => {
        for (const type of ["reasoning", "thinking", "thinking_delta", "thought", "Thinking"]) {
          expect(renderActivityEvent(render, { type, text: SENTINEL })).toBeUndefined();
        }
        // The drop also wins over a renderer that would throw on the payload.
        const hostileReasoning = {
          type: "thinking",
          get message(): never {
            throw new Error("boom");
          },
        };
        expect(renderActivityEvent(render, hostileReasoning)).toBeUndefined();
      });

      it("drops non-record events", () => {
        for (const event of nonRecordEvents) {
          expect(renderActivityEvent(render, event)).toBeUndefined();
        }
      });

      it("renders unknown types as payload-free markers", () => {
        expect(renderActivityEvent(render, { type: "totally_new_event", text: SENTINEL })).toBe(
          "[totally_new_event]",
        );
      });

      it("keeps per-event output bounded for huge payloads", () => {
        for (const [name, event] of adversarialEvents) {
          const rendered = renderActivityEvent(render, event);
          if (rendered !== undefined) {
            expect(rendered.length, name).toBeLessThan(1024);
          }
        }
      });

      it("drops an event whose type getter throws", () => {
        const hostileType = {
          get type(): never {
            throw new Error("boom");
          },
        };
        expect(() => renderActivityEvent(render, hostileType)).not.toThrow();
        expect(renderActivityEvent(render, hostileType)).toBeUndefined();

        const hostileMethod = {
          get method(): never {
            throw new Error("boom");
          },
        };
        expect(renderActivityEvent(render, hostileMethod)).toBeUndefined();
      });

      it("degrades a renderer throw to a payload-free [type] marker", () => {
        // Every property except type/method throws, so any renderer that
        // reads a payload field hits its catch fallback.
        const hostilePayload = new Proxy({ type: "assistant" } as Record<string, unknown>, {
          get(target, prop) {
            if (prop === "type" || prop === "method") {
              return Reflect.get(target, prop);
            }
            throw new Error(SENTINEL);
          },
        });
        expect(renderActivityEvent(render, hostilePayload)).toBe("[assistant]");
      });
    });
  }
});

describe("renderActivityEvent dialect rendering", () => {
  it("keeps claude assistant text and tool markers, dropping thinking blocks", () => {
    const rendered = renderActivityEvent(claudeStreamEventText, {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: SENTINEL },
          { type: "text", text: "looking at the diff" },
          { type: "tool_use", name: "Read", input: { path: SENTINEL } },
          { type: "tool_result", content: "abcdefgh" },
        ],
      },
    });
    expect(rendered).toBe("looking at the diff\n[tool_use Read]\n[tool_result 8 chars]");
  });

  it("bounds tool names embedded in markers to 128 chars", () => {
    const longName = "x".repeat(500) + SENTINEL;
    const claude = renderActivityEvent(claudeStreamEventText, {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: longName }] },
    });
    expect(claude).toBe(`[tool_use ${"x".repeat(128)}]`);

    const droid = renderActivityEvent(droidStreamEventText, {
      type: "tool_call",
      name: longName,
    });
    expect(droid).toBe(`[tool_call ${"x".repeat(128)}]`);
  });

  it("reduces droid user messages to size markers", () => {
    const rendered = renderActivityEvent(droidStreamEventText, {
      type: "message",
      role: "user",
      text: "review prompt",
    });
    expect(rendered).toBe("[user message 13 chars]");
  });
});

describe("createReviewerActivitySink", () => {
  it("emits rendered events and notes, skipping dropped events", () => {
    const emitted: string[] = [];
    const sink = createReviewerActivitySink("droid-stream-json", (text) => emitted.push(text));

    sink.event({ type: "message", role: "assistant", text: "reading files" });
    sink.event({ type: "reasoning", text: SENTINEL });
    sink.event(null);
    sink.note("[request approval -> declined]");
    sink.end();

    expect(emitted).toEqual(["reading files", "[request approval -> declined]"]);
  });

  it("never throws when emit throws", () => {
    const sink = createReviewerActivitySink("claude-stream-json", () => {
      throw new Error("emit failed");
    });
    expect(() => {
      sink.event({ type: "system", subtype: "init" });
      sink.note("marker");
      sink.end();
    }).not.toThrow();
  });
});

describe("activitySinkFromDebugOutput", () => {
  it("returns undefined when the run did not opt in", () => {
    expect(activitySinkFromDebugOutput("claude-stream-json", undefined)).toBeUndefined();
  });

  it("writes newline-terminated lines to the stdout debug stream", () => {
    const chunks: Array<[string, string]> = [];
    const sink = activitySinkFromDebugOutput("claude-stream-json", {
      onChunk: (stream, text) => chunks.push([stream, text]),
    });

    sink?.event({ type: "system", subtype: "init" });
    sink?.event({ type: "thinking", thinking: SENTINEL });
    sink?.note("[note]");
    sink?.end();

    expect(chunks).toEqual([
      ["stdout", "[system:init]\n"],
      ["stdout", "[note]\n"],
    ]);
  });

  it("never throws when onChunk throws", () => {
    const sink = activitySinkFromDebugOutput("droid-stream-json", {
      onChunk: () => {
        throw new Error("recorder failed");
      },
    });
    expect(() => {
      sink?.event({ type: "message", role: "assistant", text: "hello" });
      sink?.note("marker");
      sink?.end();
    }).not.toThrow();
  });
});
