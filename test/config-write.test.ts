import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addReviewerToSetInUserConfig,
  addReviewerToUserConfig,
  addReviewersToUserConfig,
  createDiscoveredUserConfig,
  editReviewerInUserConfig,
  listUserConfigReviewerSets,
  listUserConfigReviewers,
  loadDiffwardenConfig,
  loadUserConfigReviewerEntries,
  removeReviewerFromSetInUserConfig,
  removeReviewerFromUserConfig,
  replaceReviewerSetInUserConfig,
  setReviewerInUserConfig,
  userConfigPath,
} from "../src/core/config.js";

let root: string | undefined;

afterEach(() => {
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

function setup(): { env: NodeJS.ProcessEnv; configPath: string } {
  root = mkdtempSync(path.join(tmpdir(), "diffwarden-write-"));
  const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
  return { env, configPath: userConfigPath(env) };
}

function readRaw(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function writeExisting(configPath: string, value: unknown): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("addReviewerToUserConfig", () => {
  it("creates the file when absent and writes the public engine key", async () => {
    const { env, configPath } = setup();

    const result = await addReviewerToUserConfig({
      entry: { id: "codex", engine: "codex" },
      env,
    });

    expect(result.created).toBe(true);
    expect(result.action).toBe("added");
    expect(result.path).toBe(configPath);

    const raw = readRaw(configPath);
    const reviewers = raw.reviewers as Record<string, unknown>[];
    expect(reviewers[0]).toEqual({ id: "codex", engine: "codex" });
    expect(reviewers[0]).not.toHaveProperty("sdk");

    const loaded = await loadDiffwardenConfig({ cwd: root as string, env });
    expect(loaded?.config.reviewers?.[0]).toMatchObject({ id: "codex", sdk: "codex" });
  });

  it("merges by id in place instead of duplicating", async () => {
    const { env, configPath } = setup();

    await addReviewerToUserConfig({ entry: { id: "codex", engine: "codex" }, env });
    const second = await addReviewerToUserConfig({
      entry: { id: "codex", engine: "codex", model: "gpt-5.5" },
      env,
    });

    expect(second.action).toBe("updated");
    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]).toMatchObject({ id: "codex", engine: "codex", model: "gpt-5.5" });
  });

  it("merges fields on update instead of replacing the entry", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [
        {
          id: "pi",
          engine: "pi",
          model: "anthropic/claude-sonnet",
          effort: "high",
          sdkOptions: { authSource: "shared" },
        },
      ],
    });

    // Re-add the same id to change only the model (e.g. via `reviewers add pi --model ...`).
    await addReviewerToUserConfig({ entry: { id: "pi", engine: "pi", model: "gpt-5.5" }, env });

    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers).toHaveLength(1);
    // New field applied; untouched fields preserved rather than dropped.
    expect(reviewers[0]).toMatchObject({
      id: "pi",
      engine: "pi",
      model: "gpt-5.5",
      effort: "high",
      sdkOptions: { authSource: "shared" },
    });
  });

  it("appends distinct reviewers", async () => {
    const { env, configPath } = setup();

    await addReviewerToUserConfig({ entry: { id: "codex", engine: "codex" }, env });
    await addReviewerToUserConfig({ entry: { id: "claude", engine: "claude" }, env });

    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers.map((r) => r.id)).toEqual(["codex", "claude"]);
  });

  it("preserves defaultReviewerSet and other keys", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "main",
      reviewerSets: { main: ["codex"] },
      reviewPlan: { includeOverview: false },
      readonly: true,
      reviewers: [{ id: "codex", engine: "codex" }],
    });

    await addReviewerToUserConfig({ entry: { id: "claude", engine: "claude" }, env });

    const raw = readRaw(configPath);
    expect(raw.defaultReviewerSet).toBe("main");
    expect(raw.reviewerSets).toEqual({ main: ["codex"] });
    expect(raw.reviewPlan).toEqual({ includeOverview: false });
    expect(raw.readonly).toBe(true);
  });

  it("appends to a reviewer set without touching the default", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "main",
      reviewerSets: { main: ["codex"] },
      reviewers: [{ id: "codex", engine: "codex" }],
    });

    await addReviewerToUserConfig({
      entry: { id: "claude", engine: "claude" },
      reviewerSet: "main",
      env,
    });

    const raw = readRaw(configPath);
    expect(raw.reviewerSets).toEqual({ main: ["codex", "claude"] });
    expect(raw.defaultReviewerSet).toBe("main");
  });

  it("creates a reviewer set when it does not exist yet", async () => {
    const { env, configPath } = setup();

    await addReviewerToUserConfig({
      entry: { id: "codex", engine: "codex" },
      reviewerSet: "fast",
      env,
    });

    expect((readRaw(configPath).reviewerSets as Record<string, string[]>).fast).toEqual(["codex"]);
  });

  it("writes enabled:false for a disabled placeholder and omits enabled when active", async () => {
    const { env, configPath } = setup();

    await addReviewerToUserConfig({
      entry: { id: "grok", engine: "grok", enabled: false },
      env,
    });
    await addReviewerToUserConfig({ entry: { id: "codex", engine: "codex" }, env });

    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    const grok = reviewers.find((r) => r.id === "grok");
    const codex = reviewers.find((r) => r.id === "codex");
    expect(grok).toMatchObject({ enabled: false });
    expect(codex).not.toHaveProperty("enabled");
  });

  it("refuses to write a CLI-only engine with sdk transport and leaves no file", async () => {
    const { env, configPath } = setup();

    await expect(
      addReviewerToUserConfig({
        entry: { id: "codex", engine: "codex", transport: "sdk" },
        env,
      }),
    ).rejects.toThrow(/CLI transport|app-server transport/);
    expect(existsSync(configPath)).toBe(false);
  });

  it("aborts on a sha256 mismatch", async () => {
    const { env } = setup();
    await addReviewerToUserConfig({ entry: { id: "codex", engine: "codex" }, env });

    await expect(
      addReviewerToUserConfig({
        entry: { id: "claude", engine: "claude" },
        env,
        expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow(/changed on disk/);
  });

  it("rejects a duplicate engine:profile under a different id", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [{ id: "pi-a", engine: "pi", profile: "openrouter-high" }],
    });

    await expect(
      addReviewerToUserConfig({
        entry: { id: "pi-b", engine: "pi", profile: "openrouter-high" },
        env,
      }),
    ).rejects.toThrow(/profile/);
  });
});

