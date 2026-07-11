import { z } from "zod";
import type { RunStructuredOutput } from "../adapters/types.js";
import { extractJsonObjectCandidates } from "./parse.js";
import { type ReviewResult, reviewResultJsonSchema, reviewResultSchema } from "./schema.js";

/**
 * The core structured-output repair stage. When a review run produces schema-invalid output but
 * the raw material survives (invalid structured JSON, unparseable text), one short repair request
 * asks the SAME engine to transcribe it into valid shape — never to re-review. The response is
 * wrapped so the model's meta judgment (fixable, confidence) cannot leak into the review itself,
 * and a low-confidence repair is rejected in favor of a labeled full re-run: a labeled failure
 * tells users the engine/model is not reliably capable, a shaky repair hides it.
 */

/** Accepted repair confidences; "low" is deliberately rejected. */
export type RepairConfidence = "high" | "medium";

export type RepairEvaluation = {
  review: ReviewResult;
  confidence: RepairConfidence;
};

const repairResponseSchema = z
  .object({
    fixable: z.boolean(),
    confidence: z.enum(["high", "medium", "low"]),
    review: z.unknown(),
  })
  .strict();

/**
 * Wrapper contract for the repair response. `review` is the ReviewResult schema or null so an
 * honest "not fixable" answer has a valid shape.
 */
export const repairResponseJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["fixable", "confidence", "review"],
  properties: {
    fixable: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    review: { anyOf: [reviewResultJsonSchema, { type: "null" }] },
  },
};

/**
 * Repair prompt: transcription only. The malformed output is the sole source of truth — the
 * model must not invent, drop, or "improve" findings, and unknowable fields mean not fixable.
 */
export function buildRepairPrompt(material: string): string {
  return [
    "A code-review response failed schema validation. Repair it into valid JSON.",
    "",
    "Rules:",
    "- Transcribe the malformed output into the target schema. Do NOT invent findings,",
    "  file paths, line numbers, or scores that are not present in the malformed output,",
    "  and do NOT drop or reword findings that are.",
    "- If required information is missing or ambiguous, report fixable: false instead of guessing.",
    "- Report your confidence that the repaired review is a faithful transcription.",
    "",
    "Respond with a single JSON object of this exact shape:",
    JSON.stringify(
      {
        fixable: "boolean — can the malformed output be faithfully transcribed?",
        confidence: '"high" | "medium" | "low"',
        review: "the repaired review object, or null when fixable is false",
      },
      null,
      2,
    ),
    "",
    "The `review` field must satisfy this JSON schema:",
    JSON.stringify(reviewResultJsonSchema, null, 2),
    "",
    "Malformed output to repair:",
    "```",
    material,
    "```",
  ].join("\n");
}

/**
 * Evaluate a repair response: unwrap (native structured or JSON-in-text), check the wrapper, and
 * accept only `fixable && confidence !== "low"` with a schema-valid review. Returns undefined for
 * anything else — the caller falls through to the labeled re-run. Never triggers another repair.
 */
export function evaluateRepairResponse(output: RunStructuredOutput): RepairEvaluation | undefined {
  for (const candidate of repairResponseCandidates(output)) {
    const wrapper = repairResponseSchema.safeParse(candidate);
    if (!wrapper.success) {
      continue;
    }
    if (wrapper.data.fixable !== true || wrapper.data.confidence === "low") {
      return undefined;
    }
    const review = reviewResultSchema.safeParse(wrapper.data.review);
    if (!review.success) {
      return undefined;
    }
    return { review: review.data, confidence: wrapper.data.confidence };
  }
  return undefined;
}

function* repairResponseCandidates(output: RunStructuredOutput): Generator<unknown> {
  if (output.structured !== undefined) {
    yield output.structured;
  }

  const text = output.text?.trim();
  if (text === undefined || text === "") {
    return;
  }
  try {
    yield JSON.parse(text);
    return;
  } catch {
    // Fall through to embedded-object extraction.
  }
  const candidates = extractJsonObjectCandidates(text);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    try {
      yield JSON.parse(candidate);
    } catch {
      // Skip unparseable fragments.
    }
  }
}
