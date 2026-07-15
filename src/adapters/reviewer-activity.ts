/**
 * Shared reviewer-activity rendering for debug output.
 *
 * Turns already-parsed engine events into the same bounded one-line summaries
 * the CLI stream mode ships (assistant text verbatim, `[tool_use X]` markers,
 * reasoning excluded). Two policies are structural here, not conventional:
 *
 * - Reasoning exclusion: `renderActivityEvent` drops any event whose
 *   type/method matches /reasoning|thinking|thought/i BEFORE the dialect
 *   renderer runs, so no renderer can forget it under protocol drift.
 * - Debug never fails the review: every sink method swallows, and renderer
 *   throws degrade to a payload-free `[<type>]` marker.
 *
 * Structural prose invariant (enforced by test/reviewer-activity.test.ts):
 * only the per-dialect assistant-text extractors may return engine-authored
 * prose, and each renders only its named allowlisted fields. Everything else
 * is a payload-free marker or a size marker.
 */

import type { ReviewAdapterInput } from "./types.js";

/**
 * Rendering dialects. Extended as adapters gain debug output; SDK and
 * app-server dialects land with their adapter wiring. The `-json` dialects
 * cover CLIs whose default review invocation already emits JSONL (no
 * invocation switch involved).
 */
export type ActivityDialect =
  | "claude-stream-json"
  | "cursor-stream-json"
  | "droid-stream-json"
  | "grok-streaming-json"
  | "codex-json"
  | "codex-app-server"
  | "opencode-json"
  | "copilot-json"
  | "pi-json"
  | "antigravity-transcript"
  | "claude-sdk"
  | "cursor-sdk"
  | "droid-sdk"
  | "copilot-sdk"
  | "pi-sdk";

/** Rendered summary line, or undefined to drop the event silently. */
export type ActivityRenderer = (event: Record<string, unknown>) => string | undefined;

export type ReviewerActivitySink = {
  /** One parsed engine event. Never throws; failures drop the event. */
  event(event: unknown): void;
  /** Adapter-synthesized marker line (e.g. "[request X -> declined]"). */
  note(text: string): void;
  /** Flush buffered state. Idempotent; call in the adapter's finally. */
  end(): void;
};

const reasoningTypePattern = /reasoning|thinking|thought/i;

/** Marker-embedded metadata (tool names) is bounded independently of the recorder budget. */
const maxMarkerNameChars = 128;

export function activityRenderer(dialect: ActivityDialect): ActivityRenderer {
  const renderers: Record<ActivityDialect, ActivityRenderer> = {
    "claude-stream-json": claudeStreamEventText,
    "cursor-stream-json": cursorStreamEventText,
    "droid-stream-json": droidStreamEventText,
    "grok-streaming-json": grokStreamingJsonEventText,
    "codex-json": codexJsonEventText,
    "codex-app-server": codexAppServerNotificationText,
    "opencode-json": opencodeJsonEventText,
    "copilot-json": copilotJsonEventText,
    "pi-json": piJsonEventText,
    // Stateful (last-seen tool names): the map literal is rebuilt per call, so
    // every activityRenderer() invocation hands out a fresh instance.
    "antigravity-transcript": createAntigravityTranscriptRenderer(),
    // SDKMessage objects are structurally identical to parsed CLI stream-json
    // lines, so the claude renderer applies verbatim.
    "claude-sdk": claudeStreamEventText,
    "cursor-sdk": cursorSdkStepText,
    "droid-sdk": droidSdkStreamEventText,
    "copilot-sdk": copilotSessionEventText,
    "pi-sdk": piSessionEventText,
  };
  return renderers[dialect];
}

/**
 * Shared policy choke point: universal reasoning drop plus never-throw.
 * The type/method is extracted once into a local inside its own try/catch
 * (a hostile getter drops the event and is never re-read); a renderer throw
 * degrades to a payload-free marker built from that pre-extracted local only.
 */
export function renderActivityEvent(render: ActivityRenderer, event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  let type: string | undefined;
  try {
    type = stringField(event, "type") ?? stringField(event, "method"); // method: JSON-RPC dialects
  } catch {
    return undefined; // hostile getter: drop, never re-read
  }
  if (type !== undefined && reasoningTypePattern.test(type)) {
    return undefined;
  }
  try {
    return render(event);
  } catch {
    return type !== undefined ? `[${type}]` : undefined; // uses the pre-extracted local only
  }
}

