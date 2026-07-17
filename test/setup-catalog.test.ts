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
      supportedEffortLevels: ["off", "minimal", "low", "medium", "high", "max"],
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

  it("passes the draft reviewer, env, and an abort signal through to the fetch", async () => {
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
    expect(inputs[0]).toMatchObject({
      reviewer: { id: "claude-main", sdk: "claude", model: "sonnet", readonly: true },
      env,
      cwd: process.cwd(),
    });
    expect((inputs[0] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
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
  });

  it("does not cache unavailable results, so re-entering a field re-probes", async () => {
    let calls = 0;
    const session = createModelCatalogSession({
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("not authenticated");
        }
        return sampleModels();
      },
    });

    expect((await session.fetch(claudeDraft())).status).toBe("unavailable");
    // The failure is not pinned for the session: logging in and re-entering recovers.
    expect(session.peek(claudeDraft())).toBeUndefined();
    expect((await session.fetch(claudeDraft())).status).toBe("ok");
    expect(calls).toBe(2);
    // The success is cached as usual.
    expect(session.peek(claudeDraft())?.status).toBe("ok");
  });

  it("degrades an empty catalog to unavailable", async () => {
    const session = createModelCatalogSession({ fetch: async () => [] });
    expect(await session.fetch(claudeDraft())).toEqual({
      status: "unavailable",
      reason: "engine returned an empty model catalog",
    });
  });

  it("times out a hung fetch and aborts the underlying request", async () => {
    let signal: AbortSignal | undefined;
    const session = createModelCatalogSession({
      timeoutMs: 20,
      fetch: (_engine, input) => {
        signal = input.signal;
        return new Promise(() => {});
      },
    });
    expect(await session.fetch(claudeDraft())).toEqual({
      status: "unavailable",
      reason: "timed out after 0.02s",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("caches on the effective transport, so an explicit sdk toggle is a cache hit", async () => {
    let calls = 0;
    const session = createModelCatalogSession({
      fetch: async () => {
        calls += 1;
        return sampleModels();
      },
    });

    const implicit = await session.fetch(claudeDraft());
    // Claude's default transport is sdk: explicitly selecting it must not refetch.
    expect(await session.fetch(claudeDraft({ transport: "sdk" }))).toBe(implicit);
    expect(session.peek(claudeDraft({ transport: "sdk" }))).toBe(implicit);
    expect(calls).toBe(1);

    // A genuinely different transport is its own cache entry.
    await session.fetch(claudeDraft({ transport: "cli" }));
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

  it("keeps an out-of-catalog current model selectable instead of dropping it", () => {
    const options = buildModelSelectOptions(sampleModels(), "claude", "claude-opus-4-1-20250805");
    expect(options).toContainEqual({
      value: "claude-opus-4-1-20250805",
      label: "claude-opus-4-1-20250805",
      hint: "current — not in the catalog",
    });
    // Placed before the custom escape hatch.
    expect(options.at(-1)?.value).toBe(CUSTOM_MODEL_CHOICE);

    // A current model the catalog already lists gets no duplicate row.
    const inCatalog = buildModelSelectOptions(sampleModels(), "claude", "sonnet");
    expect(inCatalog.filter((option) => option.value === "sonnet")).toHaveLength(1);
  });
});

describe("catalogEffortChoices", () => {
  const okResult: ModelCatalogResult = { status: "ok", models: sampleModels() };

  it("intersects the menu with the entry's levels, preserving menu order", () => {
    expect(catalogEffortChoices(okResult, claudeDraft({ model: "sonnet" }), effortChoices)).toEqual(
      ["off", "minimal", "low", "medium", "high", "max"],
    );
  });

  it("never re-adds levels the adapter did not advertise (mappers are authoritative)", () => {
    // e.g. copilot's SDK cannot disable reasoning, so its entries omit "off"; the shared
    // narrowing must not resurrect it — and "minimal" only appears when the adapter emits it.
    const narrow: ModelCatalogResult = {
      status: "ok",
      models: [{ value: "sonnet", supportedEffortLevels: ["low", "medium", "high"] }],
    };
    expect(catalogEffortChoices(narrow, claudeDraft({ model: "sonnet" }), effortChoices)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("uses the engine default model when the draft has no override", () => {
    // Claude's default model is sonnet, whose sample entry carries levels.
    expect(catalogEffortChoices(okResult, claudeDraft(), effortChoices)).toEqual([
      "off",
      "minimal",
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
