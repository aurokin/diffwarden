import { describe, expect, it } from "vitest";

import {
  type ActivityDialect,
  type ActivityRenderer,
  activityRenderer,
  activitySinkFromDebugOutput,
  claudeStreamEventText,
  codexJsonEventText,
  copilotJsonEventText,
  createReviewerActivitySink,
  cursorStreamEventText,
  droidSdkStreamEventText,
  droidStreamEventText,
  opencodeJsonEventText,
  piJsonEventText,
  renderActivityEvent,
} from "../src/adapters/reviewer-activity.js";

const SENTINEL = "LEAK_ME";

/** Every dialect renderer must run through the shared policy wrapper. */
const dialectRenderers: Array<[ActivityDialect, ActivityRenderer]> = [
  ["claude-stream-json", claudeStreamEventText],
  // Resolved through the dialect map so the wiring itself is under test.
  ["cursor-stream-json", activityRenderer("cursor-stream-json")],
  ["droid-stream-json", droidStreamEventText],
  ["codex-json", codexJsonEventText],
  ["opencode-json", opencodeJsonEventText],
  ["copilot-json", copilotJsonEventText],
  ["pi-json", piJsonEventText],
  // Resolved through the dialect map so the SDK wiring itself is under test.
  ["claude-sdk", activityRenderer("claude-sdk")],
  ["droid-sdk", activityRenderer("droid-sdk")],
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
  // Engine-nested reasoning and payload shapes (codex/opencode/copilot/pi).
  [
    "codex nested reasoning item",
    { type: "item.completed", item: { id: "i_0", type: "reasoning", text: SENTINEL } },
  ],
  [
    "codex command output",
    { type: "item.completed", item: { type: "command_execution", aggregated_output: SENTINEL } },
  ],
  [
    "codex updated agent message",
    { type: "item.updated", item: { id: "i_1", type: "agent_message", text: SENTINEL } },
  ],
  [
    "opencode part-nested reasoning",
    { type: "part.updated", part: { type: "reasoning", text: SENTINEL } },
  ],
  [
    "opencode tool state payloads",
    {
      type: "tool",
      part: { type: "tool", tool: "grep", state: { input: SENTINEL, output: SENTINEL } },
    },
  ],
  ["copilot message delta", { type: "assistant.message_delta", data: { content: SENTINEL } }],
  [
    "copilot embedded ids",
    {
      type: "assistant.message",
      data: { content: "ok", sessionId: SENTINEL, requestId: SENTINEL, apiCallId: SENTINEL },
    },
  ],
  [
    "pi message update",
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: SENTINEL }] },
    },
  ],
  [
    "pi toolResult message",
    {
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: SENTINEL }] },
    },
  ],
  [
    "pi agent_end embedded messages",
    {
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: SENTINEL }] }],
    },
  ],
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

  it("routes the cursor dialect to its claude-delegating renderer", () => {
    // Cursor's stream-json events share Claude's envelope (live-verified
    // 2026-07-15), so cursorStreamEventText delegates to claudeStreamEventText
    // for everything except the echoed-prompt user events.
    expect(activityRenderer("cursor-stream-json")).toBe(cursorStreamEventText);
  });

  it("reduces cursor user events (the echoed review prompt) to size markers", () => {
    // Live-observed 2026-07-15: cursor re-echoes the review prompt as a user
    // text event; rendering it verbatim would burn the bounded debug budget.
    expect(
      renderActivityEvent(cursorStreamEventText, {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: SENTINEL }] },
      }),
    ).toMatch(/^\[user message \d+ chars\]$/);
  });

  it("drops cursor top-level thinking deltas and omits turns from result summaries", () => {
    const render = activityRenderer("cursor-stream-json");
    // Cursor thinking deltas are top-level typed events: the universal
    // reasoning drop removes them before the renderer runs.
    expect(
      renderActivityEvent(render, { type: "thinking", subtype: "delta", text: SENTINEL }),
    ).toBeUndefined();
    expect(renderActivityEvent(render, { type: "thinking", subtype: "completed" })).toBeUndefined();
    expect(
      renderActivityEvent(render, {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "cursor review text" }] },
      }),
    ).toBe("cursor review text");
    // tool_call event shape is unverified; the payload-free marker is safe.
    expect(
      renderActivityEvent(render, { type: "tool_call", subtype: "started", args: SENTINEL }),
    ).toBe("[tool_call]");
    // Cursor result events carry no num_turns; the summary just omits turns.
    expect(
      renderActivityEvent(render, { type: "result", subtype: "success", duration_ms: 12 }),
    ).toBe("[result:success duration_ms=12]");
  });

  it("aliases the claude-sdk dialect to the claude stream renderer", () => {
    // Claude Agent SDK messages are structurally identical to parsed CLI
    // stream-json lines, so the dialect is an alias, not a fork.
    expect(activityRenderer("claude-sdk")).toBe(claudeStreamEventText);
  });

  it("forks the droid-sdk dialect from the droid CLI renderer", () => {
    // The Droid SDK's stream shapes differ from the CLI's stream-json
    // envelope, so droid-sdk is a fork (see droidSdkStreamEventText).
    expect(activityRenderer("droid-sdk")).toBe(droidSdkStreamEventText);
    expect(droidSdkStreamEventText).not.toBe(droidStreamEventText);
  });

  it("renders droid-sdk assistant content blocks, dropping thinking blocks", () => {
    const rendered = renderActivityEvent(droidSdkStreamEventText, {
      type: "assistant",
      text: `${SENTINEL} aggregated text is never read`,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: SENTINEL },
          { type: "text", text: "checking the diff" },
          { type: "tool_use", name: "read_file", input: { path: SENTINEL } },
        ],
      },
    });
    expect(rendered).toBe("checking the diff\n[tool_use read_file]");
  });

  it("reduces droid-sdk user, tool, and result events to safe markers", () => {
    expect(
      renderActivityEvent(droidSdkStreamEventText, {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "abcdefgh" }] },
      }),
    ).toBe("[user message 35 chars]");
    expect(
      renderActivityEvent(droidSdkStreamEventText, {
        type: "tool_call",
        toolUse: { type: "tool_use", name: "grep", input: { pattern: SENTINEL } },
      }),
    ).toBe("[tool_use grep]");
    expect(
      renderActivityEvent(droidSdkStreamEventText, {
        type: "tool_result",
        toolName: "grep",
        content: "abcdefgh",
        isError: false,
      }),
    ).toBe("[tool_result 8 chars]");
    expect(
      renderActivityEvent(droidSdkStreamEventText, {
        type: "result",
        subtype: "success",
        numTurns: 3,
        durationMs: 42,
        text: SENTINEL,
        messages: [{ type: "assistant", text: SENTINEL }],
      }),
    ).toBe("[result:success turns=3 duration_ms=42]");
    // The SDK emits both numTurns and turnCount; either key renders turns.
    expect(
      renderActivityEvent(droidSdkStreamEventText, {
        type: "result",
        subtype: "success",
        turnCount: 2,
        durationMs: 7,
      }),
    ).toBe("[result:success turns=2 duration_ms=7]");
  });

  it("reduces droid user messages to size markers", () => {
    const rendered = renderActivityEvent(droidStreamEventText, {
      type: "message",
      role: "user",
      text: "review prompt",
    });
    expect(rendered).toBe("[user message 13 chars]");
  });

  it("renders codex completed agent messages verbatim and lifecycle events as markers", () => {
    expect(renderActivityEvent(codexJsonEventText, { type: "thread.started" })).toBe(
      "[thread.started]",
    );
    expect(renderActivityEvent(codexJsonEventText, { type: "turn.started" })).toBe(
      "[turn.started]",
    );
    expect(
      renderActivityEvent(codexJsonEventText, {
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "final review text" },
      }),
    ).toBe("final review text");
    expect(renderActivityEvent(codexJsonEventText, { type: "turn.completed" })).toBe(
      "[turn.completed]",
    );
  });

  it("dedupes codex item updates by rendering payloads only at item.completed", () => {
    for (const type of ["item.started", "item.updated"]) {
      expect(
        renderActivityEvent(codexJsonEventText, {
          type,
          item: { id: "item_2", type: "agent_message", text: SENTINEL },
        }),
      ).toBeUndefined();
    }
  });

  it("drops codex reasoning items and truncates command output to size markers", () => {
    expect(
      renderActivityEvent(codexJsonEventText, {
        type: "item.completed",
        item: { id: "item_0", type: "reasoning", text: SENTINEL },
      }),
    ).toBeUndefined();
    expect(
      renderActivityEvent(codexJsonEventText, {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "rg diff",
          aggregated_output: "abcdefgh",
        },
      }),
    ).toBe("[command_execution 8 chars]");
    expect(
      renderActivityEvent(codexJsonEventText, {
        type: "item.completed",
        item: { id: "item_3", type: "file_change" },
      }),
    ).toBe("[file_change]");
  });

  it("renders opencode text from the nested part payload", () => {
    expect(
      renderActivityEvent(opencodeJsonEventText, {
        type: "text",
        part: { type: "text", text: "looking at the diff" },
      }),
    ).toBe("looking at the diff");
    // A top-level text field is not the payload location; nothing renders.
    expect(
      renderActivityEvent(opencodeJsonEventText, { type: "text", text: SENTINEL }),
    ).toBeUndefined();
  });

  it("reduces opencode tool parts to name and size markers", () => {
    expect(
      renderActivityEvent(opencodeJsonEventText, {
        type: "tool",
        part: {
          type: "tool",
          tool: "grep",
          state: { status: "completed", input: { pattern: "x" }, output: "abcdefgh" },
        },
      }),
    ).toBe("[tool_use grep] [input 15 chars] [output 8 chars]");
    expect(
      renderActivityEvent(opencodeJsonEventText, {
        type: "step_finish",
        part: { type: "step_finish", reason: "stop" },
      }),
    ).toBe("[step_finish reason=stop]");
    expect(
      renderActivityEvent(opencodeJsonEventText, {
        type: "reasoning",
        part: { type: "reasoning", text: SENTINEL },
      }),
    ).toBeUndefined();
  });

  it("renders copilot assistant messages with content and tool-request markers", () => {
    expect(
      renderActivityEvent(copilotJsonEventText, {
        type: "assistant.message",
        data: {
          content: "reviewing the patch",
          toolRequests: [{ name: "grep_search" }],
          sessionId: SENTINEL,
          requestId: SENTINEL,
          apiCallId: SENTINEL,
        },
      }),
    ).toBe("reviewing the patch\n[tool_use grep_search]");
  });

  it("skips copilot delta and ephemeral events and reduces sub-agent messages to markers", () => {
    expect(
      renderActivityEvent(copilotJsonEventText, {
        type: "assistant.message_delta",
        data: { content: SENTINEL },
      }),
    ).toBeUndefined();
    expect(
      renderActivityEvent(copilotJsonEventText, { type: "ephemeral", data: { text: SENTINEL } }),
    ).toBeUndefined();
    expect(
      renderActivityEvent(copilotJsonEventText, {
        type: "assistant.message",
        agentId: "agent-1",
        data: { content: SENTINEL },
      }),
    ).toBe("[assistant.message]");
    expect(
      renderActivityEvent(copilotJsonEventText, {
        type: "session.error",
        data: { message: SENTINEL },
      }),
    ).toBe("[session.error]");
  });

  it("renders pi assistant text parts only, dropping thinking parts", () => {
    expect(
      renderActivityEvent(piJsonEventText, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: SENTINEL },
            { type: "text", text: "pi review text" },
          ],
        },
      }),
    ).toBe("pi review text");
  });

  it("drops pi message_update and reduces user and tool payloads to markers", () => {
    expect(
      renderActivityEvent(piJsonEventText, {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: SENTINEL }] },
      }),
    ).toBeUndefined();
    expect(
      renderActivityEvent(piJsonEventText, {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "abcdefgh" }] },
      }),
    ).toBe("[user message 35 chars]");
    expect(
      renderActivityEvent(piJsonEventText, {
        type: "message_end",
        message: { role: "toolResult", content: [{ type: "text", text: "abcdefgh" }] },
      }),
    ).toBe("[toolResult message 35 chars]");
    expect(
      renderActivityEvent(piJsonEventText, { type: "tool_execution_start", toolName: "read" }),
    ).toBe("[tool_execution_start read]");
    expect(
      renderActivityEvent(piJsonEventText, {
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: SENTINEL }] }],
      }),
    ).toBe("[agent_end]");
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
