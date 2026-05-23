import { type ReviewResult, reviewResultSchema } from "./schema.js";

export type AdapterOutputMetadata = {
  captureMode?: "native-structured" | "tool-call" | "text";
  [key: string]: unknown;
};

export type NormalizedAdapterOutput = {
  text?: string;
  structured?: unknown;
  usage?: unknown;
  metadata?: AdapterOutputMetadata;
};

export function normalizeJsonLikeAdapterOutput(
  raw: string,
  metadata: AdapterOutputMetadata,
): NormalizedAdapterOutput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: "", metadata: { ...metadata, captureMode: "text" } };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const review = unwrapStructuredReview(parsed);
    if (review !== undefined) {
      return {
        structured: review,
        metadata,
      };
    }
    const text = unwrapText(parsed);
    if (text !== undefined) {
      return {
        text,
        metadata: { ...metadata, captureMode: "text" },
      };
    }
  } catch {
    // Plain text fallback is handled below.
  }

  return {
    text: trimmed,
    metadata: { ...metadata, captureMode: "text" },
  };
}

export function normalizeStructuredOrTextAdapterOutput(options: {
  structured: unknown;
  text?: string;
  metadata: AdapterOutputMetadata;
  usage?: unknown;
  fallbackReason: string;
}): NormalizedAdapterOutput | undefined {
  const structured = buildStructuredReviewAdapterOutput(options.structured, {
    metadata: options.metadata,
    usage: options.usage,
  });
  if (structured !== undefined) {
    return structured;
  }

  const text = options.text?.trim();
  if (!text) {
    return undefined;
  }

  return {
    text,
    usage: options.usage,
    metadata: {
      ...options.metadata,
      captureMode: "text",
      fallbackReason: options.fallbackReason,
    },
  };
}

export function buildStructuredReviewAdapterOutput(
  value: unknown,
  options: {
    metadata: AdapterOutputMetadata;
    usage?: unknown;
  },
): NormalizedAdapterOutput | undefined {
  const review = unwrapStructuredReview(value);
  if (review === undefined) {
    return undefined;
  }

  return {
    structured: review,
    usage: options.usage,
    metadata: options.metadata,
  };
}

export function buildTextAdapterOutput(options: {
  text: string | undefined;
  metadata: AdapterOutputMetadata;
  usage?: unknown;
}): NormalizedAdapterOutput {
  return {
    text: options.text ?? "",
    usage: options.usage,
    metadata: {
      ...options.metadata,
      captureMode: "text",
    },
  };
}

export function collectJsonLinesText(raw: string): string {
  const fragments: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event: unknown = JSON.parse(trimmed);
      const text = unwrapJsonLineOutputText(event);
      if (isNonEmptyString(text)) {
        fragments.push(text);
      }
    } catch {
      fragments.push(trimmed);
    }
  }

  return fragments.join("\n").trim();
}

export function unwrapStructuredReview(value: unknown): ReviewResult | undefined {
  const parsed = reviewResultSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["structured_output", "structuredOutput", "result", "response", "message"]) {
    const nested = value[key];
    if (nested === undefined || typeof nested === "string") {
      continue;
    }
    const review = unwrapStructuredReview(nested);
    if (review !== undefined) {
      return review;
    }
  }

  return undefined;
}

export function unwrapText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(unwrapText).filter(isNonEmptyString).join("\n").trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["result", "response", "text", "content", "message", "output"]) {
    const text = unwrapText(value[key]);
    if (isNonEmptyString(text)) {
      return text;
    }
  }

  return undefined;
}

function unwrapJsonLineOutputText(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const type = typeof event.type === "string" ? event.type : undefined;
  if (type === "text") {
    const part = event.part;
    if (isRecord(part) && part.type === "text") {
      return unwrapText(part.text);
    }
    return unwrapText(event.text ?? event.content);
  }

  if (type === "result") {
    return unwrapText(event.response ?? event.result ?? event.output ?? event.message);
  }

  if (
    type === "assistant" ||
    type === "assistant_message" ||
    type === "message_end" ||
    type === "text_end"
  ) {
    return unwrapText(event.message ?? event.content ?? event.text);
  }

  if (type === "message") {
    const message = event.message;
    if (isRecord(message) && message.role === "assistant") {
      return unwrapText(message.content ?? message.text);
    }
    if (event.role === "assistant") {
      return unwrapText(event.content ?? event.text);
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
