import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../src/adapters/types.js";
import {
  CUSTOM_MODEL_CHOICE,
  type ModelCatalogDraft,
  type ModelCatalogResult,
  buildModelSelectOptions,
  catalogEffortChoices,
  createModelCatalogSession,
} from "../src/core/setup-catalog.js";

// The interactive flows that consume the catalog session can't run in CI (no TTY), so the
// injected-fetch session and the pure select/effort builders carry the automated coverage.

const effortChoices = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function claudeDraft(overrides: Partial<ModelCatalogDraft> = {}): ModelCatalogDraft {
  return {
    id: "claude",
    engine: "claude",
    transport: undefined,
    model: undefined,
    ...overrides,
  };
}

function sampleModels(): ModelCatalogEntry[] {
  return [
    { value: "default", displayName: "Default (recommended)" },
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "balanced",
      supportedEffortLevels: ["low", "medium", "high", "max"],
      default: true,
    },
  ];
}

describe("createModelCatalogSession", () => {
  it("declares catalog support only for the claude sdk transport", () => {
    const session = createModelCatalogSession({ fetch: async () => [] });
    expect(session.supports("claude", undefined)).toBe(true);
    expect(session.supports("claude", "sdk")).toBe(true);
    expect(session.supports("claude", "cli")).toBe(false);
    expect(session.supports("pi", undefined)).toBe(false);
    expect(session.supports("codex", undefined)).toBe(false);
  });

  it("fetches once per engine+transport and caches the result", async () => {
    let calls = 0;
    const session = createModelCatalogSession({
      fetch: async () => {
        calls += 1;
        return sampleModels();
      },
    });

    const first = await session.fetch(claudeDraft());
    const second = await session.fetch(claudeDraft({ model: "sonnet" }));
    expect(calls).toBe(1);
    expect(first).toEqual({ status: "ok", models: sampleModels() });
    expect(second).toBe(first);
    expect(session.peek(claudeDraft())).toBe(first);
  });

  it("passes the draft reviewer and env through to the fetch", async () => {
    const inputs: unknown[] = [];
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "test-token" };
    const session = createModelCatalogSession({
      env,
      fetch: async (_engine, input) => {
        inputs.push(input);
        return sampleModels();
      },
    });

    await session.fetch(claudeDraft({ id: "claude-main", model: "sonnet" }));
    expect(inputs[0]).toEqual({
      reviewer: { id: "claude-main", sdk: "claude", model: "sonnet", readonly: true },
      env,
    });
  });

  it("degrades a failed fetch to unavailable with a one-line reason", async () => {
    const session = createModelCatalogSession({
      fetch: async () => {
        throw new Error("Claude model preflight authentication failed\nrun claude login");
      },
    });

    expect(await session.fetch(claudeDraft())).toEqual({
      status: "unavailable",
      reason: "Claude model preflight authentication failed",
    });
    // Failures cache too: never re-run auth probes inside a prompt loop.
    expect(session.peek(claudeDraft())?.status).toBe("unavailable");
  });

  it("degrades an empty catalog to unavailable", async () => {
    const session = createModelCatalogSession({ fetch: async () => [] });
    expect(await session.fetch(claudeDraft())).toEqual({
      status: "unavailable",
      reason: "engine returned an empty model catalog",
    });
  });

  it("times out a hung fetch", async () => {
    const session = createModelCatalogSession({
      timeoutMs: 20,
      fetch: () => new Promise(() => {}),
    });
    expect(await session.fetch(claudeDraft())).toEqual({
      status: "unavailable",
      reason: "timed out after 0.02s",
    });
  });

  it("caches per transport, not globally", async () => {
    let calls = 0;
    const session = createModelCatalogSession({
      fetch: async () => {
        calls += 1;
        return sampleModels();
      },
    });

    await session.fetch(claudeDraft());
    await session.fetch(claudeDraft({ transport: "sdk" }));
    expect(calls).toBe(2);
  });
});

describe("buildModelSelectOptions", () => {
  it("renders default, catalog entries, and the custom escape hatch in order", () => {
    expect(buildModelSelectOptions(sampleModels(), "claude")).toEqual([
      { value: "", label: "default", hint: "engine default (sonnet)" },
      { value: "default", label: "Default (recommended)", hint: "" },
      { value: "sonnet", label: "Sonnet", hint: "balanced · default" },
      { value: CUSTOM_MODEL_CHOICE, label: "custom…", hint: "enter a model id" },
    ]);
  });

  it("falls back to the model value when the catalog omits a display name", () => {
    const options = buildModelSelectOptions([{ value: "sonnet[1m]" }], "pi");
    expect(options[1]).toEqual({ value: "sonnet[1m]", label: "sonnet[1m]", hint: "" });
    expect(options[0]?.hint).toBe("engine default");
  });
});

describe("catalogEffortChoices", () => {
  const okResult: ModelCatalogResult = { status: "ok", models: sampleModels() };

  it("narrows to the catalog's levels plus off for the effective model", () => {
    expect(catalogEffortChoices(okResult, claudeDraft({ model: "sonnet" }), effortChoices)).toEqual(
      ["off", "low", "medium", "high", "max"],
    );
  });

  it("uses the engine default model when the draft has no override", () => {
    // Claude's default model is sonnet, whose sample entry carries levels.
    expect(catalogEffortChoices(okResult, claudeDraft(), effortChoices)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("returns undefined when it cannot narrow", () => {
    // No catalog fetched yet.
    expect(catalogEffortChoices(undefined, claudeDraft(), effortChoices)).toBeUndefined();
    // Catalog unavailable.
    expect(
      catalogEffortChoices({ status: "unavailable", reason: "x" }, claudeDraft(), effortChoices),
    ).toBeUndefined();
    // Model not in the catalog.
    expect(
      catalogEffortChoices(okResult, claudeDraft({ model: "opus" }), effortChoices),
    ).toBeUndefined();
    // Entry without effort levels.
    expect(
      catalogEffortChoices(okResult, claudeDraft({ model: "default" }), effortChoices),
    ).toBeUndefined();
  });
});
