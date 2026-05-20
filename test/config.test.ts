import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDiffwardenConfig } from "../src/core/config.js";

let root: string | undefined;

afterEach(() => {
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

describe("loadDiffwardenConfig", () => {
  it("loads project config from cwd upward to the repo root", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeConfig(root, {
      reviewers: [{ id: "pi-openrouter-high", sdk: "pi", profile: "openrouter-high" }],
    });

    const loaded = await loadDiffwardenConfig({ cwd: nested, repoRoot: root });

    expect(loaded?.path).toBe(path.join(root, "diffwarden.config.json"));
    expect(loaded?.config.reviewers?.[0]).toMatchObject({
      id: "pi-openrouter-high",
      sdk: "pi",
      profile: "openrouter-high",
    });
  });

  it("loads user config when no project config exists", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    const xdg = path.join(root, "xdg");
    const configDir = path.join(xdg, "diffwarden");
    mkdirSync(configDir, { recursive: true });
    writeConfig(configDir, {
      reviewers: [{ id: "claude-deep", sdk: "claude", model: "sonnet" }],
    });

    const loaded = await loadDiffwardenConfig({
      cwd: root,
      repoRoot: root,
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(loaded?.path).toBe(path.join(configDir, "diffwarden.config.json"));
    expect(loaded?.config.reviewers?.[0]?.id).toBe("claude-deep");
  });

  it("rejects invalid config clearly", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [{ id: "bad", sdk: "unknown" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });

  it("rejects duplicate sdk/profile reviewer entries", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        { id: "pi-openrouter-a", sdk: "pi", profile: "openrouter-high" },
        { id: "pi-openrouter-b", sdk: "pi", profile: "openrouter-high" },
      ],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toThrow(
      "Duplicate reviewer profile: pi:openrouter-high",
    );
  });

  it("rejects unsupported configured effort values", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [{ id: "pi", sdk: "pi", effort: "max" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });
});

function writeConfig(dir: string, value: unknown): void {
  writeFileSync(path.join(dir, "diffwarden.config.json"), `${JSON.stringify(value, null, 2)}\n`);
}