export function createReviewerActivitySink(
  dialect: ActivityDialect,
  emit: (text: string) => void,
): ReviewerActivitySink {
  const render = activityRenderer(dialect);
  return {
    event(event) {
      try {
        const text = renderActivityEvent(render, event);
        if (text !== undefined && text !== "") {
          emit(text);
        }
      } catch {
        // Debug never fails the review.
      }
    },
    note(text) {
      try {
        emit(text);
      } catch {
        // Debug never fails the review.
      }
    },
    end() {
      try {
        // No buffered state: dialects that coalesce deltas wire
        // createDeltaCoalescer at the stream-parser layer (cli-stream.ts).
      } catch {
        // Debug never fails the review.
      }
    },
  };
}

/** Undefined when the run did not opt in — adapters write `activity?.event(e)`. */
export function activitySinkFromDebugOutput(
  dialect: ActivityDialect,
  debugOutput: ReviewAdapterInput["debugOutput"],
): ReviewerActivitySink | undefined {
  if (debugOutput === undefined) {
    return undefined;
  }
  return createReviewerActivitySink(dialect, (line) => {
    debugOutput.onChunk("stdout", `${line}\n`);
  });
}

/**
 * One safe summary line per Claude stream-json event. Assistant text is
 * surfaced verbatim; thinking blocks are dropped; tool payloads are reduced to
 * names/sizes so transcripts stay compact and reasoning stays private.
 * Top-level reasoning/thinking-typed events never reach this renderer — they
 * are dropped by renderActivityEvent.
 */
export function claudeStreamEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type === "system") {
    const subtype = stringField(event, "subtype") ?? "event";
    return `[system:${subtype}]`;
  }

  if (type === "assistant" || type === "user") {
    const message = isRecord(event.message) ? event.message : event;
    return renderClaudeContentBlocks(message.content);
  }

  if (type === "result") {
    const subtype = stringField(event, "subtype") ?? "unknown";
    const turns = numberField(event, "num_turns");
    const durationMs = numberField(event, "duration_ms");
    return `[result:${subtype}${turns !== undefined ? ` turns=${turns}` : ""}${
      durationMs !== undefined ? ` duration_ms=${durationMs}` : ""
    }]`;
  }

  return `[${type}]`;
}

/**
 * Shared content-block allowlist: only text, tool_use, and tool_result blocks
 * render; thinking/redacted_thinking/unknown block types drop silently, so new
 * block types produce nothing, never payloads.
 */
export function renderClaudeContentBlocks(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() === "" ? undefined : content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const blockType = stringField(block, "type");
    if (blockType === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      parts.push(block.text);
    } else if (blockType === "tool_use") {
      parts.push(toolUseMarker(typeof block.name === "string" ? block.name : undefined));
    } else if (blockType === "tool_result") {
      parts.push(sizeMarker("tool_result", contentSize(block.content)));
    }
    // thinking / redacted_thinking blocks are intentionally dropped.
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * One safe summary line per Cursor stream-json event. Cursor's envelope
 * matches Claude's (live-verified 2026-07-15: system events with a subtype,
 * assistant events with message content blocks, and a result event keyed by
 * subtype/duration_ms — no num_turns, so the summary omits turns), so those
 * render through claudeStreamEventText. The one live-observed divergence:
 * cursor re-echoes the review prompt as a `user` text event, so user events
 * reduce to a size marker like droid's — rendering the echoed prompt verbatim
 * would burn the bounded debug budget on our own prompt. Cursor's top-level
 * `thinking` delta events never reach this renderer (universal reasoning
 * drop), and unverified shapes (e.g. tool_call, never captured with a
 * triggered tool) degrade to the payload-free `[type]` marker.
 */
export function cursorStreamEventText(event: Record<string, unknown>): string | undefined {
  if (stringField(event, "type") === "user") {
    const message = isRecord(event.message) ? event.message : event;
    return sizeMarker("user message", contentSize(message.content ?? ""));
  }
  return claudeStreamEventText(event);
}

