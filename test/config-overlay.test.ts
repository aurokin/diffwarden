import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addReviewerToSetInUserConfig,
  addReviewerToUserConfig,
  addReviewersToLocalConfig,
  editReviewerInLocalConfig,
  editReviewerInUserConfig,
  loadDiffwardenConfig,
  loadLayeredUserConfigView,
  mergeConfigOverlay,
  removeReviewerFromLocalConfig,
  removeReviewerFromUserConfig,
  replaceReviewerLocalOverride,
  validateConfigLayers,
} from "../src/core/config.js";

let root: string | undefined;

afterEach(() => {
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

function setup(base?: object, local?: object): { xdg: string; configDir: string } {
  root = mkdtempSync(path.join(tmpdir(), "diffwarden-overlay-"));
  const xdg = path.join(root, "xdg");
  const configDir = path.join(xdg, "diffwarden");
  mkdirSync(configDir, { recursive: true });
  if (base !== undefined) {
    writeFileSync(
      path.join(configDir, "diffwarden.config.json"),
      `${JSON.stringify(base, null, 2)}\n`,
    );
  }
  if (local !== undefined) {
    writeFileSync(
      path.join(configDir, "diffwarden.config.local.json"),
      `${JSON.stringify(local, null, 2)}\n`,
    );
  }
  return { xdg, configDir };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const baseConfig = {
  defaultReviewerSet: "1",
  reviewerSets: { "1": ["pi-default", "codex"] },
  reviewers: [
    { id: "pi-default", engine: "pi" },
    { id: "codex", engine: "codex", transport: "cli", sdkOptions: { keep: "me" } },
  ],
  readonly: true,
  timeoutSeconds: 60,
};

describe("mergeConfigOverlay", () => {
  it("overrides scalars, deep-merges nested objects, and replaces arrays wholesale", () => {
    const { merged, provenance } = mergeConfigOverlay(
      {
        timeoutSeconds: 60,
        reporting: { enabled: true, dir: "/base", mode: "full" },
        reviewerSets: { "1": ["a", "b"], "2": ["c"] },
      },
      {
        timeoutSeconds: 30,
        reporting: { dir: "/local" },
        reviewerSets: { "1": ["a"] },
      },
    );

    expect(merged.timeoutSeconds).toBe(30);
    expect(merged.reporting).toEqual({ enabled: true, dir: "/local", mode: "full" });
    // Per-set-name deep merge of the map; each member array replaces wholesale.
    expect(merged.reviewerSets).toEqual({ "1": ["a"], "2": ["c"] });
    expect(provenance.topLevelOverrides.sort()).toEqual([
      "reporting",
      "reviewerSets",
      "timeoutSeconds",
    ]);
  });

  it("merges reviewers by id: field overlay preserves untouched keys, new ids append in order", () => {
    const { merged, provenance } = mergeConfigOverlay(
      { reviewers: [{ id: "codex", engine: "codex", sdkOptions: { keep: "me" } }] },
      {
        reviewers: [
          { id: "droid", engine: "droid", transport: "cli" },
          { id: "codex", enabled: false, sdkOptions: { machineId: "host-1" } },
        ],
      },
    );

    const reviewers = merged.reviewers as Record<string, unknown>[];
    expect(reviewers.map((reviewer) => reviewer.id)).toEqual(["codex", "droid"]);
    // Entry deep-merge: local machineId lands without wiping base sdkOptions keys.
    expect(reviewers[0]).toMatchObject({
      id: "codex",
      engine: "codex",
      enabled: false,
      sdkOptions: { keep: "me", machineId: "host-1" },
    });
    expect(provenance.reviewerOverrides.codex?.sort()).toEqual(["enabled", "sdkOptions"]);
    expect(provenance.appendedReviewerIds).toEqual(["droid"]);
  });

  it("treats null as a value, not a deletion marker", () => {
    const { merged } = mergeConfigOverlay({ timeoutSeconds: 60 }, { timeoutSeconds: null });
    expect(merged.timeoutSeconds).toBeNull();
  });

  it("merges prototype-hostile keys as data without polluting", () => {
    const base = JSON.parse('{"reviewerSets": {"__proto__": ["a"], "safe": ["b"]}}') as Record<
      string,
      unknown
    >;
    const local = JSON.parse('{"reviewerSets": {"__proto__": ["c"]}}') as Record<string, unknown>;

    const { merged } = mergeConfigOverlay(base, local);

    const sets = merged.reviewerSets as Record<string, unknown>;
    expect(Object.keys(sets).sort()).toEqual(["__proto__", "safe"]);
    expect(sets.__proto__).toEqual(["c"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBeNull();
  });

  it("returns a deep-equal copy with empty provenance when the local overlay is empty", () => {
    const { merged, provenance } = mergeConfigOverlay(
      baseConfig as unknown as Record<string, unknown>,
      {},
    );
    expect(JSON.parse(JSON.stringify(merged))).toEqual(baseConfig);
    expect(provenance.topLevelOverrides).toEqual([]);
    expect(provenance.reviewerOverrides).toEqual({});
    expect(provenance.appendedReviewerIds).toEqual([]);
  });
});

describe("loadDiffwardenConfig with a local overlay", () => {
  it("is byte-identical to today when no local file exists (no overlay field)", async () => {
    const { xdg, configDir } = setup(baseConfig);
    const loaded = await loadDiffwardenConfig({
      cwd: root as string,
      repoRoot: root as string,
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(loaded?.path).toBe(path.join(configDir, "diffwarden.config.json"));
    expect(loaded?.sha256).toBe(
      sha256(readFileSync(path.join(configDir, "diffwarden.config.json"), "utf8")),
    );
    expect(loaded?.overlay).toBeUndefined();
  });

  it("merges the overlay over the user config and reports provenance", async () => {
    const { xdg, configDir } = setup(baseConfig, {
      timeoutSeconds: 30,
      reviewers: [
        { id: "codex", enabled: false, sdkOptions: { machineId: "host-1" } },
        { id: "droid", engine: "droid", transport: "cli" },
      ],
    });

    const loaded = await loadDiffwardenConfig({
      cwd: root as string,
      repoRoot: root as string,
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(loaded?.config.timeoutSeconds).toBe(30);
    const codex = loaded?.config.reviewers?.find((reviewer) => reviewer.id === "codex");
    expect(codex).toMatchObject({
      enabled: false,
      sdkOptions: { keep: "me", machineId: "host-1" },
    });
    expect(loaded?.config.reviewers?.map((reviewer) => reviewer.id)).toEqual([
      "pi-default",
      "codex",
      "droid",
    ]);
    expect(loaded?.overlay).toMatchObject({
      path: path.join(configDir, "diffwarden.config.local.json"),
      topLevelOverrides: ["timeoutSeconds"],
      appendedReviewerIds: ["droid"],
    });
    expect(loaded?.overlay?.reviewerOverrides.codex?.sort()).toEqual(["enabled", "sdkOptions"]);
    // Top-level identity still means the BASE file's bytes.
    expect(loaded?.sha256).toBe(
      sha256(readFileSync(path.join(configDir, "diffwarden.config.json"), "utf8")),
    );
  });

  it("ignores the overlay when only the local file exists (an overlay only overlays)", async () => {
    const { xdg } = setup(undefined, { reviewers: [{ id: "codex", enabled: false }] });

    const loaded = await loadDiffwardenConfig({
      cwd: root as string,
      repoRoot: root as string,
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(loaded).toBeUndefined();
  });

  it("ignores the overlay when a project config is selected", async () => {
    const { xdg } = setup(baseConfig, { timeoutSeconds: 30 });
    writeFileSync(
      path.join(root as string, "diffwarden.config.json"),
      `${JSON.stringify({ reviewers: [{ id: "p", engine: "pi" }] }, null, 2)}\n`,
    );

    const loaded = await loadDiffwardenConfig({
      cwd: root as string,
      repoRoot: root as string,
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(loaded?.path).toBe(path.join(root as string, "diffwarden.config.json"));
    expect(loaded?.overlay).toBeUndefined();
    expect(loaded?.config.timeoutSeconds).toBeUndefined();
  });

  it("rejects invalid JSON in the local overlay naming the local path", async () => {
    const { xdg, configDir } = setup(baseConfig);
    writeFileSync(path.join(configDir, "diffwarden.config.local.json"), "{nope");

    await expect(
      loadDiffwardenConfig({
        cwd: root as string,
        repoRoot: root as string,
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/diffwarden\.config\.local\.json/);
  });

  it("rejects a partial local append (no base counterpart) with a targeted message", async () => {
    const { xdg } = setup(baseConfig, { reviewers: [{ id: "ghost", enabled: false }] });

    await expect(
      loadDiffwardenConfig({
        cwd: root as string,
        repoRoot: root as string,
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/local overlay reviewer "ghost" has no base entry to overlay/);
  });

  it("rejects duplicate reviewer ids within the local overlay naming the local path", async () => {
    const { xdg } = setup(baseConfig, {
      reviewers: [
        { id: "codex", enabled: false },
        { id: "codex", enabled: true },
      ],
    });

    await expect(
      loadDiffwardenConfig({
        cwd: root as string,
        repoRoot: root as string,
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/duplicate reviewer id "codex"/);
  });

  it("runs cross-entry invariants on the merged result (local append cannot collide profiles)", async () => {
    const { xdg } = setup(
      {
        reviewers: [{ id: "pi-a", engine: "pi", profile: "openrouter" }],
      },
      {
        reviewers: [{ id: "pi-b", engine: "pi", profile: "openrouter" }],
      },
    );

    await expect(
      loadDiffwardenConfig({
        cwd: root as string,
        repoRoot: root as string,
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/Invalid merged config .*Duplicate reviewer profile/s);
  });
});

describe("local overlay write path", () => {
  it("errors on local writes when no base config exists (an overlay only overlays)", async () => {
    const { xdg } = setup();

    await expect(
      addReviewersToLocalConfig({
        entries: [{ id: "codex", engine: "codex", transport: "cli" }],
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/only overlays a base config/);
  });

  it("adds reviewers to the overlay, creating the file on demand", async () => {
    const { xdg, configDir } = setup(baseConfig);

    const result = await addReviewersToLocalConfig({
      entries: [{ id: "droid", engine: "droid", transport: "cli" }],
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(result.path).toBe(path.join(configDir, "diffwarden.config.local.json"));
    expect(result.created).toBe(true);
    expect(result.actions).toEqual(["added"]);
    const written = JSON.parse(readFileSync(result.path, "utf8")) as Record<string, unknown>;
    expect(written.reviewers).toEqual([{ id: "droid", engine: "droid", transport: "cli" }]);
  });

  it("reports created: false when the overlay file already exists, even empty", async () => {
    const { xdg } = setup(baseConfig, {});

    const result = await addReviewersToLocalConfig({
      entries: [{ id: "droid", engine: "droid", transport: "cli" }],
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(result.created).toBe(false);
    expect(result.actions).toEqual(["added"]);
  });

  it("edit --local writes a minimal partial entry and explicit enabled: true beats base disabled", async () => {
    const { xdg, configDir } = setup({
      ...baseConfig,
      reviewers: [
        { id: "pi-default", engine: "pi" },
        { id: "codex", engine: "codex", transport: "cli", enabled: false },
      ],
    });
    const env = { XDG_CONFIG_HOME: xdg };

    const result = await editReviewerInLocalConfig({ id: "codex", patch: { enabled: true }, env });

    const written = JSON.parse(
      readFileSync(path.join(configDir, "diffwarden.config.local.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written.reviewers).toEqual([{ id: "codex", enabled: true }]);
    expect(result.reviewer).toEqual({ id: "codex", enabled: true });

    const loaded = await loadDiffwardenConfig({
      cwd: root as string,
      repoRoot: root as string,
      env,
    });
    const codex = loaded?.config.reviewers?.find((reviewer) => reviewer.id === "codex");
    expect(codex?.enabled).toBe(true);
  });

  it("edit --local rejects an id missing from both layers", async () => {
    const { xdg } = setup(baseConfig);

    await expect(
      editReviewerInLocalConfig({
        id: "ghost",
        patch: { enabled: false },
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/No reviewer with id "ghost"/);
  });

  it("edit --local validates model overrides against the composite entry before writing", async () => {
    const { xdg } = setup(baseConfig);

    // droid via CLI transport does not support per-run model overrides.
    await addReviewersToLocalConfig({
      entries: [{ id: "droid", engine: "droid", transport: "cli" }],
      env: { XDG_CONFIG_HOME: xdg },
    });
    await expect(
      editReviewerInLocalConfig({
        id: "droid",
        patch: { effort: "bogus" as never },
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow();
  });

  it("replaceReviewerLocalOverride replaces managed fields, preserves unmanaged keys, drops bare entries", async () => {
    const { xdg, configDir } = setup(baseConfig, {
      reviewers: [{ id: "codex", model: "o3", sdkOptions: { machineId: "host-1" } }],
    });
    const env = { XDG_CONFIG_HOME: xdg };
    const localPath = path.join(configDir, "diffwarden.config.local.json");

    // Replace overrides: model cleared, enabled: false set; machineId must survive.
    await replaceReviewerLocalOverride({ id: "codex", patch: { enabled: false }, env });
    let written = JSON.parse(readFileSync(localPath, "utf8")) as Record<string, unknown>;
    expect(written.reviewers).toEqual([
      { id: "codex", sdkOptions: { machineId: "host-1" }, enabled: false },
    ]);

    // Clearing every override with no unmanaged keys left drops the entry entirely.
    await replaceReviewerLocalOverride({ id: "pi-default", patch: {}, env });
    written = JSON.parse(readFileSync(localPath, "utf8")) as Record<string, unknown>;
    expect((written.reviewers as unknown[]).length).toBe(1);
  });

  it("remove --local deletes only the overlay entry and reports effective sets referencing an appended id", async () => {
    const { xdg, configDir } = setup(
      {
        ...baseConfig,
        reviewerSets: { "1": ["pi-default", "codex"], night: ["droid"] },
      },
      {
        reviewers: [
          { id: "codex", enabled: false },
          { id: "droid", engine: "droid", transport: "cli" },
        ],
        // Overlay-owned set also referencing the appended id — must be reported too, and a local
        // replacement of a base set name must be evaluated as the EFFECTIVE membership.
        reviewerSets: { hostonly: ["droid"], night: ["pi-default"] },
      },
    );
    const env = { XDG_CONFIG_HOME: xdg };

    const appended = await removeReviewerFromLocalConfig({ id: "droid", env });
    // base "night" is replaced by the local "night" (no droid); local "hostonly" references it.
    expect(appended.setsReferencing).toEqual(["hostonly"]);

    const overridden = await removeReviewerFromLocalConfig({ id: "codex", env });
    expect(overridden.setsReferencing).toEqual([]);

    const written = JSON.parse(
      readFileSync(path.join(configDir, "diffwarden.config.local.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written.reviewers).toEqual([]);
    // The base file is untouched.
    const base = JSON.parse(
      readFileSync(path.join(configDir, "diffwarden.config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect((base.reviewers as unknown[]).length).toBe(2);
  });

  it("remove --local guards the effective default set like the base path (refuses without force)", async () => {
    const { xdg } = setup(baseConfig, {
      reviewers: [{ id: "droid", engine: "droid", transport: "cli" }],
      // Local replacement of the DEFAULT set makes the appended id its effective member.
      reviewerSets: { "1": ["droid"] },
    });
    const env = { XDG_CONFIG_HOME: xdg };

    await expect(removeReviewerFromLocalConfig({ id: "droid", env })).rejects.toThrow(
      /default reviewer set "1".*--force/s,
    );

    const forced = await removeReviewerFromLocalConfig({ id: "droid", force: true, env });
    expect(forced.setsReferencing).toEqual(["1"]);
  });

  it("remove --local errors when the overlay has no entry for the id", async () => {
    const { xdg } = setup(baseConfig, { reviewers: [] });

    await expect(
      removeReviewerFromLocalConfig({ id: "codex", env: { XDG_CONFIG_HOME: xdg } }),
    ).rejects.toThrow(/No local overlay entry for reviewer "codex"/);
  });
});

describe("base writes under an overlay", () => {
  it("refuses a base write whose merged result would be invalid, naming both files", async () => {
    const { xdg } = setup(baseConfig, {
      reviewers: [{ id: "codex", transport: "sdk" }],
    });

    // codex does not support the sdk transport; the local override only becomes invalid when the
    // base entry exists — and editing the base entry re-validates the merged pair.
    await expect(
      editReviewerInUserConfig({
        id: "codex",
        patch: { model: "o3" },
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/would be invalid once merged with the local overlay/);
  });

  it("default remove auto-prunes the overlay entry and validates against the pruned overlay", async () => {
    const { xdg, configDir } = setup(
      {
        defaultReviewerSet: "1",
        reviewerSets: { "1": ["pi-default", "codex"] },
        reviewers: [
          { id: "pi-default", engine: "pi" },
          { id: "codex", engine: "codex", transport: "cli" },
        ],
      },
      {
        reviewers: [{ id: "codex", enabled: false }],
        reviewerSets: { night: ["codex"] },
      },
    );

    const result = await removeReviewerFromUserConfig({
      id: "codex",
      env: { XDG_CONFIG_HOME: xdg },
    });

    expect(result.local).toMatchObject({ pruned: true, localSetsReferencing: ["night"] });
    const local = JSON.parse(
      readFileSync(path.join(configDir, "diffwarden.config.local.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(local.reviewers).toEqual([]);
    // Load works afterwards — no orphan overlay entry.
    const loaded = await loadDiffwardenConfig({
      cwd: root as string,
      repoRoot: root as string,
      env: { XDG_CONFIG_HOME: xdg },
    });
    expect(loaded?.config.reviewers?.map((reviewer) => reviewer.id)).toEqual(["pi-default"]);
  });

  it("base remove of a local-only id points at remove --local", async () => {
    const { xdg } = setup(baseConfig, {
      reviewers: [{ id: "droid", engine: "droid", transport: "cli" }],
    });

    await expect(
      removeReviewerFromUserConfig({ id: "droid", env: { XDG_CONFIG_HOME: xdg } }),
    ).rejects.toThrow(/remove droid --local/);
  });

  it("set membership rejects local-only reviewer ids (base sets are synced)", async () => {
    const { xdg } = setup(baseConfig, {
      reviewers: [{ id: "droid", engine: "droid", transport: "cli" }],
    });

    // A base set referencing a host-local id would sync broken to every other host.
    await expect(
      addReviewerToSetInUserConfig({
        setName: "night",
        reviewerId: "droid",
        env: { XDG_CONFIG_HOME: xdg },
      }),
    ).rejects.toThrow(/exists only in the local overlay/);

    // Base reviewers are still fine, overridden or not.
    const overridden = await addReviewerToSetInUserConfig({
      setName: "night",
      reviewerId: "codex",
      env: { XDG_CONFIG_HOME: xdg },
    });
    expect(overridden.members).toEqual(["codex"]);
  });

  it("preserves a symlinked base config when writing through it", async () => {
    const { xdg, configDir } = setup();
    // The dotfiles layout: the real file lives in the dotfiles repo; the config path is a symlink.
    const dotfiles = path.join(root as string, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const realConfig = path.join(dotfiles, "diffwarden.config.json");
    writeFileSync(realConfig, `${JSON.stringify(baseConfig, null, 2)}\n`);
    const linkPath = path.join(configDir, "diffwarden.config.json");
    symlinkSync(realConfig, linkPath);

    await addReviewerToUserConfig({
      entry: { id: "droid", engine: "droid", transport: "cli" },
      env: { XDG_CONFIG_HOME: xdg },
    });

    // The symlink must survive and the dotfiles-side file must carry the change.
    const { lstatSync } = await import("node:fs");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const written = JSON.parse(readFileSync(realConfig, "utf8")) as Record<string, unknown>;
    expect((written.reviewers as Record<string, unknown>[]).map((reviewer) => reviewer.id)).toEqual(
      ["pi-default", "codex", "droid"],
    );
  });

  it("preserves a DANGLING base-config symlink by creating its target (link installed before dotfiles)", async () => {
    const { xdg, configDir } = setup();
    // The symlink landed first; its dotfiles target does not exist yet.
    const dotfiles = path.join(root as string, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const realConfig = path.join(dotfiles, "diffwarden.config.json");
    const linkPath = path.join(configDir, "diffwarden.config.json");
    symlinkSync(realConfig, linkPath);

    const { initDiffwardenConfig } = await import("../src/core/config.js");
    await initDiffwardenConfig({ env: { XDG_CONFIG_HOME: xdg } });

    // The link must survive with the starter config created at its target, not be replaced by a
    // regular file that orphans the host from its synced source.
    const { lstatSync } = await import("node:fs");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const written = JSON.parse(readFileSync(realConfig, "utf8")) as Record<string, unknown>;
    expect(written.reviewers).toBeDefined();
  });

  it("creates the dangling link's target directory instead of failing ENOENT", async () => {
    const { xdg, configDir } = setup();
    // The link points into a dotfiles directory that has not been created yet.
    const realConfig = path.join(root as string, "dotfiles", "nested", "diffwarden.config.json");
    const linkPath = path.join(configDir, "diffwarden.config.json");
    symlinkSync(realConfig, linkPath);

    const { initDiffwardenConfig } = await import("../src/core/config.js");
    await initDiffwardenConfig({ env: { XDG_CONFIG_HOME: xdg } });

    const { lstatSync } = await import("node:fs");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(realConfig, "utf8"))).toBeDefined();
  });

  it("fails on a symlink cycle instead of renaming over an unresolved link", async () => {
    const { xdg, configDir } = setup();
    const linkPath = path.join(configDir, "diffwarden.config.json");
    const otherPath = path.join(configDir, "cycle.json");
    symlinkSync(otherPath, linkPath);
    symlinkSync(linkPath, otherPath);

    const { initDiffwardenConfig } = await import("../src/core/config.js");
    await expect(initDiffwardenConfig({ env: { XDG_CONFIG_HOME: xdg } })).rejects.toThrow(
      /Too many levels of symbolic links/,
    );
    const { lstatSync } = await import("node:fs");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });
});

describe("init under a pre-existing overlay", () => {
  it("init succeeds but the merged pair with an orphan overlay fails to load (doctor's case)", async () => {
    // Fresh-host bootstrap gone wrong: the overlay landed first with a partial override for an id
    // the starter base does not define. initDiffwardenConfig itself must still succeed (the CLI
    // layer warns); the next load fails loudly with the targeted orphan message.
    const { xdg } = setup(undefined, { reviewers: [{ id: "codex", enabled: false }] });
    const env = { XDG_CONFIG_HOME: xdg };

    const { initDiffwardenConfig } = await import("../src/core/config.js");
    await expect(initDiffwardenConfig({ env })).resolves.toBeDefined();
    await expect(
      loadDiffwardenConfig({ cwd: root as string, repoRoot: root as string, env }),
    ).rejects.toThrow(/local overlay reviewer "codex" has no base entry to overlay/);
  });
});

describe("validateConfigLayers", () => {
  const base = JSON.stringify(baseConfig);

  it("rejects everything the loader would, including overlay-shape problems the merged schema misses", () => {
    // Duplicate overlay ids fold into ONE schema-valid merged entry, so only the shape check sees them.
    const dupes = JSON.stringify({
      reviewers: [
        { id: "pi-default", enabled: false },
        { id: "pi-default", enabled: true },
      ],
    });
    expect(() => validateConfigLayers(base, dupes, "/base", "/local")).toThrow(
      /duplicate reviewer id "pi-default"/,
    );
    expect(() =>
      validateConfigLayers(base, JSON.stringify({ reviewers: {} }), "/base", "/local"),
    ).toThrow(/"reviewers" must be an array/);
    expect(() => validateConfigLayers(base, "{not json", "/base", "/local")).toThrow(
      /Invalid JSON/,
    );
    expect(() =>
      validateConfigLayers(
        base,
        JSON.stringify({ reviewers: [{ id: "ghost", enabled: false }] }),
        "/base",
        "/local",
      ),
    ).toThrow(/no base entry to overlay/);
  });

  it("accepts a clean pair and returns the merged config with provenance", () => {
    const { config, provenance } = validateConfigLayers(
      base,
      JSON.stringify({ reviewers: [{ id: "pi-default", enabled: false }] }),
      "/base",
      "/local",
    );
    expect(config.reviewers?.find((entry) => entry.id === "pi-default")?.enabled).toBe(false);
    expect(provenance.reviewerOverrides["pi-default"]).toEqual(["enabled"]);
  });
});

describe("loadLayeredUserConfigView", () => {
  it("returns merged and base views with override provenance", async () => {
    const { xdg, configDir } = setup(baseConfig, {
      reviewers: [
        { id: "codex", enabled: false },
        { id: "droid", engine: "droid", transport: "cli" },
      ],
    });

    const view = await loadLayeredUserConfigView({ env: { XDG_CONFIG_HOME: xdg } });

    expect(view.basePath).toBe(path.join(configDir, "diffwarden.config.json"));
    expect(view.localPath).toBe(path.join(configDir, "diffwarden.config.local.json"));
    expect(view.localSha256).toBeDefined();
    expect(view.entries.map((entry) => entry.id)).toEqual(["pi-default", "codex", "droid"]);
    expect(view.baseEntries.map((entry) => entry.id)).toEqual(["pi-default", "codex"]);
    expect(view.entries.find((entry) => entry.id === "codex")?.enabled).toBe(false);
    expect(view.reviewerOverrides.codex).toEqual(["enabled"]);
    expect(view.appendedReviewerIds).toEqual(["droid"]);
  });

  it("degrades to base-only when no overlay exists", async () => {
    const { xdg } = setup(baseConfig);

    const view = await loadLayeredUserConfigView({ env: { XDG_CONFIG_HOME: xdg } });

    expect(view.localSha256).toBeUndefined();
    expect(view.entries).toEqual(view.baseEntries);
    expect(view.appendedReviewerIds).toEqual([]);
  });
});
