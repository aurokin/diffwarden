import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDiffwardenConfig, loadDiffwardenConfig } from "../src/core/config.js";

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
      reviewers: [{ id: "pi-openrouter-high", engine: "pi", profile: "openrouter-high" }],
    });

    const loaded = await loadDiffwardenConfig({ cwd: nested, repoRoot: root });

    expect(loaded?.path).toBe(path.join(root, "diffwarden.config.json"));
    expect(loaded?.sha256).toBe(
      sha256(readFileSync(path.join(root, "diffwarden.config.json"), "utf8")),
    );
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
      reviewers: [{ id: "claude-deep", engine: "claude", model: "sonnet" }],
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
      reviewers: [{ id: "bad", engine: "unknown" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });

  it("rejects reviewers without an engine", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [{ id: "bad" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });

  it("rejects duplicate engine/profile reviewer entries", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        { id: "pi-openrouter-a", engine: "pi", profile: "openrouter-high" },
        { id: "pi-openrouter-b", engine: "pi", profile: "openrouter-high" },
      ],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toThrow(
      "Duplicate reviewer profile: pi:openrouter-high",
    );
  });

  it("rejects unsupported configured effort values", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [{ id: "pi", engine: "pi", effort: "max" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });

  it("loads CLI transport configuration for executable-backed reviewers", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        {
          id: "codex-cli",
          engine: "codex",
          transport: "cli",
          cliOptions: {
            executable: "/opt/homebrew/bin/codex",
            webSearch: "inherit",
          },
        },
      ],
    });

    const loaded = await loadDiffwardenConfig({ cwd: root, repoRoot: root });

    expect(loaded?.config.reviewers?.[0]).toMatchObject({
      id: "codex-cli",
      sdk: "codex",
      transport: "cli",
      cliOptions: {
        executable: "/opt/homebrew/bin/codex",
        webSearch: "inherit",
      },
    });
  });

  it("loads disabled configured reviewers without normalizing omitted enabled flags", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        { id: "droid-temporary-offline", engine: "droid", enabled: false },
        { id: "pi-default", engine: "pi" },
      ],
    });

    const loaded = await loadDiffwardenConfig({ cwd: root, repoRoot: root });

    expect(loaded?.config.reviewers?.[0]).toMatchObject({
      id: "droid-temporary-offline",
      sdk: "droid",
      enabled: false,
    });
    expect(loaded?.config.reviewers?.[1]).toEqual({
      id: "pi-default",
      sdk: "pi",
    });
  });

  it("loads Codex app-server transport configuration", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        {
          id: "codex-app-server",
          engine: "codex",
          transport: "app-server",
          cliOptions: {
            executable: "/opt/homebrew/bin/codex",
          },
        },
      ],
    });

    const loaded = await loadDiffwardenConfig({ cwd: root, repoRoot: root });

    expect(loaded?.config.reviewers?.[0]).toMatchObject({
      id: "codex-app-server",
      sdk: "codex",
      transport: "app-server",
      cliOptions: {
        executable: "/opt/homebrew/bin/codex",
      },
    });
  });

  it("loads Codex app-server reuse options", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        {
          id: "codex-app-server",
          engine: "codex",
          transport: "app-server",
          appServerOptions: {
            mode: "attach",
            codexHome: "~/.codex-diffwarden",
            webSearch: "disabled",
            reviewMode: "native",
          },
        },
      ],
    });

    const loaded = await loadDiffwardenConfig({ cwd: root, repoRoot: root });

    expect(loaded?.config.reviewers?.[0]).toMatchObject({
      id: "codex-app-server",
      sdk: "codex",
      transport: "app-server",
      appServerOptions: {
        mode: "attach",
        codexHome: "~/.codex-diffwarden",
        webSearch: "disabled",
        reviewMode: "native",
      },
    });
  });

  it("rejects app-server transport for non-Codex reviewers", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        {
          id: "claude-app-server",
          engine: "claude",
          transport: "app-server",
        },
      ],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toThrow(
      "does not support app-server transport for engine: claude",
    );
  });

  it("loads canonical engine and SDK transport configuration", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [
        {
          id: "claude-sdk",
          engine: "claude",
          transport: "sdk",
        },
      ],
    });

    const loaded = await loadDiffwardenConfig({ cwd: root, repoRoot: root });

    expect(loaded?.config.reviewers?.[0]).toEqual({
      id: "claude-sdk",
      sdk: "claude",
      transport: "sdk",
    });
  });

  it("rejects removed legacy reviewer config fields", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [{ id: "pi-default", sdk: "pi" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });

  it("rejects removed native transport alias", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [{ id: "claude-native", engine: "claude", transport: "native" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });

  it("loads reporting configuration", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reporting: {
        enabled: true,
        scope: "repo",
        dir: ".reports",
        mode: "metadata",
      },
    });

    const loaded = await loadDiffwardenConfig({ cwd: root, repoRoot: root });

    expect(loaded?.config.reporting).toEqual({
      enabled: true,
      scope: "repo",
      dir: ".reports",
      mode: "metadata",
    });
  });

  it("rejects unsupported reporting scopes", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reporting: {
        enabled: true,
        scope: "workspace",
      },
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
  });

  it("rejects SDK transport for CLI-only reviewers", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    writeConfig(root, {
      reviewers: [{ id: "codex-sdk", engine: "codex", transport: "sdk" }],
    });

    await expect(loadDiffwardenConfig({ cwd: root, repoRoot: root })).rejects.toThrow(
      "must use CLI transport",
    );
  });
});

describe("initDiffwardenConfig", () => {
  it("creates a starter user config under XDG_CONFIG_HOME", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    const configPath = await initDiffwardenConfig({ env: { XDG_CONFIG_HOME: root } });

    expect(configPath).toBe(path.join(root, "diffwarden", "diffwarden.config.json"));
    expect(existsSync(configPath)).toBe(true);

    const loaded = await loadDiffwardenConfig({
      cwd: root,
      repoRoot: root,
      env: { XDG_CONFIG_HOME: root },
    });

    expect(loaded?.config.defaultReviewerSet).toBe("1");
    expect(loaded?.config.reviewerSets).toEqual({ "1": ["pi-default"] });
    expect(loaded?.config.reviewers).toEqual([{ id: "pi-default", sdk: "pi" }]);
    expect(readFileSync(configPath, "utf8")).toContain('"engine": "pi"');
  });

  it("refuses to overwrite an existing user config", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    const configDir = path.join(root, "diffwarden");
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "diffwarden.config.json");
    writeFileSync(configPath, "{}\n");

    await expect(initDiffwardenConfig({ env: { XDG_CONFIG_HOME: root } })).rejects.toMatchObject({
      code: "invalid_config",
      exitCode: 2,
    });
    expect(readFileSync(configPath, "utf8")).toBe("{}\n");
  });

  it("treats empty XDG_CONFIG_HOME as unset", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    const configPath = await initDiffwardenConfig({ env: { HOME: root, XDG_CONFIG_HOME: "" } });
    expect(configPath).toBe(path.join(root, ".config", "diffwarden", "diffwarden.config.json"));
  });

  it("treats empty HOME as unset", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-config-"));
    const configPath = await initDiffwardenConfig({
      env: { HOME: "", XDG_CONFIG_HOME: "" },
      homeDir: root,
    });
    expect(configPath).toBe(path.join(root, ".config", "diffwarden", "diffwarden.config.json"));
    expect(path.isAbsolute(configPath)).toBe(true);
  });
});

function writeConfig(dir: string, value: unknown): void {
  writeFileSync(path.join(dir, "diffwarden.config.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