/**
 * One safe summary line per Cursor SDK ConversationStep (the typed `onStep`
 * callback on `agent.send()`). Not shared with cursor-stream-json: steps are
 * already synthesized summaries, not Claude-shaped envelopes. The step union
 * carries exactly three types today (live-verified 2026-07-15):
 *
 * - `assistantMessage` — `message.text` verbatim. Steps are message-granular
 *   (the SDK's accumulator coalesces deltas before firing), so no delta
 *   coalescer is needed.
 * - `thinkingMessage` — verbatim reasoning; the universal reasoning drop
 *   removes it before this renderer runs (the type matches /thinking/i).
 * - `toolCall` — `message.type` names the tool (read/grep/shell/...);
 *   `message.args` and `message.result` embed file paths and raw file
 *   contents (the live-captured read result carried the full file body), so
 *   only the bounded tool name renders, with mcp calls surfacing the bounded
 *   server tool name as `[tool_use mcp:<toolName>]`.
 *
 * onStep never fires for user messages today, but cursor echoes the review
 * prompt on its CLI stream surface, so any user-flavored step type that ever
 * appears reduces to a size marker (mirroring cursor-stream-json). Unknown
 * future step types degrade to payload-free `[<type>]` markers.
 */
export function cursorSdkStepText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  const message = isRecord(event.message) ? event.message : undefined;

  if (type === "assistantMessage") {
    const text = message === undefined ? undefined : stringField(message, "text");
    return text === undefined || text.trim() === "" ? undefined : text;
  }

  if (type === "toolCall") {
    if (message === undefined) {
      return `[${type}]`;
    }
    const toolType = stringField(message, "type");
    if (toolType === "mcp") {
      const args = isRecord(message.args) ? message.args : undefined;
      const toolName = args === undefined ? undefined : stringField(args, "toolName");
      return toolUseMarker(toolName === undefined ? "mcp" : `mcp:${toolName}`);
    }
    return toolUseMarker(toolType);
  }

  if (/user/i.test(type)) {
    // The echoed user message would be our own review prompt; size marker only.
    const text = message === undefined ? undefined : stringField(message, "text");
    return sizeMarker("user message", contentSize(text ?? message ?? ""));
  }

  return `[${type}]`;
}

/**
 * One safe summary line per Droid stream-json event. The echoed user message
 * is our own review prompt, so it is reduced to a size marker.
 * Reasoning-flavored event types never reach this renderer — they are dropped
 * by renderActivityEvent.
 */
export function droidStreamEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type === "system") {
    const subtype = stringField(event, "subtype") ?? "event";
    return `[system:${subtype}]`;
  }

  if (type === "message") {
    const role = stringField(event, "role");
    const text = typeof event.text === "string" ? event.text : undefined;
    if (role === "assistant") {
      return text === undefined || text.trim() === "" ? undefined : text;
    }
    return sizeMarker(`${role ?? "message"} message`, text?.length ?? 0);
  }

  if (type === "completion") {
    const turns = numberField(event, "numTurns");
    const durationMs = numberField(event, "durationMs");
    return `[completion${turns !== undefined ? ` turns=${turns}` : ""}${
      durationMs !== undefined ? ` duration_ms=${durationMs}` : ""
    }]`;
  }

  const name = stringField(event, "name") ?? stringField(event, "tool");
  return `[${type}${name !== undefined ? ` ${boundedMarkerName(name)}` : ""}]`;
}

/**
 * One safe summary line per Droid SDK stream message (the default non-partial
 * `session.stream()` overload). Forked from droidStreamEventText rather than
 * aliased: the SDK's DroidStreamMessage shapes differ from the CLI's
 * stream-json envelope (verified against @factory/droid-sdk types) —
 * assistant/user events carry a Claude-shaped `message.content` block array
 * instead of role/text fields, tool activity arrives as tool_call/tool_result
 * events, and the terminal event is `result` (numTurns/durationMs), not
 * `completion`. Assistant prose renders through the shared content-block
 * allowlist, so thinking blocks drop structurally; thinking_* event types only
 * exist in the partial overload but the universal reasoning regex drops them
 * anyway if that ever drifts.
 */
