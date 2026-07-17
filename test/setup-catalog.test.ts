import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../src/adapters/types.js";
import {
  CUSTOM_MODEL_CHOICE,
  type ModelCatalogDraft,
  type ModelCatalogResult,
  buildModelAutocompleteOptions,
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
    provider: undefined,
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
  it("declares catalog support per engine transport", () => {
    const session = createModelCatalogSession({ fetch: async () => [] });
    expect(session.supports("claude", undefined)).toBe(true);
    expect(session.supports("claude", "sdk")).toBe(true);
    expect(session.supports("claude", "cli")).toBe(false);
    expect(session.supports("cursor", undefined)).toBe(true);
    expect(session.supports("cursor", "cli")).toBe(true);
    expect(session.supports("codex", undefined)).toBe(true);
    expect(session.supports("codex", "app-server")).toBe(true);
    expect(session.supports("pi", undefined)).toBe(true);
    expect(session.supports("pi", "cli")).toBe(true);
    expect(session.supports("opencode", undefined)).toBe(true);
    expect(session.supports("copilot", undefined)).toBe(true);
    expect(session.supports("copilot", "cli")).toBe(true);
    expect(session.supports("droid", undefined)).toBe(true);
    expect(session.supports("droid", "cli")).toBe(true);
    expect(session.supports("grok", undefined)).toBe(false);
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

describe("buildModelAutocompleteOptions", () => {
  const gptModels: ModelCatalogEntry[] = [
    { value: "gpt-5-fast", displayName: "GPT-5 Fast" },
    { value: "gpt-5-high", displayName: "GPT-5 High" },
    { value: "sonnet", displayName: "Sonnet", description: "balanced" },
  ];

  it("returns the full select rows in order on an empty query", () => {
    const rows = buildModelAutocompleteOptions(sampleModels(), "claude", undefined, "");
    expect(rows.map((row) => row.value)).toEqual(["", "default", "sonnet", CUSTOM_MODEL_CHOICE]);
  });

  it("prepends a creatable row carrying the typed slug when no row's value matches exactly", () => {
    const rows = buildModelAutocompleteOptions(gptModels, "codex", undefined, "gpt-5.3-mini");
    // Index 0 is what Enter commits: one Enter after typing an off-catalog slug yields the slug.
    expect(rows[0]).toEqual({
      value: "gpt-5.3-mini",
      label: 'use "gpt-5.3-mini"',
      hint: "off-catalog model id",
    });
  });

  it("ranks a word-boundary catalog match above the creatable row, demoted not dropped", () => {
    // The audit's #1 footgun: typing "fast" then Enter must commit the catalog row the query
    // plainly names, not fork the fragment into an off-catalog id. The creatable row stays
    // reachable just above custom….
    const rows = buildModelAutocompleteOptions(gptModels, "codex", undefined, "fast");
    expect(rows[0]?.value).toBe("gpt-5-fast");
    expect(rows.map((row) => row.value)).toEqual(["gpt-5-fast", "fast", CUSTOM_MODEL_CHOICE]);
  });

  it("keeps index 0 committable across an incremental keystroke sequence", () => {
    // clack keeps focus on a surviving row and only refocuses to index 0 when it drops out,
    // so each intermediate query's index 0 is a potential Enter target — assert the whole
    // sequence, not just the final query.
    const byQuery = (query: string) =>
      buildModelAutocompleteOptions(gptModels, "codex", undefined, query).map((row) => row.value);
    expect(byQuery("s")[0]).toBe("sonnet");
    expect(byQuery("so")[0]).toBe("sonnet");
    expect(byQuery("son")[0]).toBe("sonnet");
    expect(byQuery("sonnet")[0]).toBe("sonnet");
  });

  it("breaks word-boundary ties deterministically: recommended, then shortest, then order", () => {
    const family: ModelCatalogEntry[] = [
      { value: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
      { value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", default: true },
      { value: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" },
    ];
    // Recommended entry wins the shared "gpt" prefix.
    expect(buildModelAutocompleteOptions(family, "codex", undefined, "gpt")[0]?.value).toBe(
      "gpt-5.6-sol",
    );
    // Without a recommended entry, the shortest id wins; equal lengths fall to catalog order.
    const noDefault = family.map(({ value, displayName }) => ({ value, displayName }));
    expect(buildModelAutocompleteOptions(noDefault, "codex", undefined, "gpt")[0]?.value).toBe(
      "gpt-5.6-sol",
    );
    // A pure mid-string fragment never outranks the creatable row.
    const mid = buildModelAutocompleteOptions(family, "codex", undefined, "erra");
    expect(mid[0]?.value).toBe("erra");
  });

  it("hoists an exact value match above earlier substring survivors", () => {
    // Catalog order lists a substring survivor before the exactly-typed id: Enter must
    // commit "sonnet", not "claude-sonnet-4".
    const shadowing: ModelCatalogEntry[] = [
      { value: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
      { value: "sonnet", displayName: "Sonnet" },
    ];
    const rows = buildModelAutocompleteOptions(shadowing, "claude", undefined, "sonnet");
    expect(rows.map((row) => row.value)).toEqual([
      "sonnet",
      "claude-sonnet-4",
      CUSTOM_MODEL_CHOICE,
    ]);
  });

  it("suppresses the creatable row on an exact value match, including case variants", () => {
    const exact = buildModelAutocompleteOptions(gptModels, "codex", undefined, "gpt-5-fast");
    expect(exact[0]?.value).toBe("gpt-5-fast");
    expect(exact[0]?.label).toBe("GPT-5 Fast");
    // A case variant commits the catalog row rather than forking a new slug.
    const cased = buildModelAutocompleteOptions(gptModels, "codex", undefined, "GPT-5-FAST");
    expect(cased[0]?.value).toBe("gpt-5-fast");
  });

  it("treats the synthetic current-model row as exact-matchable too", () => {
    const rows = buildModelAutocompleteOptions(
      gptModels,
      "codex",
      "my-pinned-model",
      "my-pinned-model",
    );
    expect(rows.filter((row) => row.value === "my-pinned-model")).toHaveLength(1);
    expect(rows[0]?.hint).toBe("current — not in the catalog");
  });

  it("filters catalog rows by fragments of value, label, or description", () => {
    const byValue = buildModelAutocompleteOptions(gptModels, "codex", undefined, "sonn");
    expect(byValue.map((row) => row.value)).toEqual(["sonnet", "sonn", CUSTOM_MODEL_CHOICE]);
    const byHint = buildModelAutocompleteOptions(gptModels, "codex", undefined, "balanced");
    expect(byHint.map((row) => row.value)).toContain("sonnet");
  });

  it("matches the default row only against its literal label, never its hint", () => {
    // Claude's default row hints "engine default (sonnet)": a "sonnet" query must not
    // resurface it, or Enter on a model-name query could clear the override.
    const modelQuery = buildModelAutocompleteOptions(sampleModels(), "claude", undefined, "sonnet");
    expect(modelQuery.map((row) => row.value)).not.toContain("");
    const defaultQuery = buildModelAutocompleteOptions(
      sampleModels(),
      "claude",
      undefined,
      "defau",
    );
    expect(defaultQuery.map((row) => row.value)).toContain("");
  });

  it("never creates a row whose value collides with a control sentinel", () => {
    // Selecting use "__quit__" / use "__custom__" would trigger the control action instead
    // of committing the id; such ids remain enterable via the custom… free-text path.
    const custom = buildModelAutocompleteOptions(gptModels, "codex", undefined, "__custom__", [
      "__quit__",
    ]);
    expect(custom.map((row) => row.value)).toEqual([CUSTOM_MODEL_CHOICE]);
    const quit = buildModelAutocompleteOptions(gptModels, "codex", undefined, "__quit__", [
      "__quit__",
    ]);
    expect(quit.map((row) => row.value)).toEqual([CUSTOM_MODEL_CHOICE]);
  });

  it("always retains the custom escape hatch, after the creatable row", () => {
    const rows = buildModelAutocompleteOptions(gptModels, "codex", undefined, "zzz-no-match");
    expect(rows.map((row) => row.value)).toEqual(["zzz-no-match", CUSTOM_MODEL_CHOICE]);
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
