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
 * app-server dialects land with their adapter wiring.
 */
export type ActivityDialect = "claude-stream-json" | "droid-stream-json";

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

function activityRenderer(dialect: ActivityDialect): ActivityRenderer {
  return dialect === "claude-stream-json" ? claudeStreamEventText : droidStreamEventText;
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