export function droidSdkStreamEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type === "assistant") {
    const message = isRecord(event.message) ? event.message : undefined;
    return message === undefined ? undefined : renderClaudeContentBlocks(message.content);
  }

  if (type === "user") {
    // The echoed user message is our own review prompt; size marker only.
    const message = isRecord(event.message) ? event.message : event;
    return sizeMarker("user message", contentSize(message.content ?? ""));
  }

  if (type === "tool_call") {
    const toolUse = isRecord(event.toolUse) ? event.toolUse : undefined;
    return toolUseMarker(toolUse === undefined ? undefined : stringField(toolUse, "name"));
  }

  if (type === "tool_result") {
    return sizeMarker("tool_result", contentSize(event.content ?? ""));
  }

  if (type === "result") {
    const subtype = stringField(event, "subtype") ?? "unknown";
    // The SDK's DroidResultBase declares BOTH numTurns and turnCount and its
    // implementation emits both with the same value; either key works here.
    const turns = numberField(event, "numTurns") ?? numberField(event, "turnCount");
    const durationMs = numberField(event, "durationMs");
    return `[result:${subtype}${turns !== undefined ? ` turns=${turns}` : ""}${
      durationMs !== undefined ? ` duration_ms=${durationMs}` : ""
    }]`;
  }

  const name = stringField(event, "toolName");
  return `[${type}${name !== undefined ? ` ${boundedMarkerName(name)}` : ""}]`;
}

/**
 * One safe summary line per Grok streaming-json event (the CLI spells the
 * --output-format value `streaming-json`, not claude's `stream-json`). The
 * stream carries exactly three event types (live-verified 2026-07-15,
 * including a tool-using multi-turn re-probe: tool calls execute without
 * emitting any stream event, so no tool-call/tool-result shapes exist):
 *
 * - `thought` — verbatim reasoning deltas; the universal reasoning drop
 *   removes them before this renderer runs.
 * - `text` — token-level answer deltas in `.data`. Dropped here: rendering
 *   per event would emit one debug line per token, so the stream layer
 *   coalesces them into blocks through createDeltaCoalescer (cli-stream.ts).
 * - `end` — terminal summary (stopReason/usage/num_turns, no answer text);
 *   reduces to an `[end:...]` marker.
 *
 * Unknown future event types degrade to payload-free `[<type>]` markers.
 */
export function grokStreamingJsonEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type === "text") {
    return undefined; // coalesced at the stream layer, never rendered per token
  }

  if (type === "end") {
    const stopReason = stringField(event, "stopReason");
    const turns = numberField(event, "num_turns");
    return `[end${stopReason !== undefined ? `:${boundedMarkerName(stopReason)}` : ""}${
      turns !== undefined ? ` turns=${turns}` : ""
    }]`;
  }

  return `[${type}]`;
}

/**
 * Generic delta coalescer for token-level streaming dialects (the design
 * doc's phase-2 coalescer; grok's streaming-json `text` deltas are the first
 * consumer, app-server agentMessage deltas are the planned second). Deltas
 * append into a per-item buffer keyed by the caller's item key, and each
 * buffered block is emitted exactly once: on an item-key transition, on an
 * explicit flush (terminal event / stream close), or early when the buffer
 * reaches the cap (bounding memory on unbounded streams). Emitted-length
 * dedupe holds by construction — drained content leaves the buffer, so
 * repeated flushes or a transition right after a cap overflow can never
 * re-emit already-emitted chars.
 */
export type DeltaCoalescer = {
  /**
   * Append one delta for an item; returns any blocks completed by this push
   * (the previous item's pending block on an item-key transition, and/or an
   * early block when the buffer reaches the cap).
   */
  push(itemKey: string, delta: string): string[];
  /** Drain the pending block (terminal event / stream close). Idempotent. */
  flush(): string[];
};

/** Explicit per-item buffer cap for createDeltaCoalescer (~64 KiB). */
export const deltaCoalescerBufferCapChars = 64 * 1024;

export function createDeltaCoalescer(
  maxBufferChars = deltaCoalescerBufferCapChars,
): DeltaCoalescer {
  let currentKey: string | undefined;
  let buffer = "";

  function drainPending(out: string[]): void {
    if (buffer !== "") {
      out.push(buffer);
      buffer = "";
    }
  }

  return {
    push(itemKey, delta) {
      const out: string[] = [];
      if (itemKey !== currentKey) {
        drainPending(out);
        currentKey = itemKey;
      }
      buffer += delta;
      if (buffer.length >= maxBufferChars) {
        drainPending(out);
      }
      return out;
    },
    flush() {
      const out: string[] = [];
      drainPending(out);
      currentKey = undefined;
      return out;
    },
  };
}