describe("createDiscoveredUserConfig", () => {
  it("scaffolds a fresh config with a default reviewer set", async () => {
    const { env, configPath } = setup();

    const written = await createDiscoveredUserConfig({
      reviewers: [
        { id: "codex", engine: "codex" },
        { id: "cursor", engine: "cursor", model: "composer-2.5" },
      ],
      env,
    });

    expect(written).toBe(configPath);
    const raw = readRaw(configPath);
    expect(raw.defaultReviewerSet).toBe("1");
    expect(raw.reviewerSets).toEqual({ "1": ["codex", "cursor"] });
    expect(raw.readonly).toBe(true);

    const loaded = await loadDiffwardenConfig({ cwd: root as string, env });
    expect(loaded?.config.reviewers?.map((r) => r.sdk)).toEqual(["codex", "cursor"]);
  });

  it("never clobbers an existing config", async () => {
    const { env } = setup();
    await createDiscoveredUserConfig({ reviewers: [{ id: "codex", engine: "codex" }], env });

    await expect(
      createDiscoveredUserConfig({ reviewers: [{ id: "codex", engine: "codex" }], env }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an empty reviewer list", async () => {
    const { env } = setup();
    await expect(createDiscoveredUserConfig({ reviewers: [], env })).rejects.toThrow();
  });
});

describe("removeReviewerFromUserConfig", () => {
  it("removes the entry and prunes it from every reviewer set", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "main",
      reviewerSets: { main: ["codex", "claude"], extra: ["claude"] },
      reviewers: [
        { id: "codex", engine: "codex" },
        { id: "claude", engine: "claude" },
      ],
    });

    const result = await removeReviewerFromUserConfig({ id: "claude", env });

    expect(result.prunedFromSets.sort()).toEqual(["extra", "main"]);
    const raw = readRaw(configPath);
    expect((raw.reviewers as Record<string, unknown>[]).map((r) => r.id)).toEqual(["codex"]);
    expect(raw.reviewerSets).toEqual({ main: ["codex"], extra: [] });
  });

  it("errors and writes nothing when the id is absent", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "codex", engine: "codex" }] });
    const before = readFileSync(configPath, "utf8");

    await expect(removeReviewerFromUserConfig({ id: "ghost", env })).rejects.toThrow(
      /No reviewer with id "ghost"/,
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("refuses to empty the default reviewer set without --force", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "main",
      reviewerSets: { main: ["codex"] },
      reviewers: [{ id: "codex", engine: "codex" }],
    });
    const before = readFileSync(configPath, "utf8");

    await expect(removeReviewerFromUserConfig({ id: "codex", env })).rejects.toThrow(
      /default reviewer set "main" empty/,
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("removes anyway with --force, leaving the default set empty", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "main",
      reviewerSets: { main: ["codex"] },
      reviewers: [{ id: "codex", engine: "codex" }],
    });

    await removeReviewerFromUserConfig({ id: "codex", force: true, env });

    const raw = readRaw(configPath);
    expect(raw.reviewers).toEqual([]);
    expect(raw.reviewerSets).toEqual({ main: [] });
    expect(raw.defaultReviewerSet).toBe("main");
  });
});

