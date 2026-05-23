import { describe, expect, it } from "vitest";
import {
  buildStructuredReviewAdapterOutput,
  collectJsonLinesText,
  normalizeJsonLikeAdapterOutput,
  normalizeStructuredOrTextAdapterOutput,
  unwrapStructuredReview,
  unwrapText,
} from "../src/core/adapter-output.js";

const validReview = {
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: "Looks good.",
  overall_confidence_score: 0.95,
};

describe("adapter output normalization", () => {
  it("unwraps structured review results from common wrapper shapes", () => {
    expect(unwrapStructuredReview({ structured_output: validReview })).toEqual(validReview);
    expect(unwrapStructuredReview({ structuredOutput: validReview })).toEqual(validReview);
    expect(unwrapStructuredReview({ result: { response: validReview } })).toEqual(validReview);
  });

  it("unwraps text from common response shapes", () => {
    expect(unwrapText({ result: " plain text " })).toBe("plain text");
    expect(unwrapText({ message: { content: [{ text: "first" }, { text: "second" }] } })).toBe(
      "first\nsecond",
    );
  });

  it("normalizes JSON object output to structured adapter output when possible", () => {
    const output = normalizeJsonLikeAdapterOutput(JSON.stringify({ response: validReview }), {
      captureMode: "native-structured",
      readonlyCapability: "enforced",
    });

    expect(output).toEqual({
      structured: validReview,
      metadata: {
        captureMode: "native-structured",
        readonlyCapability: "enforced",
      },
    });
  });

  it("falls back to text for invalid or plain JSON-like output", () => {
    const output = normalizeJsonLikeAdapterOutput(JSON.stringify({ response: "review text" }), {
      captureMode: "native-structured",
    });

    expect(output).toEqual({
      text: "review text",
      metadata: {
        captureMode: "text",
      },
    });
  });

  it("collects assistant text from JSONL streams and ignores non-assistant events", () => {
    const output = collectJsonLinesText(
      [
        JSON.stringify({ type: "text", part: { type: "text", text: "first" } }),
        JSON.stringify({ type: "message", message: { role: "toolResult", content: "ignored" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "second" } }),
        "plain tail",
      ].join("\n"),
    );

    expect(output).toBe("first\nsecond\nplain tail");
  });

  it("builds structured adapter output only for valid review results", () => {
    expect(
      buildStructuredReviewAdapterOutput(validReview, {
        metadata: { captureMode: "tool-call" },
        usage: { inputTokens: 10 },
      }),
    ).toEqual({
      structured: validReview,
      usage: { inputTokens: 10 },
      metadata: { captureMode: "tool-call" },
    });
    expect(
      buildStructuredReviewAdapterOutput(
        { nope: true },
        { metadata: { captureMode: "tool-call" } },
      ),
    ).toBeUndefined();
  });

  it("falls back from invalid structured output to trimmed text", () => {
    const output = normalizeStructuredOrTextAdapterOutput({
      structured: { nope: true },
      text: " fallback text ",
      usage: { outputTokens: 2 },
      fallbackReason: "invalid_structured_output",
      metadata: {
        captureMode: "native-structured",
        readonlyCapability: "enforced",
      },
    });

    expect(output).toEqual({
      text: "fallback text",
      usage: { outputTokens: 2 },
      metadata: {
        captureMode: "text",
        readonlyCapability: "enforced",
        fallbackReason: "invalid_structured_output",
      },
    });
  });
});
