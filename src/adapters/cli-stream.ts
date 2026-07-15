/**
 * Native stream-output support for CLI transports.
 *
 * Active only when the run requested live debug streaming (--ndjson together
 * with --debug-reviewer-output): specs switch the CLI to its stream output
 * mode, raw JSONL chunks are parsed into compact single-line summaries for
 * reviewer_debug_output events, and the final review result is extracted from
 * the stream transcript so the artifact parses exactly as in the non-stream
 * mode. Reasoning/thinking content is excluded from the rendered summaries.
 *
 * Parsing is best-effort by contract: any line that is not valid JSON flips
 * the parser into raw passthrough for the rest of the run, and a transcript
 * with no recognizable final event falls back to the existing parse/repair
 * pipeline. Stream problems must never fail the review.
 */

export type CliStreamFormat = "claude-stream-json" | "droid-stream-json";

export type CliStreamChunkParser = {
  /** Feed one decoded stdout chunk; returns rendered debug texts to forward. */
  push(text: string): string[];
  /** Drain the trailing partial line when the process closes. */
  flush(): string[];
};

type StreamEventRenderer = (event: Record<string, unknown>) => string | undefined;

export function createCliStreamChunkParser(format: CliStreamFormat): CliStreamChunkParser {
  const render = format === "claude-stream-json" ? claudeStreamEventText : droidStreamEventText;
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
function renderStreamLine(line: string, render: StreamEventRenderer): string | undefined {
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
  return render(event) ?? "";
}

/**
 * One safe summary line per Claude stream-json event. Assistant text is
 * surfaced verbatim; thinking blocks are dropped; tool payloads are reduced to
 * names/sizes so transcripts stay compact and reasoning stays private.
 */
function claudeStreamEventText(event: Record<string, unknown>): string | undefined {
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

function renderClaudeContentBlocks(content: unknown): string | undefined {
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
      parts.push(`[tool_use${typeof block.name === "string" ? ` ${block.name}` : ""}]`);
    } else if (blockType === "tool_result") {
      parts.push(`[tool_result ${contentSize(block.content)} chars]`);
    }
    // thinking / redacted_thinking blocks are intentionally dropped.
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * One safe summary line per Droid stream-json event. The echoed user message
 * is our own review prompt, so it is reduced to a size marker; any
 * reasoning-flavored event type is dropped.
 */
function droidStreamEventText(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  if (type === undefined) {
    return undefined;
  }
  if (/reasoning|thinking/i.test(type)) {
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
    return `[${role ?? "message"} message ${text?.length ?? 0} chars]`;
  }

  if (type === "completion") {
    const turns = numberField(event, "numTurns");
    const durationMs = numberField(event, "durationMs");
    return `[completion${turns !== undefined ? ` turns=${turns}` : ""}${
      durationMs !== undefined ? ` duration_ms=${durationMs}` : ""
    }]`;
  }

  const name = stringField(event, "name") ?? stringField(event, "tool");
  return `[${type}${name !== undefined ? ` ${name}` : ""}]`;
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

function contentSize(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  try {
    return JSON.stringify(content)?.length ?? 0;
  } catch {
    return 0;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