describe("editReviewerInUserConfig", () => {
  it("patches only the named field and preserves the rest", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [
        {
          id: "pi",
          engine: "pi",
          model: "anthropic/claude-sonnet",
          effort: "high",
          sdkOptions: { authSource: "shared" },
        },
      ],
    });

    const result = await editReviewerInUserConfig({ id: "pi", patch: { model: "gpt-5.5" }, env });

    expect(result.reviewer).toMatchObject({ id: "pi", model: "gpt-5.5", effort: "high" });
    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers[0]).toEqual({
      id: "pi",
      engine: "pi",
      model: "gpt-5.5",
      effort: "high",
      sdkOptions: { authSource: "shared" },
    });
  });

  it("toggles enabled: --disabled sets the flag, --enabled clears it", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "codex", engine: "codex" }] });

    await editReviewerInUserConfig({ id: "codex", patch: { enabled: false }, env });
    expect((readRaw(configPath).reviewers as Record<string, unknown>[])[0]).toMatchObject({
      enabled: false,
    });

    await editReviewerInUserConfig({ id: "codex", patch: { enabled: true }, env });
    expect((readRaw(configPath).reviewers as Record<string, unknown>[])[0]).not.toHaveProperty(
      "enabled",
    );
  });

  it("rejects an override the resulting transport cannot honor and writes nothing", async () => {
    const { env, configPath } = setup();
    // Gemini CLI does not support effort overrides. Transport is omitted here, so
    // the check must resolve the engine default (cli) rather than assuming sdk.
    writeExisting(configPath, {
      reviewers: [{ id: "gemini", engine: "gemini" }],
    });
    const before = readFileSync(configPath, "utf8");

    await expect(
      editReviewerInUserConfig({ id: "gemini", patch: { effort: "high" }, env }),
    ).rejects.toThrow(/does not support/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("errors when the id is absent", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "codex", engine: "codex" }] });

    await expect(
      editReviewerInUserConfig({ id: "ghost", patch: { model: "x" }, env }),
    ).rejects.toThrow(/No reviewer with id "ghost"/);
  });

  it("rejects editing a reviewer with an unknown engine cleanly, writing nothing", async () => {
    const { env, configPath } = setup();
    // A hand-edited/legacy config can carry an engine the registry does not know; editing it must
    // fail with a clean config error rather than crashing on a capability lookup.
    writeExisting(configPath, { reviewers: [{ id: "legacy", engine: "bogus", model: "x" }] });
    const before = readFileSync(configPath, "utf8");

    await expect(
      editReviewerInUserConfig({ id: "legacy", patch: { model: "y" }, env }),
    ).rejects.toThrow(/unknown engine/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

describe("reviewer set membership", () => {
  it("adds a configured reviewer id to a set, creating the set", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "codex", engine: "codex" }] });

    const result = await addReviewerToSetInUserConfig({
      setName: "fast",
      reviewerId: "codex",
      env,
    });

    expect(result.members).toEqual(["codex"]);
    expect((readRaw(configPath).reviewerSets as Record<string, string[]>).fast).toEqual(["codex"]);
  });

  it("refuses to add an unconfigured reviewer id to a set", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "codex", engine: "codex" }] });

    await expect(
      addReviewerToSetInUserConfig({ setName: "fast", reviewerId: "ghost", env }),
    ).rejects.toThrow(/No reviewer with id "ghost"/);
  });

  it("removes a reviewer id from a set", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewerSets: { fast: ["codex", "claude"] },
      reviewers: [
        { id: "codex", engine: "codex" },
        { id: "claude", engine: "claude" },
      ],
    });

    const result = await removeReviewerFromSetInUserConfig({
      setName: "fast",
      reviewerId: "claude",
      env,
    });

    expect(result.members).toEqual(["codex"]);
    expect((readRaw(configPath).reviewerSets as Record<string, string[]>).fast).toEqual(["codex"]);
  });

  it("errors when the set does not contain the id", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewerSets: { fast: ["codex"] },
      reviewers: [{ id: "codex", engine: "codex" }],
    });

    await expect(
      removeReviewerFromSetInUserConfig({ setName: "fast", reviewerId: "ghost", env }),
    ).rejects.toThrow(/does not contain/);
  });

  it("refuses to empty the default set without --force, then succeeds with it", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "fast",
      reviewerSets: { fast: ["codex"] },
      reviewers: [{ id: "codex", engine: "codex" }],
    });

    await expect(
      removeReviewerFromSetInUserConfig({ setName: "fast", reviewerId: "codex", env }),
    ).rejects.toThrow(/default reviewer set "fast" empty/);

    await removeReviewerFromSetInUserConfig({
      setName: "fast",
      reviewerId: "codex",
      force: true,
      env,
    });
    expect((readRaw(configPath).reviewerSets as Record<string, string[]>).fast).toEqual([]);
  });
});

