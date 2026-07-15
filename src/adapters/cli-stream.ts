/**
 * Native stream-output support for CLI transports.
 *
 * Two activation paths share this parser:
 * - Stream-switch engines (claude, cursor, droid, grok): active only when the
 *   run requested live debug streaming (--ndjson together with
 *   --debug-reviewer-output); specs switch the CLI to its stream output mode
 *   and the final review result is extracted from the stream transcript so
 *   the artifact parses exactly as in the non-stream mode.
 * - Always-JSONL engines (codex, opencode, copilot, pi): the default review
 *   invocation already emits JSONL, so debug chunks route through the parser
 *   whenever debug output is requested — zero invocation changes, parseOutput
 *   untouched.
 * In both cases raw JSONL chunks are parsed into compact single-line summaries
 * for reviewer_debug_output events. Per-event rendering (and the
 * reasoning-exclusion policy) lives in the shared reviewer-activity module;
 * this file is the line-framing layer.
 *
 * Parsing is best-effort by contract: any line that is not valid JSON flips
 * the parser into raw passthrough for the rest of the run, and a transcript
 * with no recognizable final event falls back to the existing parse/repair
 * pipeline. Stream problems must never fail the review.
 */

// stringField/numberField stay imported: the stream-result extractors below
// still consume them (only per-event rendering moved to reviewer-activity).
import {
  type ActivityDialect,
  activityRenderer,
  createDeltaCoalescer,
  isRecord,
  numberField,
  renderActivityEvent,
  stringField,
} from "./reviewer-activity.js";

export type CliStreamFormat = ActivityDialect;

export type CliStreamChunkParser = {
  /** Feed one decoded stdout chunk; returns rendered debug texts to forward. */
  push(text: string): string[];
  /** Drain the trailing partial line when the process closes. */
  flush(): string[];
};

export function createCliStreamChunkParser(format: CliStreamFormat): CliStreamChunkParser {
  const render = activityRenderer(format);
  // Grok's stream carries the answer as token-level `text` deltas; rendering
  // them per event would emit one debug line per token, so they coalesce into
  // blocks flushed on event-type transition and at the terminal event/close.
  const coalescer = format === "grok-streaming-json" ? createDeltaCoalescer() : undefined;
  let buffer = "";
  let degraded = false;

  /** Rendered texts for one parsed event (possibly none). */
  function renderEvent(event: Record<string, unknown>): string[] {
    if (coalescer !== undefined) {
      if (stringField(event, "type") === "text" && typeof event.data === "string") {
        return coalescer.push("text", event.data);
      }
      // Event-type transition (thought/end/unknown): flush the pending block
      // first so coalesced answer text precedes the event's own marker.
      const texts = coalescer.flush();
      const rendered = renderActivityEvent(render, event);
      if (rendered !== undefined && rendered !== "") {
        texts.push(rendered);
      }
      return texts;
    }
    const rendered = renderActivityEvent(render, event);
    return rendered === undefined || rendered === "" ? [] : [rendered];
  }

  /** Rendered texts for one line, or undefined for invalid JSON. */
  function renderStreamLine(line: string): string[] | undefined {
    const trimmed = line.trim();
    if (trimmed === "") {
      return [];
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isRecord(event)) {
      return undefined;
    }
    return renderEvent(event);
  }

  /** Drain the coalescer's pending block into newline-terminated outputs. */
  function drainCoalescer(rendered: string[]): void {
    if (coalescer === undefined) {
      return;
    }
    for (const flushed of coalescer.flush()) {
      rendered.push(`${flushed}\n`);
    }
  }

  return {
    push(text) {
      if (degraded) {
        return [text];
      }
      buffer += text;
      const rendered: string[] = [];
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const lineTexts = renderStreamLine(line);
        if (lineTexts === undefined) {
          // Not JSONL after all: degrade to raw passthrough from this point.
          // Any coalesced block drains first so buffered answer text is not
          // lost ahead of the raw tail.
          degraded = true;
          drainCoalescer(rendered);
          rendered.push(`${line}\n${buffer}`);
          buffer = "";
          return rendered;
        }
        for (const lineText of lineTexts) {
          rendered.push(`${lineText}\n`);
        }
        newlineIndex = buffer.indexOf("\n");
      }
      return rendered;
    },
    flush() {
      const rest = buffer;
      buffer = "";
      if (degraded) {
        return rest === "" ? [] : [rest];
      }
      const rendered: string[] = [];
      if (rest !== "") {
        const lineTexts = renderStreamLine(rest);
        if (lineTexts === undefined) {
          drainCoalescer(rendered);
          rendered.push(rest);
          return rendered;
        }
        for (const lineText of lineTexts) {
          rendered.push(`${lineText}\n`);
        }
      }
      // A stream that ended without a terminal event still drains its block.
      drainCoalescer(rendered);
      return rendered;
    },
  };
}