/**
 * One safe summary line per Codex `--json` event. Only completed
 * `agent_message` items surface prose (each one verbatim; the final answer is
 * the last). `item.started`/`item.updated` are dropped entirely so payloads
 * render at most once, at `item.completed` (dedupe by construction, no state).
 * `command_execution.aggregated_output` is unbounded and can echo file
 * contents, so it reduces to a size marker. Reasoning-typed items are nested
 * under `item.type`, out of reach of the universal top-level drop, so they are
 * dropped here explicitly.
 */
export function codexJsonEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type === "item.started" || type === "item.updated") {
    return undefined; // payload renders once, at item.completed
  }

  if (type === "item.completed") {
    const item = isRecord(event.item) ? event.item : undefined;
    const itemType =
      item === undefined
        ? undefined
        : (stringField(item, "type") ?? stringField(item, "item_type"));
    if (item === undefined || itemType === undefined) {
      return `[${type}]`;
    }
    if (reasoningTypePattern.test(itemType)) {
      return undefined;
    }
    if (itemType === "agent_message") {
      const text = typeof item.text === "string" ? item.text : undefined;
      return text === undefined || text.trim() === "" ? undefined : text;
    }
    if (itemType === "command_execution") {
      return sizeMarker("command_execution", contentSize(item.aggregated_output ?? ""));
    }
    return `[${boundedMarkerName(itemType)}]`;
  }

  return `[${type}]`; // thread.started, turn.started, turn.completed, turn.failed, error
}

/**
 * One safe summary line per Codex app-server JSON-RPC notification, keyed on
 * `method` (renderActivityEvent's universal reasoning drop inspects `method`
 * too, so reasoning-flavored methods never reach this renderer — the app-server
 * API is experimental and method drift is expected). v1 policy:
 *
 * - `item/agentMessage/delta` drops entirely: reply assembly consumes deltas,
 *   and prose renders once, at `item/completed` (no coalescer in v1).
 * - Completed `agentMessage` items surface `item.text` verbatim, and completed
 *   `exitedReviewMode` items surface their `review` text verbatim (native
 *   review mode; the structured-JSON duplication matches the codex-json CLI
 *   dialect's accepted precedent). Reasoning-typed items are nested under
 *   `item.type`, out of reach of the universal top-level drop, so they are
 *   dropped here explicitly.
 * - Every other item type reduces to an `[item:<type>]` marker —
 *   `aggregated_output` is unbounded and can echo file contents, so it is
 *   never read.
 * - `thread/tokenUsage/updated` drops entirely; `error` reduces to a
 *   payload-free retryability marker; unknown methods render `[<method>]`
 *   with params dropped.
 */
export function codexAppServerNotificationText(event: Record<string, unknown>): string | undefined {
  // JSON-RPC notifications carry `method`; the `type` fallback keeps the
  // shared unknown-shape invariant (`[<type>]` marker) for typed events.
  const method = stringField(event, "method") ?? stringField(event, "type");
  if (method === undefined) {
    return undefined;
  }

  if (method === "item/agentMessage/delta" || method === "thread/tokenUsage/updated") {
    return undefined;
  }

  if (method === "item/completed") {
    const params = isRecord(event.params) ? event.params : undefined;
    const item = params !== undefined && isRecord(params.item) ? params.item : undefined;
    const itemType = item === undefined ? undefined : stringField(item, "type");
    if (item === undefined || itemType === undefined) {
      return `[${method}]`;
    }
    if (reasoningTypePattern.test(itemType)) {
      return undefined;
    }
    if (itemType === "agentMessage") {
      const text = typeof item.text === "string" ? item.text : undefined;
      return text === undefined || text.trim() === "" ? undefined : text;
    }
    if (itemType === "exitedReviewMode") {
      const review = typeof item.review === "string" ? item.review : undefined;
      return review === undefined || review.trim() === "" ? undefined : review;
    }
    return `[item:${boundedMarkerName(itemType)}]`; // never aggregated_output
  }

  if (method === "turn/completed") {
    return "[turn:completed]";
  }

  if (method === "error") {
    const willRetry = isRecord(event.params) && event.params.willRetry === true;
    return `[error willRetry=${willRetry}]`;
  }

  return `[${method}]`;
}

/**
 * One safe summary line per OpenCode `--format json` event. Every payload
 * nests under `.part` (a top-level-field summarizer misses `part.text`), so
 * assistant prose is read from `part.text` only. Tool parts reduce to a name
 * marker plus input/output size markers, and `reasoning` parts (only emitted
 * under `--thinking`, which review runs never pass) are dropped defensively.
 */