describe("replaceReviewerSetInUserConfig", () => {
  const twoReviewers = [
    { id: "codex", engine: "codex" },
    { id: "claude", engine: "claude" },
  ];

  it("replaces membership wholesale, creating the set and deduplicating", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: twoReviewers });

    const result = await replaceReviewerSetInUserConfig({
      setName: "fast",
      members: ["codex", "claude", "codex"],
      env,
    });

    expect(result.members).toEqual(["codex", "claude"]);
    expect((readRaw(configPath).reviewerSets as Record<string, string[]>).fast).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("persists a set literally named __proto__ as an own property", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: twoReviewers });

    const result = await replaceReviewerSetInUserConfig({
      setName: "__proto__",
      members: ["codex"],
      env,
    });

    expect(result.members).toEqual(["codex"]);
    const sets = readRaw(configPath).reviewerSets as Record<string, string[]>;
    expect(Object.hasOwn(sets, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(sets, "__proto__")?.value).toEqual(["codex"]);
  });

  it("makes the set the default when asked", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "old",
      reviewerSets: { old: ["codex"] },
      reviewers: twoReviewers,
    });

    await replaceReviewerSetInUserConfig({
      setName: "fast",
      members: ["claude"],
      makeDefault: true,
      env,
    });
    expect(readRaw(configPath).defaultReviewerSet).toBe("fast");
  });

  it("refuses unconfigured member ids and writes nothing", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: twoReviewers });

    await expect(
      replaceReviewerSetInUserConfig({ setName: "fast", members: ["ghost"], env }),
    ).rejects.toThrow(/No reviewer with id "ghost"/);
    expect(readRaw(configPath)).not.toHaveProperty("reviewerSets");
  });

  it("refuses to empty the default set without force", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "fast",
      reviewerSets: { fast: ["codex"] },
      reviewers: twoReviewers,
    });

    await expect(
      replaceReviewerSetInUserConfig({ setName: "fast", members: [], env }),
    ).rejects.toThrow(/default reviewer set "fast" empty/);
  });

  it("aborts on a sha256 mismatch instead of clobbering concurrent edits", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: twoReviewers });

    await expect(
      replaceReviewerSetInUserConfig({
        setName: "fast",
        members: ["codex"],
        expectedSha256: "stale",
        env,
      }),
    ).rejects.toThrow(/changed on disk/);
  });
});

