import { describe, expect, it } from "vitest";
import type { ReviewerSdk, ReviewerTransport } from "../src/adapters/capabilities.js";
import type { PublicReviewerEntry } from "../src/core/config.js";
import type { ReviewerCandidateStatus, ReviewerDiscoveryCandidate } from "../src/core/discovery.js";
import {
  availableTransports,
  contextOptions,
  effectiveTransport,
  modelFieldHint,
  reviewerHint,
  toDraft,
  toEntry,
} from "../src/core/setup-clack.js";

// Pure-helper coverage for the interactive setup picker. The flows that call these can't run in CI
// (they need a TTY / raw mode), so these unit tests are the only automated coverage of the draft
// mapping, capability gating, default resolution, and context-row dedup they encode.

function candidate(partial: {
  engine: ReviewerSdk;
  transport: ReviewerTransport;
  status: ReviewerCandidateStatus;
  detail: string;
}): ReviewerDiscoveryCandidate {
  return { authState: "missing", ...partial };
}

describe("toDraft", () => {
  it("maps a minimal entry to a draft with every optional field explicitly undefined", () => {
    expect(toDraft({ id: "pi", engine: "pi" })).toEqual({
      id: "pi",
      engine: "pi",
      transport: undefined,
      provider: undefined,
      model: undefined,
      effort: undefined,
      enabled: undefined,
      profile: undefined,
    });
  });

  it("maps a fully-populated entry field-for-field", () => {
    const entry: PublicReviewerEntry = {
      id: "c",
      engine: "codex",
      transport: "app-server",
      provider: "p",
      model: "m",
      effort: "high",
      enabled: false,
      profile: "pr",
    };
    expect(toDraft(entry)).toEqual(entry);
  });
});

describe("toEntry", () => {
  it("drops undefined keys so an unset override is absent, not undefined", () => {
    const entry = toEntry(toDraft({ id: "pi", engine: "pi" }));
    expect(entry).toEqual({ id: "pi", engine: "pi" });
    expect("model" in entry).toBe(false);
    expect("enabled" in entry).toBe(false);
    expect("transport" in entry).toBe(false);
  });

  it("keeps enabled:false and every explicitly-set field", () => {
    expect(
      toEntry({
        id: "pi",
        engine: "pi",
        transport: "cli",
        provider: undefined,
        model: "m",
        effort: "high",
        enabled: false,
        profile: undefined,
      }),
    ).toEqual({
      id: "pi",
      engine: "pi",
      transport: "cli",
      model: "m",
      effort: "high",
      enabled: false,
    });
  });

  it("round-trips an entry through toDraft unchanged", () => {
    const entry: PublicReviewerEntry = {
      id: "pi",
      engine: "pi",
      transport: "cli",
      model: "m",
      effort: "high",
      enabled: false,
    };
    expect(toEntry(toDraft(entry))).toEqual(entry);
  });
});

describe("effectiveTransport", () => {
  it("returns the explicit transport when the draft sets one", () => {
    expect(effectiveTransport(toDraft({ id: "x", engine: "cursor", transport: "cli" }))).toBe(
      "cli",
    );
  });

  it("falls back to the engine default transport when the draft leaves it unset", () => {
    expect(effectiveTransport(toDraft({ id: "c", engine: "codex" }))).toBe("cli");
  });

  it("falls back to 'sdk' when the engine declares no default transport", () => {
    expect(effectiveTransport(toDraft({ id: "cl", engine: "claude" }))).toBe("sdk");
  });
});

describe("availableTransports", () => {
  it("lists a multi-transport engine's supported transports in registry order (codex)", () => {
    expect(availableTransports("codex")).toEqual(["cli", "app-server"]);
  });

  it("lists cursor's transports as sdk then cli", () => {
    expect(availableTransports("cursor")).toEqual(["sdk", "cli"]);
  });

  it("lists a single-transport engine as just its one transport (gemini)", () => {
    expect(availableTransports("gemini")).toEqual(["cli"]);
  });
});

describe("reviewerHint", () => {
  it("reads 'defaults' when no honorable overrides are set", () => {
    expect(reviewerHint(toDraft({ id: "cl", engine: "claude" }))).toBe("defaults");
  });

  it("joins model and effort when the effective transport supports both", () => {
    expect(
      reviewerHint(
        toDraft({ id: "cl", engine: "claude", transport: "sdk", model: "opus", effort: "high" }),
      ),
    ).toBe("model opus · effort high");
  });

  it("omits an override the effective transport cannot honor (gemini cli effort)", () => {
    expect(
      reviewerHint(toDraft({ id: "g", engine: "gemini", model: "gemini-2.5-pro", effort: "high" })),
    ).toBe("model gemini-2.5-pro");
  });
});

describe("modelFieldHint", () => {
  it("shows an explicit model verbatim", () => {
    expect(modelFieldHint(toDraft({ id: "pi", engine: "pi", model: "anthropic/x" }))).toBe(
      "anthropic/x",
    );
  });

  it("reads 'default (<value>)' when unset and the registry exposes a default model", () => {
    expect(modelFieldHint(toDraft({ id: "cu", engine: "cursor" }))).toBe("default (composer-2.5)");
  });

  it("reads plain 'default' when unset and the engine has no registry default model", () => {
    expect(modelFieldHint(toDraft({ id: "pi", engine: "pi" }))).toBe("default");
  });
});

describe("contextOptions", () => {
  it("builds a disabled context row for a not-ready engine carrying its discovery detail", () => {
    const rows = contextOptions(
      [
        candidate({
          engine: "codex",
          transport: "cli",
          status: "missing_auth",
          detail: "no auth.json",
        }),
      ],
      [],
    );
    expect(rows).toEqual([
      { value: "__context_codex", label: "codex · cli", hint: "no auth.json", disabled: true },
    ]);
  });

  it("skips engines that are available or already in the ready list", () => {
    const rows = contextOptions(
      [
        candidate({ engine: "pi", transport: "sdk", status: "available", detail: "ok" }),
        candidate({ engine: "codex", transport: "cli", status: "missing_auth", detail: "d" }),
      ],
      [{ id: "codex-x", engine: "codex" }],
    );
    expect(rows).toEqual([]);
  });

  it("dedups to the first (best-status-first) non-available candidate per engine", () => {
    const rows = contextOptions(
      [
        candidate({ engine: "codex", transport: "cli", status: "missing_auth", detail: "first" }),
        candidate({
          engine: "codex",
          transport: "app-server",
          status: "missing_executable",
          detail: "second",
        }),
      ],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: "__context_codex", hint: "first" });
  });
});