export function opencodeJsonEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  const part = isRecord(event.part) ? event.part : undefined;
  const partType = (part !== undefined ? stringField(part, "type") : undefined) ?? type;
  if (reasoningTypePattern.test(partType)) {
    return undefined;
  }

  if (partType === "text") {
    const text = part !== undefined && typeof part.text === "string" ? part.text : undefined;
    return text === undefined || text.trim() === "" ? undefined : text;
  }

  if (partType === "tool" || partType === "tool_use") {
    const name =
      part === undefined ? undefined : (stringField(part, "tool") ?? stringField(part, "name"));
    const state = part !== undefined && isRecord(part.state) ? part.state : undefined;
    const markers = [toolUseMarker(name)];
    if (state?.input !== undefined) {
      markers.push(sizeMarker("input", contentSize(state.input)));
    }
    if (state?.output !== undefined) {
      markers.push(sizeMarker("output", contentSize(state.output)));
    }
    return markers.join(" ");
  }

  if (partType === "step_finish" || partType === "step-finish") {
    const reason =
      (part !== undefined ? stringField(part, "reason") : undefined) ??
      stringField(event, "reason");
    return `[${partType}${reason !== undefined ? ` reason=${boundedMarkerName(reason)}` : ""}]`;
  }

  return `[${type}]`;
}

/**
 * One safe summary line per Copilot CLI `--output-format json` event, with a
 * strict allowlist posture: only root `assistant.message` events surface prose
 * (`data.content` verbatim plus payload-free tool-request markers). Delta and
 * ephemeral events are skipped entirely — they re-carry message content and
 * would duplicate it — and embedded ids (sessionId/requestId/apiCallId) are
 * never read, so they can never render.
 */
export function copilotJsonEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type.includes("delta") || type.includes("ephemeral")) {
    return undefined; // duplication hazard: content re-arrives on assistant.message
  }

  if (type === "assistant.message") {
    // Sub-agent events (agentId) never surface prose; reviews disable subagents anyway.
    const agentId = event.agentId;
    const data = isRecord(event.data) ? event.data : undefined;
    if ((typeof agentId === "string" && agentId.trim() !== "") || data === undefined) {
      return `[${type}]`;
    }
    const parts: string[] = [];
    const content = renderClaudeContentBlocks(data.content);
    if (content !== undefined) {
      parts.push(content);
    }
    if (Array.isArray(data.toolRequests)) {
      for (const request of data.toolRequests) {
        if (isRecord(request)) {
          parts.push(
            toolUseMarker(
              stringField(request, "name") ??
                stringField(request, "toolName") ??
                stringField(request, "tool"),
            ),
          );
        }
      }
    }
    return parts.length === 0 ? undefined : parts.join("\n");
  }

  return `[${type}]`;
}

/**
 * One safe summary line per Copilot SDK SessionEvent, forked from the CLI
 * copilot-json dialect with the same strict allowlist posture: only
 * `assistant.message` events surface prose (`data.content` verbatim plus one
 * payload-free `[tool_use <name>]` marker per `data.toolRequests[]` entry).
 * `assistant.message_delta` and ANY event flagged `ephemeral` are dropped
 * entirely — deltas repeat the final message text, so rendering them would
 * duplicate prose — and embedded ids and reasoning fields
 * (sessionId/requestId/apiCallId/reasoningText/encryptedContent) are never
 * read, so they can never render. Reasoning-typed events, including sub-agent
 * `assistant.reasoning*` variants, are dropped by the universal reasoning
 * regex before this renderer runs. Unlike the CLI dialect, sub-agent
 * assistant messages surface prose behind a bounded `[agent <agentId>] `
 * prefix (user-decided 2026-07-15); every other sub-agent event reduces to a
 * payload-free `[subagent <type>]` marker.
 */