describe("listUserConfigReviewerSets", () => {
  it("returns sets, the default set, and a read-time sha", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "1",
      reviewerSets: { "1": ["codex"], fast: ["codex", "claude"] },
      reviewers: [{ id: "codex", engine: "codex" }],
    });

    const result = await listUserConfigReviewerSets({ env });
    expect(result.sets).toEqual({ "1": ["codex"], fast: ["codex", "claude"] });
    expect(result.defaultReviewerSet).toBe("1");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists a set literally named __proto__ instead of dropping it", async () => {
    const { env, configPath } = setup();
    // Raw JSON: a JS object literal with a "__proto__" key would set the prototype instead.
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        reviewers: [{ id: "codex", engine: "codex" }],
      }).replace('"reviewers"', '"reviewerSets":{"__proto__":["codex"]},"reviewers"'),
    );

    const result = await listUserConfigReviewerSets({ env });
    expect(Object.hasOwn(result.sets, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result.sets, "__proto__")?.value).toEqual(["codex"]);
  });

  it("throws when no user config exists", async () => {
    const { env } = setup();
    await expect(listUserConfigReviewerSets({ env })).rejects.toThrow(/No diffwarden user config/);
  });
});

describe("listUserConfigReviewers", () => {
  it("summarizes configured reviewers by id, engine, and enabled state", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [
        { id: "codex", engine: "codex" },
        { id: "cursor", engine: "cursor", enabled: false },
      ],
    });

    const { path, reviewers } = await listUserConfigReviewers({ env });

    expect(path).toBe(configPath);
    expect(reviewers).toEqual([
      { id: "codex", engine: "codex", enabled: true },
      { id: "cursor", engine: "cursor", enabled: false },
    ]);
  });

  it("skips entries without a string id since they cannot be targeted", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [{ engine: "codex" }, { id: "cursor", engine: "cursor" }],
    });

    const { reviewers } = await listUserConfigReviewers({ env });

    expect(reviewers).toEqual([{ id: "cursor", engine: "cursor", enabled: true }]);
  });

  it("throws when no user config exists", async () => {
    const { env } = setup();

    await expect(listUserConfigReviewers({ env })).rejects.toThrow(/No diffwarden user config/);
  });
});

