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

  const candidates = extractJsonObjectCandidates(input.text);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    const extracted = parseJsonObject(candidate);
    if (extracted === undefined) {
      continue;
    }
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

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (depth === 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0 && start !== -1) {
      candidates.push(text.slice(start, index + 1));
      start = -1;
    }
  }

  return candidates;
}