export function copilotSessionEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  // Duplication hazard: deltas and ephemeral events re-carry message content
  // that arrives again on the final assistant.message. The flag check is
  // truthy on purpose — dropping more is the safe direction for debug output.
  if (type.includes("delta") || type.includes("ephemeral") || Boolean(event.ephemeral)) {
    return undefined;
  }

  // agentId is untrusted: only a non-blank string counts, bounded like tool names.
  const agentId = stringField(event, "agentId");
  const agentMarker =
    agentId !== undefined && agentId.trim() !== ""
      ? `[agent ${boundedMarkerName(agentId)}]`
      : undefined;

  if (type === "assistant.message") {
    const data = isRecord(event.data) ? event.data : undefined;
    if (data === undefined) {
      return agentMarker === undefined ? `[${type}]` : `[subagent ${type}]`;
    }
    const parts: string[] = [];
    if (typeof data.content === "string" && data.content.trim() !== "") {
      parts.push(data.content);
    }
    if (Array.isArray(data.toolRequests)) {
      for (const request of data.toolRequests) {
        parts.push(toolUseMarker(isRecord(request) ? stringField(request, "name") : undefined));
      }
    }
    if (parts.length === 0) {
      return undefined;
    }
    const rendered = parts.join("\n");
    return agentMarker === undefined ? rendered : `${agentMarker} ${rendered}`;
  }

  if (agentMarker !== undefined) {
    return `[subagent ${type}]`;
  }

  if (type === "user.message") {
    // The echoed user message is our own review prompt; size marker only.
    const data = isRecord(event.data) ? event.data : undefined;
    return sizeMarker("user message", contentSize(data?.content ?? ""));
  }

  return `[${type}]`; // session lifecycle, assistant.usage, unknown types
}

/**
 * One safe summary line per Pi `--mode json` event. `message_update` re-embeds
 * the full message on every delta (O(n^2) duplication), so it is dropped
 * outright. Assistant messages surface their text parts only (thinking parts
 * never render); user messages echo the whole review diff and toolResult
 * payloads carry raw file contents, so both reduce to size markers. Everything
 * else — including `agent_end`/`turn_end`, whose embedded message arrays carry
 * thinking parts — renders as a payload-free marker.
 */
export function piJsonEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type === "message_update") {
    return undefined; // re-embeds the full message per delta
  }

  if (type === "message" || type === "message_start" || type === "message_end") {
    const message = isRecord(event.message) ? event.message : event;
    const role = stringField(message, "role");
    if (role === "assistant") {
      return piAssistantTextParts(message.content);
    }
    return sizeMarker(`${role ?? "message"} message`, contentSize(message.content ?? ""));
  }

  const name = stringField(event, "toolName") ?? stringField(event, "tool_name");
  return `[${type}${name !== undefined ? ` ${boundedMarkerName(name)}` : ""}]`;
}

/**
 * One safe summary line per Pi SDK `AgentSession.subscribe` event. Forked from
 * the pi-json CLI dialect rather than shared: the SDK's typed AgentEvent union
 * carries tool activity as `tool_execution_*` events (top-level toolName) that
 * reduce to `[tool_use <name>]`/`[tool_result]` markers, and tool-result
 * message artifacts reduce to a bare `[tool_result]` marker because their
 * payloads carry raw tool output (file contents). The shared hazards match
 * pi-json:
 *
 * - `message_update` re-embeds the full accumulated message on every delta
 *   (O(n^2) duplication), so it is dropped outright — no delta coalescer;
 *   pi debug output is terminal-message-granular by design.
 * - Assistant prose renders once, at `message_end` (text parts only, thinking
 *   parts drop); `message_start` carries the in-progress shell of the same
 *   message and never renders prose.
 * - User messages echo the full review prompt including the diff, so they
 *   reduce to `[user message N chars]` size markers.
 * - `agent_end`/`turn_end` embed full message arrays (thinking parts included)
 *   that never render — bare markers only.
 *
 * Everything else (queue_update, compaction_*, auto_retry_*, unknown future
 * types) is a payload-free `[<type>]` marker.
 */
export function piSessionEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }

  if (type === "message_update") {
    return undefined; // re-embeds the full accumulated message per delta
  }

  if (type === "message_start" || type === "message_end") {
    const message = isRecord(event.message) ? event.message : undefined;
    if (message === undefined) {
      return `[${type}]`;
    }
    const role = stringField(message, "role");
    if (role === "assistant") {
      // Prose renders once, at message_end (dedupe by construction).
      return type === "message_end" ? piAssistantTextParts(message.content) : undefined;
    }
    if (role === "toolResult") {
      return "[tool_result]"; // payload carries raw tool output
    }
    return sizeMarker(`${role ?? "message"} message`, contentSize(message.content ?? ""));
  }

  if (type === "tool_execution_start") {
    return toolUseMarker(stringField(event, "toolName"));
  }
  if (type === "tool_execution_update") {
    return undefined; // partialResult streams per delta; markers render at start/end
  }
  if (type === "tool_execution_end") {
    return "[tool_result]";
  }

  // agent_start/agent_end/turn_start/turn_end (their embedded messages never
  // render), queue_update, compaction_*, auto_retry_*, and unknown types.
  return `[${type}]`;
}

