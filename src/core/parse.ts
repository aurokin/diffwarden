import {
  type ParseMode,
  type ReviewArtifactResult,
  type ReviewValidation,
  createFallbackReviewResult,
  reviewResultSchema,
} from "./schema.js";

export type ParseReviewOutputInput =
  | {
      structured: unknown;
      text?: never;
    }
  | {
      structured?: never;
      text: string;
    };

export type ParseReviewOutputResult = {
  result: ReviewArtifactResult;
  rawText?: string;
  validation: ReviewValidation;
};

export function parseReviewOutput(input: ParseReviewOutputInput): ParseReviewOutputResult {
  if ("structured" in input) {
    const parsed = reviewResultSchema.safeParse(input.structured);
    if (parsed.success) {
      return buildParsedResult(parsed.data, "tool-output");
    }

    const text = stringifyFallback(input.structured);
    return buildFallbackResult(text);
  }

  const strict = parseJsonObject(input.text);
  if (strict !== undefined) {
    const parsed = reviewResultSchema.safeParse(strict);
    if (parsed.success) {
      return buildParsedResult(parsed.data, "strict-json", input.text);
    }
  }

  const extracted = extractJsonObject(input.text);
  if (extracted !== undefined) {
    const parsed = reviewResultSchema.safeParse(extracted);
    if (parsed.success) {
      return buildParsedResult(parsed.data, "extracted-json", input.text);
    }
  }

  return buildFallbackResult(input.text);
}

function buildParsedResult(
  result: ReviewArtifactResult,
  parseMode: ParseMode,
  rawText?: string,
): ParseReviewOutputResult {
  const parsed: ParseReviewOutputResult = {
    result,
    validation: {
      parse_mode: parseMode,
      valid_schema: true,
      findings_overlap_diff: false,
      valid_locations: false,
      invalid_locations: [],
    },
  };

  if (rawText !== undefined) {
    parsed.rawText = rawText;
  }

  return parsed;
}

function buildFallbackResult(text: string): ParseReviewOutputResult {
  return {
    result: createFallbackReviewResult(text),
    rawText: text,
    validation: {
      parse_mode: "fallback-text",
      valid_schema: false,
      findings_overlap_diff: false,
      valid_locations: false,
      invalid_locations: [],
    },
  };
}

function parseJsonObject(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringifyFallback(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function extractJsonObject(text: string): unknown | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || start >= end) {
    return undefined;
  }

  return parseJsonObject(text.slice(start, end + 1));
}
