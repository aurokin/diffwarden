import type { ReviewerDebugOutput } from "./schema.js";

/** Per stream, per reviewer, per run; shared by persisted capture and streamed events. */
export const debugOutputMaxBytesPerStream = 262_144;
/** Maximum UTF-8 bytes of text carried by one reviewer_debug_output event. */
export const debugOutputMaxEventTextBytes = 8_192;

export type DebugOutputStream = "stdout" | "stderr";

export type DebugOutputChunk = {
  stream: DebugOutputStream;
  text: string;
  truncated: boolean;
};

export type DebugOutputRecorder = {
  /**
   * Record one raw transport chunk, returning the bounded chunk events to
   * stream for it. Chunks larger than the per-event limit are split; once a
   * stream's budget is exhausted the final event carries `truncated: true`
   * and later chunks for that stream produce no events (but still count
   * toward the stream's total byte count).
   */
  record(stream: DebugOutputStream, text: string): DebugOutputChunk[];
  /** Bounded transcript for the artifact, or undefined when nothing was recorded. */
  finalize(): ReviewerDebugOutput | undefined;
};

type StreamState = {
  text: string;
  totalBytes: number;
  keptBytes: number;
  truncated: boolean;
};

export function createDebugOutputRecorder(options?: {
  maxBytesPerStream?: number;
  maxEventTextBytes?: number;
}): DebugOutputRecorder {
  const maxBytesPerStream = options?.maxBytesPerStream ?? debugOutputMaxBytesPerStream;
  const maxEventTextBytes = options?.maxEventTextBytes ?? debugOutputMaxEventTextBytes;
  const streams: Record<DebugOutputStream, StreamState> = {
    stdout: { text: "", totalBytes: 0, keptBytes: 0, truncated: false },
    stderr: { text: "", totalBytes: 0, keptBytes: 0, truncated: false },
  };

  return {
    record(stream, text) {
      const state = streams[stream];
      const chunkBytes = Buffer.byteLength(text);
      state.totalBytes += chunkBytes;
      if (state.truncated || chunkBytes === 0) {
        return [];
      }

      const kept = truncateUtf8(text, maxBytesPerStream - state.keptBytes);
      state.text += kept.text;
      state.keptBytes += kept.bytes;
      const exhausted = kept.text.length < text.length;
      if (exhausted) {
        state.truncated = true;
      }

      const pieces = splitUtf8(kept.text, maxEventTextBytes);
      if (exhausted && pieces.length === 0) {
        pieces.push("");
      }
      return pieces.map((piece, index) => ({
        stream,
        text: piece,
        truncated: exhausted && index === pieces.length - 1,
      }));
    },
    finalize() {
      if (streams.stdout.totalBytes === 0 && streams.stderr.totalBytes === 0) {
        return undefined;
      }
      return {
        stdout: streams.stdout.text,
        stdout_bytes: streams.stdout.totalBytes,
        stdout_truncated: streams.stdout.truncated,
        stderr: streams.stderr.text,
        stderr_bytes: streams.stderr.totalBytes,
        stderr_truncated: streams.stderr.truncated,
      };
    },
  };
}

/** Longest prefix of text that fits maxBytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) {
    return { text: "", bytes: 0 };
  }
  if (Buffer.byteLength(text) <= maxBytes) {
    return { text, bytes: Buffer.byteLength(text) };
  }

  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }
  return { text: text.slice(0, end), bytes };
}

function splitUtf8(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let remaining = text;
  while (remaining !== "") {
    const piece = truncateUtf8(remaining, maxBytes);
    pieces.push(piece.text);
    remaining = remaining.slice(piece.text.length);
  }
  return pieces;
}
