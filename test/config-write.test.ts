import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addReviewerToSetInUserConfig,
  addReviewerToUserConfig,
  createDiscoveredUserConfig,
  editReviewerInUserConfig,
  listUserConfigReviewers,
  loadDiffwardenConfig,
  removeReviewerFromSetInUserConfig,
  removeReviewerFromUserConfig,
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
    // antigravity CLI supports neither model nor effort overrides. Transport is omitted here, so
    // the check must resolve the engine default (cli) rather than assuming sdk.
    writeExisting(configPath, {
      reviewers: [{ id: "agy", engine: "antigravity" }],
    });
    const before = readFileSync(configPath, "utf8");

    await expect(
      editReviewerInUserConfig({ id: "agy", patch: { model: "x" }, env }),
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