/**
 * Claude's terminal stream event has the same shape as the whole stdout of
 * --output-format json (including structured_output), so the extracted line
 * feeds the existing normalizer unchanged.
 */
export function extractClaudeStreamResultStdout(stdout: string): string | undefined {
  return lastMatchingStreamLine(stdout, (event) => stringField(event, "type") === "result");
}

/**
 * Droid's terminal `completion` event carries the final text under different
 * keys than its --output-format json envelope, so map it onto that envelope
 * before handing it to the shared normalizer and session-metadata reader.
 * The `completion`/`finalText` shape is what the real droid CLI emits (July
 * 2026 live capture: system/init, message, completion events — there is no
 * `type: "result"` stream event); if a future CLI changes the terminal event,
 * extraction returns undefined and the raw transcript falls back to the
 * normal parse/repair pipeline instead of failing the review.
 */
export function extractDroidStreamResultStdout(stdout: string): string | undefined {
  const completion = lastMatchingStreamEvent(
    stdout,
    (event) => stringField(event, "type") === "completion",
  );
  if (completion === undefined || typeof completion.finalText !== "string") {
    return undefined;
  }

  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: completion.finalText,
    ...(numberField(completion, "durationMs") !== undefined
      ? { duration_ms: completion.durationMs }
      : {}),
    ...(numberField(completion, "numTurns") !== undefined
      ? { num_turns: completion.numTurns }
      : {}),
    ...(stringField(completion, "session_id") !== undefined
      ? { session_id: completion.session_id }
      : {}),
    ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
  });
}

/**
 * Grok's streaming-json transcript carries the answer only as token-level
 * `text` deltas in `.data`; the terminal `end` event carries every json-mode
 * envelope field EXCEPT `text`/`thought` (live-verified 2026-07-15, tool-using
 * multi-turn re-probe included). Synthesize the json-mode envelope —
 * `{...end minus type, text: concat(text deltas in order)}` — so the existing
 * normalizeJsonLikeAdapterOutput path parses it unchanged. Naive concat is
 * exactly json-mode behavior: json mode's `.text` merges multi-turn text with
 * no separator (live capture: "…files now.From the files…"), and the same
 * deltas stream across turns. `thought` is deliberately omitted — json mode
 * ships full verbatim reasoning there, and the stream path must not resurrect
 * it even if a future `end` event grows a `thought` field. A transcript with
 * no `end` event returns undefined and falls back to the raw transcript and
 * the normal parse/repair pipeline.
 */
export function extractGrokStreamResultStdout(stdout: string): string | undefined {
  let endEvent: Record<string, unknown> | undefined;
  const textParts: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const event = parseJsonRecord(line);
    if (event === undefined) {
      continue;
    }
    const type = stringField(event, "type");
    if (type === "text" && typeof event.data === "string") {
      textParts.push(event.data);
    } else if (type === "end") {
      endEvent = event;
    }
  }
  if (endEvent === undefined) {
    return undefined;
  }

  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(endEvent)) {
    if (key !== "type" && key !== "thought") {
      envelope[key] = value;
    }
  }
  envelope.text = textParts.join("");
  return JSON.stringify(envelope);
}

function lastMatchingStreamLine(
  stdout: string,
  matches: (event: Record<string, unknown>) => boolean,
): string | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line === "") {
      continue;
    }
    const event = parseJsonRecord(line);
    if (event !== undefined && matches(event)) {
      return line;
    }
  }
  return undefined;
}

function lastMatchingStreamEvent(
  stdout: string,
  matches: (event: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const line = lastMatchingStreamLine(stdout, matches);
  return line === undefined ? undefined : parseJsonRecord(line);
}

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