describe("addReviewersToUserConfig", () => {
  it("adds several reviewers in one write, creating the file, with per-entry actions", async () => {
    const { env, configPath } = setup();

    const result = await addReviewersToUserConfig({
      entries: [
        { id: "codex", engine: "codex" },
        { id: "grok", engine: "grok" },
      ],
      env,
    });

    expect(result.created).toBe(true);
    expect(result.actions).toEqual(["added", "added"]);
    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers.map((r) => r.id)).toEqual(["codex", "grok"]);
  });

  it("appends every id to a named reviewer set without touching the default", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "main",
      reviewerSets: { main: ["codex"] },
      reviewers: [{ id: "codex", engine: "codex" }],
    });

    await addReviewersToUserConfig({
      entries: [
        { id: "grok", engine: "grok" },
        { id: "claude", engine: "claude" },
      ],
      reviewerSet: "extra",
      env,
    });

    const raw = readRaw(configPath);
    expect(raw.defaultReviewerSet).toBe("main");
    expect((raw.reviewerSets as Record<string, string[]>).extra).toEqual(["grok", "claude"]);
  });

  it("is atomic: a mid-batch failure persists nothing (all-or-none)", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [{ id: "pi-a", engine: "pi", profile: "shared" }],
    });
    const before = readFileSync(configPath, "utf8");

    // The second entry collides on engine:profile under a different id, so mergeReviewerById throws
    // mid-batch. The first entry must NOT be persisted — the whole write is rolled back.
    await expect(
      addReviewersToUserConfig({
        entries: [
          { id: "codex", engine: "codex" },
          { id: "pi-b", engine: "pi", profile: "shared" },
        ],
        env,
      }),
    ).rejects.toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("creates the file under expectAbsent when the config is genuinely absent", async () => {
    const { env, configPath } = setup();

    const result = await addReviewersToUserConfig({
      entries: [{ id: "codex", engine: "codex" }],
      env,
      expectAbsent: true,
    });

    expect(result.created).toBe(true);
    expect((readRaw(configPath).reviewers as Record<string, unknown>[]).map((r) => r.id)).toEqual([
      "codex",
    ]);
  });

  it("aborts under expectAbsent when a config appeared during the prompt window, writing nothing", async () => {
    const { env, configPath } = setup();
    // Simulate a concurrent `init`/`add` that created the config while the picker was open: the
    // caller seeded reserved ids from an absent config, so the write must refuse to merge into it.
    writeExisting(configPath, { reviewers: [{ id: "codex", engine: "codex" }] });
    const before = readFileSync(configPath, "utf8");

    await expect(
      addReviewersToUserConfig({
        entries: [{ id: "grok", engine: "grok" }],
        env,
        expectAbsent: true,
      }),
    ).rejects.toThrow(/Config changed on disk since it was read/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("aborts when a token's config was deleted during the window, recreating nothing", async () => {
    const { env, configPath } = setup();
    // A config with a reviewer set existed when the picker opened; capture its real hash.
    const seeded = await addReviewersToUserConfig({
      entries: [{ id: "codex", engine: "codex" }],
      reviewerSet: "main",
      env,
    });
    // Another process deletes the config while the picker is open.
    rmSync(configPath);

    await expect(
      addReviewersToUserConfig({
        entries: [{ id: "grok", engine: "grok" }],
        env,
        expectedSha256: seeded.sha256,
      }),
    ).rejects.toThrow(/Config changed on disk since it was read/);
    // It must NOT recreate a partial file that silently drops the prior reviewer and its set.
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("setReviewerInUserConfig", () => {
  it("replaces the model and clears the transport/effort/provider the entry omits", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [
        {
          id: "pi",
          engine: "pi",
          transport: "cli",
          model: "anthropic/claude-sonnet",
          effort: "high",
          provider: "openrouter",
          sdkOptions: { authSource: "shared" },
        },
      ],
    });

    const result = await setReviewerInUserConfig({
      id: "pi",
      entry: { id: "pi", engine: "pi", model: "gpt-5.5" },
      env,
    });

    const expected = {
      id: "pi",
      engine: "pi",
      model: "gpt-5.5",
      sdkOptions: { authSource: "shared" },
    };
    expect(result.reviewer).toEqual(expected);
    const reviewer = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewer[0]).toEqual(expected);
    expect(reviewer[0]).not.toHaveProperty("transport");
    expect(reviewer[0]).not.toHaveProperty("effort");
    expect(reviewer[0]).not.toHaveProperty("provider");
  });

  it("clears model, effort, and provider back to defaults when the entry carries none of them", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [{ id: "pi", engine: "pi", provider: "openrouter", model: "x", effort: "high" }],
    });

    await setReviewerInUserConfig({ id: "pi", entry: { id: "pi", engine: "pi" }, env });

    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers[0]).toEqual({ id: "pi", engine: "pi" });
  });

  it("preserves sdkOptions, cliOptions, and other unmanaged keys through the replace", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [
        {
          id: "pi",
          engine: "pi",
          model: "x",
          sdkOptions: { authSource: "shared" },
          cliOptions: { flag: true },
          timeoutSeconds: 120,
        },
      ],
    });

    await setReviewerInUserConfig({
      id: "pi",
      entry: { id: "pi", engine: "pi", effort: "low" },
      env,
    });

    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers[0]).toEqual({
      id: "pi",
      engine: "pi",
      effort: "low",
      sdkOptions: { authSource: "shared" },
      cliOptions: { flag: true },
      timeoutSeconds: 120,
    });
  });

  it("persists enabled:false for a disabled placeholder", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "pi", engine: "pi" }] });

    await setReviewerInUserConfig({
      id: "pi",
      entry: { id: "pi", engine: "pi", enabled: false },
      env,
    });

    const reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers[0]).toEqual({ id: "pi", engine: "pi", enabled: false });
  });

  it("omits enabled when the entry is enabled (true) or leaves it unset", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "pi", engine: "pi", enabled: false }] });

    await setReviewerInUserConfig({
      id: "pi",
      entry: { id: "pi", engine: "pi", enabled: true },
      env,
    });
    let reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers[0]).not.toHaveProperty("enabled");

    await setReviewerInUserConfig({ id: "pi", entry: { id: "pi", engine: "pi" }, env });
    reviewers = readRaw(configPath).reviewers as Record<string, unknown>[];
    expect(reviewers[0]).not.toHaveProperty("enabled");
  });

  it("throws on an unknown id and writes nothing", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "pi", engine: "pi" }] });
    const before = readFileSync(configPath, "utf8");

    await expect(
      setReviewerInUserConfig({ id: "ghost", entry: { id: "ghost", engine: "pi" }, env }),
    ).rejects.toThrow(/No reviewer with id "ghost"/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects an effort the effective (default) transport cannot honor and writes nothing", async () => {
    // gemini omits transport, so the validator resolves its engine-default cli transport, whose
    // supportsEffort is false. (This rejection only fires for cli/app-server transports —
    // validateReviewerCapabilityOverrides returns early for native/sdk transport.)
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "gem", engine: "gemini" }] });
    const before = readFileSync(configPath, "utf8");

    await expect(
      setReviewerInUserConfig({
        id: "gem",
        entry: { id: "gem", engine: "gemini", effort: "high" },
        env,
      }),
    ).rejects.toThrow(/does not support/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects a reviewer whose entry-supplied engine is unknown, writing nothing", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "legacy", engine: "pi" }] });
    const before = readFileSync(configPath, "utf8");

    await expect(
      setReviewerInUserConfig({
        id: "legacy",
        entry: { id: "legacy", engine: "bogus" as never },
        env,
      }),
    ).rejects.toThrow(/unknown engine/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("leaves defaultReviewerSet, reviewerSets, and sibling reviewers untouched", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      defaultReviewerSet: "main",
      reviewerSets: { main: ["pi", "codex"] },
      reviewers: [
        { id: "pi", engine: "pi", model: "x" },
        { id: "codex", engine: "codex" },
      ],
    });

    await setReviewerInUserConfig({ id: "pi", entry: { id: "pi", engine: "pi", model: "y" }, env });

    const raw = readRaw(configPath);
    expect(raw.defaultReviewerSet).toBe("main");
    expect(raw.reviewerSets).toEqual({ main: ["pi", "codex"] });
    const reviewers = raw.reviewers as Record<string, unknown>[];
    expect(reviewers[1]).toEqual({ id: "codex", engine: "codex" });
    expect(reviewers[0]).toMatchObject({ id: "pi", model: "y" });
  });

  it("aborts on a sha256 mismatch and writes nothing", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "pi", engine: "pi" }] });
    const before = readFileSync(configPath, "utf8");

    await expect(
      setReviewerInUserConfig({
        id: "pi",
        entry: { id: "pi", engine: "pi", model: "x" },
        env,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/changed on disk/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("throws when no user config exists yet", async () => {
    const { env } = setup();

    await expect(
      setReviewerInUserConfig({ id: "pi", entry: { id: "pi", engine: "pi" }, env }),
    ).rejects.toThrow(/No diffwarden user config/);
  });
});

describe("loadUserConfigReviewerEntries", () => {
  it("returns full public entries with every editor-visible field, plus the config path", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [
        {
          id: "pi",
          engine: "pi",
          transport: "cli",
          model: "anthropic/claude-sonnet",
          effort: "high",
          provider: "openrouter",
          profile: "p1",
          enabled: false,
        },
      ],
    });

    const { path, entries } = await loadUserConfigReviewerEntries({ env });

    expect(path).toBe(configPath);
    expect(entries).toEqual([
      {
        id: "pi",
        engine: "pi",
        transport: "cli",
        profile: "p1",
        provider: "openrouter",
        enabled: false,
        model: "anthropic/claude-sonnet",
        effort: "high",
      },
    ]);
  });

  it("skips reviewers without a string id", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ engine: "codex" }, { id: "ok", engine: "codex" }] });

    const { entries } = await loadUserConfigReviewerEntries({ env });

    expect(entries).toEqual([{ id: "ok", engine: "codex" }]);
  });

  it("skips reviewers whose engine is unknown to the registry", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, {
      reviewers: [
        { id: "legacy", engine: "bogus" },
        { id: "ok", engine: "pi" },
      ],
    });

    const { entries } = await loadUserConfigReviewerEntries({ env });

    expect(entries).toEqual([{ id: "ok", engine: "pi" }]);
  });

  it("drops a transport that is not a recognized transport string", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "pi", engine: "pi", transport: "bogus" }] });

    const { entries } = await loadUserConfigReviewerEntries({ env });

    expect(entries[0]).toEqual({ id: "pi", engine: "pi" });
  });

  it("returns an empty entries array when the config has no reviewers key", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { defaultReviewerSet: "1" });

    const { path, entries } = await loadUserConfigReviewerEntries({ env });

    expect(path).toBe(configPath);
    expect(entries).toEqual([]);
  });

  it("throws when no user config exists", async () => {
    const { env } = setup();

    await expect(loadUserConfigReviewerEntries({ env })).rejects.toThrow(
      /No diffwarden user config/,
    );
  });

  it("returns a sha256 that round-trips as the setReviewerInUserConfig concurrency token", async () => {
    const { env, configPath } = setup();
    writeExisting(configPath, { reviewers: [{ id: "pi", engine: "pi", model: "x" }] });

    // The just-read hash lets a save through — this is what the interactive editor passes back.
    const loaded = await loadUserConfigReviewerEntries({ env });
    await expect(
      setReviewerInUserConfig({
        id: "pi",
        entry: { id: "pi", engine: "pi", model: "y" },
        env,
        expectedSha256: loaded.sha256,
      }),
    ).resolves.toMatchObject({ reviewer: { model: "y" } });

    // A concurrent external write makes an earlier hash stale, so a save with it is rejected instead
    // of clobbering the newer state — the guard the interactive edit flow needs across its prompt window.
    const staleToken = (await loadUserConfigReviewerEntries({ env })).sha256;
    writeExisting(configPath, { reviewers: [{ id: "pi", engine: "pi", model: "z" }] });
    await expect(
      setReviewerInUserConfig({
        id: "pi",
        entry: { id: "pi", engine: "pi", model: "w" },
        env,
        expectedSha256: staleToken,
      }),
    ).rejects.toThrow(/changed on disk/);
    expect((readRaw(configPath).reviewers as Record<string, unknown>[])[0]).toMatchObject({
      model: "z",
    });
  });
});