/** Text parts only: thinking/toolCall/unknown parts drop silently. */
function piAssistantTextParts(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() === "" ? undefined : content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      stringField(block, "type") === "text" &&
      typeof block.text === "string" &&
      block.text.trim() !== ""
    ) {
      parts.push(block.text);
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * Typed tool-execution events observed in the agy transcript JSONL
 * (live-verified 2026-07-15). Their payloads carry command output and file
 * contents and never render.
 */
const antigravityToolEventTypes = new Set([
  "RUN_COMMAND",
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "GREP_SEARCH",
  "SEARCH_WEB",
  "CODE_ACTION",
  "GENERIC",
]);

/** Bounds the last-seen tool-name state so a hostile transcript cannot grow it. */
const maxAntigravityPendingToolNames = 16;

/**
 * One safe summary line per Antigravity transcript event (the JSONL agy
 * live-appends under the review's isolated HOME; see
 * antigravity-transcript.ts for the tailer). Stateful — unlike the other
 * dialects, tool names arrive on `PLANNER_RESPONSE.tool_calls[].name` while
 * the typed tool events that follow carry only payloads, so the renderer
 * keeps a small FIFO of last-seen tool names — hence the factory. Policy:
 *
 * - `PLANNER_RESPONSE` surfaces `content` verbatim (the intermediate/final
 *   assistant prose). Its optional `thinking` field is markdown
 *   chain-of-thought that never appears on stdout and is dropped entirely
 *   (never read beyond the allowlisted `content`/`tool_calls[].name`).
 * - Typed tool events reduce to `[tool_use <name>]` markers, the name taken
 *   FIFO from the preceding PLANNER_RESPONSE's tool_calls when available and
 *   falling back to the event type itself; payloads never render.
 * - `USER_INPUT` (the full echoed review prompt) and `CHECKPOINT` (context
 *   summaries) reduce to size markers.
 * - Unknown event types degrade to payload-free `[<type>]` markers.
 */
export function createAntigravityTranscriptRenderer(): ActivityRenderer {
  let pendingToolNames: string[] = [];

  return (event) => {
    const type = stringField(event, "type");
    if (type === undefined) {
      return undefined;
    }

    if (type === "PLANNER_RESPONSE") {
      pendingToolNames = antigravityToolCallNames(event.tool_calls);
      const content = typeof event.content === "string" ? event.content : undefined;
      return content === undefined || content.trim() === "" ? undefined : content;
    }

    if (antigravityToolEventTypes.has(type)) {
      return toolUseMarker(pendingToolNames.shift() ?? type);
    }

    if (type === "USER_INPUT" || type === "CHECKPOINT") {
      return sizeMarker(type, contentSize(event.content ?? event));
    }

    return `[${type}]`;
  };
}

/** Bounded, name-only extraction from PLANNER_RESPONSE.tool_calls. */
function antigravityToolCallNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const names: string[] = [];
  for (const call of toolCalls) {
    if (names.length >= maxAntigravityPendingToolNames) {
      break;
    }
    if (isRecord(call)) {
      const name = stringField(call, "name");
      if (name !== undefined) {
        names.push(name);
      }
    }
  }
  return names;
}

/** Payload-free tool marker; the name is bounded, never the tool input. */
export function toolUseMarker(name?: string): string {
  return `[tool_use${name !== undefined ? ` ${boundedMarkerName(name)}` : ""}]`;
}

/** Payload-free size marker, e.g. `[tool_result 8 chars]`. */
export function sizeMarker(label: string, chars: number): string {
  return `[${label} ${chars} chars]`;
}

/** Bounded server/tool-provided name for marker embedding (exported for adapter-synthesized notes). */
export function boundedMarkerName(name: string): string {
  return name.length > maxMarkerNameChars ? name.slice(0, maxMarkerNameChars) : name;
}

export function contentSize(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  try {
    return JSON.stringify(content)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
