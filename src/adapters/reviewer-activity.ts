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
  | "codex-json"
  | "opencode-json"
  | "copilot-json"
  | "pi-json";

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
    "codex-json": codexJsonEventText,
    "opencode-json": opencodeJsonEventText,
    "copilot-json": copilotJsonEventText,
    "pi-json": piJsonEventText,
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
        // No buffered state in v1 (the delta coalescer is phase 2).
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

/** Payload-free tool marker; the name is bounded, never the tool input. */
export function toolUseMarker(name?: string): string {
  return `[tool_use${name !== undefined ? ` ${boundedMarkerName(name)}` : ""}]`;
}

/** Payload-free size marker, e.g. `[tool_result 8 chars]`. */
export function sizeMarker(label: string, chars: number): string {
  return `[${label} ${chars} chars]`;
}

function boundedMarkerName(name: string): string {
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
