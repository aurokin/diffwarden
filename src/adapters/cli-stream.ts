/**
 * Native stream-output support for CLI transports.
 *
 * Two activation paths share this parser:
 * - Stream-switch engines (claude, droid): active only when the run requested
 *   live debug streaming (--ndjson together with --debug-reviewer-output);
 *   specs switch the CLI to its stream output mode and the final review result
 *   is extracted from the stream transcript so the artifact parses exactly as
 *   in the non-stream mode.
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
  type ActivityRenderer,
  activityRenderer,
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
  let buffer = "";
  let degraded = false;

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
        const lineText = renderStreamLine(line, render);
        if (lineText === undefined) {
          // Not JSONL after all: degrade to raw passthrough from this point.
          degraded = true;
          rendered.push(`${line}\n${buffer}`);
          buffer = "";
          return rendered;
        }
        if (lineText !== "") {
          rendered.push(`${lineText}\n`);
        }
        newlineIndex = buffer.indexOf("\n");
      }
      return rendered;
    },
    flush() {
      const rest = buffer;
      buffer = "";
      if (rest === "") {
        return [];
      }
      if (degraded) {
        return [rest];
      }
      const lineText = renderStreamLine(rest, render);
      if (lineText === undefined) {
        return [rest];
      }
      return lineText === "" ? [] : [`${lineText}\n`];
    },
  };
}

/** Rendered text, "" to skip the event silently, or undefined for invalid JSON. */
function renderStreamLine(line: string, render: ActivityRenderer): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return "";
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
  return renderActivityEvent(render, event) ?? "";
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
