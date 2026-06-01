import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectLiveDoctorRows, formatLiveDoctorRows } from "../scripts/live-doctor.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

describe("live doctor executable provenance", () => {
  it("uses configured CLI executables before adapter defaults", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("agy-local");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["agy-local"] },
      reviewers: [
        {
          id: "agy-local",
          engine: "antigravity",
          cliOptions: { executable },
        },
      ],
    });

    const row = await antigravityRow({
      PATH: "",
    });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      resolvedExecutable: executable,
      executableSource: "config",
      executableSourceDetail: "reviewer agy-local",
    });
  });

  it("keeps explicit live executable env overrides ahead of config", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const configuredExecutable = executableFixture("agy-config");
    const envExecutable = executableFixture("agy-env");
    writeConfig({
      reviewers: [
        {
          id: "agy-config",
          engine: "antigravity",
          cliOptions: { executable: configuredExecutable },
        },
      ],
    });

    const row = await antigravityRow({
      PATH: "",
      DIFFWARDEN_LIVE_ANTIGRAVITY_EXECUTABLE: envExecutable,
    });

    expect(row).toMatchObject({
      status: `found: ${envExecutable}`,
      executable: envExecutable,
      resolvedExecutable: envExecutable,
      executableSource: "env",
      executableSourceDetail: "DIFFWARDEN_LIVE_ANTIGRAVITY_EXECUTABLE",
    });
  });

  it("uses configured Codex app-server executables", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("codex-local");
    writeConfig({
      reviewers: [
        {
          id: "codex-app",
          engine: "codex",
          transport: "app-server",
          cliOptions: { executable },
        },
      ],
    });

    const row = await doctorRow("codex", { PATH: "" });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      resolvedExecutable: executable,
      executableSource: "config",
      executableSourceDetail: "reviewer codex-app",
    });
  });

  it("does not use inactive reviewer executable config when a default set is configured", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const defaultExecutable = executableFixture("agy");
    const inactiveExecutable = executableFixture("agy-inactive");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["agy-default"] },
      reviewers: [
        {
          id: "agy-default",
          engine: "antigravity",
        },
        {
          id: "agy-inactive",
          engine: "antigravity",
          cliOptions: { executable: inactiveExecutable },
        },
      ],
    });

    const row = await antigravityRow({ PATH: testRoot() });

    expect(row).toMatchObject({
      status: `found: ${defaultExecutable}`,
      executable: "agy",
      resolvedExecutable: defaultExecutable,
      executableSource: "adapter-default",
    });
  });

  it("reports defaulted and configured executables from the active reviewer set", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    executableFixture("agy");
    const executable = executableFixture("agy-active");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["agy-default", "agy-active"] },
      reviewers: [
        {
          id: "agy-default",
          engine: "antigravity",
        },
        {
          id: "agy-active",
          engine: "antigravity",
          cliOptions: { executable },
        },
      ],
    });

    const row = await antigravityRow({ PATH: testRoot() });

    expect(row).toMatchObject({
      status: "found multiple active executables",
      executableSource: "config",
      executableSourceDetail:
        "multiple active reviewers: agy-default (adapter-default), agy-active (config)",
    });
  });

  it("reports multiple active configured executables without choosing one arbitrarily", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["agy-a", "agy-b"] },
      reviewers: [
        {
          id: "agy-a",
          engine: "antigravity",
          cliOptions: { executable: executableFixture("agy-a") },
        },
        {
          id: "agy-b",
          engine: "antigravity",
          cliOptions: { executable: executableFixture("agy-b") },
        },
      ],
    });

    const row = await antigravityRow({ PATH: "" });

    expect(row).toMatchObject({
      status: "found multiple active executables",
      executableSource: "config",
      executableSourceDetail: "multiple active reviewers: agy-a (config), agy-b (config)",
    });
  });

  it("keeps built-in reviewers active when reporting configured executables", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    executableFixture("agy");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["antigravity", "agy-active"] },
      reviewers: [
        {
          id: "agy-active",
          engine: "antigravity",
          cliOptions: { executable: executableFixture("agy-active") },
        },
      ],
    });

    const row = await antigravityRow({ PATH: testRoot() });

    expect(row).toMatchObject({
      status: "found multiple active executables",
      executableSource: "config",
      executableSourceDetail:
        "multiple active reviewers: antigravity (adapter-default), agy-active (config)",
    });
  });

  it("uses configured executables from active reviewer-set profile specs", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("agy-profile");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["antigravity:local"] },
      reviewers: [
        {
          id: "agy-profile",
          engine: "antigravity",
          profile: "local",
          cliOptions: { executable },
        },
      ],
    });

    const row = await antigravityRow({ PATH: "" });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      resolvedExecutable: executable,
      executableSource: "config",
      executableSourceDetail: "reviewer agy-profile",
    });
  });

  it("uses Droid SDK executable overrides from sdkOptions", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("droid-sdk-local");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["droid-sdk-local"] },
      reviewers: [
        {
          id: "droid-sdk-local",
          engine: "droid",
          sdkOptions: { executable },
        },
      ],
    });

    const row = await doctorRow("droid-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      resolvedExecutable: executable,
      executableSource: "config",
      executableSourceDetail: "reviewer droid-sdk-local",
    });
  });

  it("keeps Droid SDK and CLI executable config on their own rows", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const sdkExecutable = executableFixture("droid-sdk-local");
    const cliExecutable = executableFixture("droid-cli-local");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["droid-sdk-local", "droid-cli-local"] },
      reviewers: [
        {
          id: "droid-sdk-local",
          engine: "droid",
          sdkOptions: { executable: sdkExecutable },
        },
        {
          id: "droid-cli-local",
          engine: "droid",
          transport: "cli",
          cliOptions: { executable: cliExecutable },
        },
      ],
    });

    const sdkRow = await doctorRow("droid-sdk", { PATH: "" });
    const cliRow = await doctorRow("droid-cli", { PATH: "" });

    expect(sdkRow).toMatchObject({
      status: `found: ${sdkExecutable}`,
      executable: sdkExecutable,
      resolvedExecutable: sdkExecutable,
      executableSource: "config",
      executableSourceDetail: "reviewer droid-sdk-local",
    });
    expect(cliRow).toMatchObject({
      status: `found: ${cliExecutable}`,
      executable: cliExecutable,
      resolvedExecutable: cliExecutable,
      executableSource: "config",
      executableSourceDetail: "reviewer droid-cli-local",
    });
  });

  it("keeps Droid SDK and CLI executable env overrides independent", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const pathExecutable = executableFixture("droid");
    const sdkExecutable = executableFixture("droid-sdk-env");
    const cliExecutable = executableFixture("droid-cli-env");

    const sdkRow = await doctorRow("droid-sdk", {
      PATH: testRoot(),
      DIFFWARDEN_LIVE_DROID_SDK_EXECUTABLE: sdkExecutable,
      DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE: cliExecutable,
    });
    const cliRow = await doctorRow("droid-cli", {
      PATH: testRoot(),
      DIFFWARDEN_LIVE_DROID_SDK_EXECUTABLE: sdkExecutable,
      DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE: cliExecutable,
    });
    const sdkWithoutSpecificOverride = await doctorRow("droid-sdk", {
      PATH: testRoot(),
      DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE: cliExecutable,
    });
    const cliWithoutSpecificOverride = await doctorRow("droid-cli", {
      PATH: testRoot(),
      DIFFWARDEN_LIVE_DROID_SDK_EXECUTABLE: sdkExecutable,
    });

    expect(sdkRow).toMatchObject({
      status: `found: ${sdkExecutable}`,
      executable: sdkExecutable,
      executableSource: "env",
      executableSourceDetail: "DIFFWARDEN_LIVE_DROID_SDK_EXECUTABLE",
    });
    expect(cliRow).toMatchObject({
      status: `found: ${cliExecutable}`,
      executable: cliExecutable,
      executableSource: "env",
      executableSourceDetail: "DIFFWARDEN_LIVE_DROID_CLI_EXECUTABLE",
    });
    expect(sdkWithoutSpecificOverride).toMatchObject({
      status: `found: ${pathExecutable}`,
      executable: "droid",
      resolvedExecutable: pathExecutable,
      executableSource: "adapter-default",
    });
    expect(cliWithoutSpecificOverride).toMatchObject({
      status: `found: ${pathExecutable}`,
      executable: "droid",
      resolvedExecutable: pathExecutable,
      executableSource: "adapter-default",
    });
  });

  it("treats built-in reviewer specs ahead of same-named configured ids", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const defaultExecutable = executableFixture("agy");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["antigravity"] },
      reviewers: [
        {
          id: "antigravity",
          engine: "antigravity",
          cliOptions: { executable: executableFixture("agy-config") },
        },
      ],
    });

    const row = await antigravityRow({ PATH: testRoot() });

    expect(row).toMatchObject({
      status: `found: ${defaultExecutable}`,
      executable: "agy",
      resolvedExecutable: defaultExecutable,
      executableSource: "adapter-default",
    });
  });

  it("warns and falls back when the active reviewer set is invalid", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("agy");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["missing-reviewer"] },
      reviewers: [
        {
          id: "agy-local",
          engine: "antigravity",
          cliOptions: { executable: executableFixture("agy-config") },
        },
      ],
    });

    const rows = await collectLiveDoctorRows({
      cwd: testRoot(),
      repoRoot: testRoot(),
      env: { PATH: testRoot() },
    });
    const configRow = rows.find((candidate) => candidate.id === "config");
    const row = rows.find((candidate) => candidate.id === "antigravity");

    expect(configRow).toMatchObject({
      kind: "config",
      status: "ignored invalid config",
      auth: "Unknown configured reviewer: missing-reviewer",
    });
    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable: "agy",
      resolvedExecutable: executable,
      executableSource: "adapter-default",
    });
  });

  it("warns and falls back when active reviewer-set specs are malformed", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("codex");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["codex:bad:spec"] },
      reviewers: [
        {
          id: "codex:bad:spec",
          engine: "codex",
          transport: "cli",
          cliOptions: { executable: executableFixture("codex-config") },
        },
      ],
    });

    const rows = await collectLiveDoctorRows({
      cwd: testRoot(),
      repoRoot: testRoot(),
      env: { PATH: testRoot() },
    });
    const configRow = rows.find((candidate) => candidate.id === "config");
    const row = rows.find((candidate) => candidate.id === "codex");

    expect(configRow).toMatchObject({
      kind: "config",
      status: "ignored invalid config",
      auth: "Invalid reviewer spec: codex:bad:spec",
    });
    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable: "codex",
      resolvedExecutable: executable,
      executableSource: "adapter-default",
    });
  });

  it("warns and falls back when active reviewer-set profile specs are invalid", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("codex");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["codex:bad/profile"] },
      reviewers: [
        {
          id: "codex-config",
          engine: "codex",
          transport: "cli",
          profile: "bad/profile",
          cliOptions: { executable: executableFixture("codex-config") },
        },
      ],
    });

    const rows = await collectLiveDoctorRows({
      cwd: testRoot(),
      repoRoot: testRoot(),
      env: { PATH: testRoot() },
    });
    const configRow = rows.find((candidate) => candidate.id === "config");
    const row = rows.find((candidate) => candidate.id === "codex");

    expect(configRow).toMatchObject({
      kind: "config",
      status: "ignored invalid config",
      auth: "Invalid reviewer profile in spec: codex:bad/profile",
    });
    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable: "codex",
      resolvedExecutable: executable,
      executableSource: "adapter-default",
    });
  });

  it("warns and falls back when the active reviewer set is empty", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("agy");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: [] },
      reviewers: [
        {
          id: "agy-local",
          engine: "antigravity",
          cliOptions: { executable: executableFixture("agy-config") },
        },
      ],
    });

    const rows = await collectLiveDoctorRows({
      cwd: testRoot(),
      repoRoot: testRoot(),
      env: { PATH: testRoot() },
    });
    const configRow = rows.find((candidate) => candidate.id === "config");
    const row = rows.find((candidate) => candidate.id === "antigravity");

    expect(configRow).toMatchObject({
      kind: "config",
      status: "ignored invalid config",
      auth: "Reviewer set is empty: primary",
    });
    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable: "agy",
      resolvedExecutable: executable,
      executableSource: "adapter-default",
    });
  });

  it("reports executable availability even when config is invalid", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("agy");
    writeFileSync(path.join(testRoot(), "diffwarden.config.json"), "{", "utf8");

    const rows = await collectLiveDoctorRows({
      cwd: testRoot(),
      repoRoot: testRoot(),
      env: { PATH: testRoot() },
    });
    const configRow = rows.find((candidate) => candidate.id === "config");
    const row = rows.find((candidate) => candidate.id === "antigravity");

    expect(configRow).toMatchObject({
      kind: "config",
      status: "ignored invalid config",
    });
    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable: "agy",
      resolvedExecutable: executable,
      executableSource: "adapter-default",
    });
  });

  it("formats executable source labels in doctor output", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("agy-local");
    writeConfig({
      reviewers: [
        {
          id: "agy-local",
          engine: "antigravity",
          cliOptions: { executable },
        },
      ],
    });

    const row = await antigravityRow({ PATH: "" });

    expect(formatLiveDoctorRows([row])).toContain("source=config reviewer agy-local");
  });

  it("derives SDK auth labels from the supplied environment", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    executableFixture("droid");

    const missing = await doctorRow("droid-sdk", { PATH: testRoot() });
    const present = await doctorRow("droid-sdk", {
      PATH: testRoot(),
      FACTORY_API_KEY: "test-key",
    });

    expect(missing.auth).toBe("API key absent; Droid local auth may work");
    expect(present.auth).toBe("FACTORY_API_KEY present");
  });
});

async function antigravityRow(env: NodeJS.ProcessEnv) {
  return await doctorRow("antigravity", env);
}

async function doctorRow(id: string, env: NodeJS.ProcessEnv) {
  const rows = await collectLiveDoctorRows({ cwd: testRoot(), repoRoot: testRoot(), env });
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`missing ${id} doctor row`);
  }
  return row;
}

function executableFixture(name: string): string {
  const executable = path.join(testRoot(), name);
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(executable, 0o755);
  return executable;
}

function writeConfig(config: unknown): void {
  writeFileSync(path.join(testRoot(), "diffwarden.config.json"), JSON.stringify(config), "utf8");
}

function testRoot(): string {
  if (root === undefined) {
    throw new Error("missing test root");
  }
  return root;
}
