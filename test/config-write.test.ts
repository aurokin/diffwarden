import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addReviewerToUserConfig,
  createDiscoveredUserConfig,
  loadDiffwardenConfig,
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
