import { describe, expect, it } from "vitest";
import { cliRuntimeResolutionMetadata } from "../src/adapters/cli-runtime-metadata.js";

describe("CLI runtime metadata extraction", () => {
  it("extracts resolved model and effort from JSONL init events", () => {
    const metadata = cliRuntimeResolutionMetadata(
      [
        JSON.stringify({ type: "tool_use", content: "ignored" }),
        JSON.stringify({
          type: "session_configured",
          settings: {
            modelId: "main-model",
            reasoningEffort: "low",
            specModeModelId: "spec-model",
            specModeReasoningEffort: "high",
          },
        }),
      ].join("\n"),
    );

    expect(metadata).toEqual({
      resolvedModel: "spec-model",
      modelResolutionSource: "provider-init",
      resolvedEffort: "high",
      effortResolutionSource: "provider-init",
    });
  });

  it("extracts resolved fields from single JSON result envelopes", () => {
    const metadata = cliRuntimeResolutionMetadata(
      JSON.stringify({
        result: {
          model: "result-model",
          reasoning_effort: "medium",
        },
      }),
    );

    expect(metadata).toEqual({
      resolvedModel: "result-model",
      modelResolutionSource: "provider-result",
      resolvedEffort: "medium",
      effortResolutionSource: "provider-result",
    });
  });

  it("prefers provider-result metadata over provider-init metadata", () => {
    const metadata = cliRuntimeResolutionMetadata(
      [
        JSON.stringify({ type: "session_start", model: "init-model", effort: "low" }),
        JSON.stringify({ type: "result", model: "result-model", effort: "high" }),
      ].join("\n"),
    );

    expect(metadata).toEqual({
      resolvedModel: "result-model",
      modelResolutionSource: "provider-result",
      resolvedEffort: "high",
      effortResolutionSource: "provider-result",
    });
  });

  it("ignores plain text and JSON without runtime fields", () => {
    expect(cliRuntimeResolutionMetadata("plain model: not structured")).toEqual({});
    expect(cliRuntimeResolutionMetadata(JSON.stringify({ result: "review text" }))).toEqual({});
  });
});
