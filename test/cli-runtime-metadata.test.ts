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

  it("extracts Claude CLI runtime model from single-model usage keys", () => {
    const metadata = cliRuntimeResolutionMetadata(
      JSON.stringify({
        type: "result",
        result: "Hello. How can I help?",
        usage: {
          input_tokens: 1763,
          output_tokens: 88,
        },
        modelUsage: {
          "claude-opus-4-8[1m]": {
            inputTokens: 1763,
            outputTokens: 88,
          },
        },
      }),
    );

    expect(metadata).toEqual({
      resolvedModel: "claude-opus-4-8",
      modelResolutionSource: "provider-result",
    });
  });

  it("normalizes Claude CLI model usage display keys before reporting them", () => {
    expect(
      cliRuntimeResolutionMetadata(
        JSON.stringify({
          type: "result",
          modelUsage: {
            "\u001b[2mclaude-sonnet-4-6[1m]\u001b[0m": {},
          },
        }),
      ),
    ).toEqual({
      resolvedModel: "claude-sonnet-4-6",
      modelResolutionSource: "provider-result",
    });
  });

  it("prefers explicit runtime model fields over usage accounting keys", () => {
    expect(
      cliRuntimeResolutionMetadata(
        JSON.stringify({
          type: "result",
          model: "selected-model",
          modelUsage: {
            "fallback[1m]": {},
          },
        }),
      ),
    ).toEqual({
      resolvedModel: "selected-model",
      modelResolutionSource: "provider-result",
    });
  });

  it("does not infer Claude CLI runtime model from ambiguous usage keys", () => {
    expect(
      cliRuntimeResolutionMetadata(JSON.stringify({ type: "result", modelUsage: {} })),
    ).toEqual({});
    expect(
      cliRuntimeResolutionMetadata(
        JSON.stringify({
          type: "result",
          modelUsage: {
            "claude-sonnet-4-6": {},
            "claude-opus-4-8[1m]": {},
          },
        }),
      ),
    ).toEqual({});
  });

  it("extracts Pi CLI runtime model from nested assistant message records", () => {
    const metadata = cliRuntimeResolutionMetadata(
      [
        JSON.stringify({
          type: "session",
          version: 3,
          cwd: "/tmp/probe",
        }),
        JSON.stringify({
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.5",
          },
        }),
      ].join("\n"),
    );

    expect(metadata).toEqual({
      resolvedModel: "gpt-5.5",
      modelResolutionSource: "provider-result",
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
