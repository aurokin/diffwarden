import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("does not use disabled reviewer executable config when no default set is configured", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const defaultExecutable = executableFixture("agy");
    writeConfig({
      reviewers: [
        {
          id: "agy-disabled",
          engine: "antigravity",
          enabled: false,
          cliOptions: { executable: executableFixture("agy-disabled") },
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

  it("uses Copilot SDK executable overrides from sdkOptions", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = externalExecutableFixture("copilot-sdk-local");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["copilot-sdk-local"] },
      reviewers: [
        {
          id: "copilot-sdk-local",
          engine: "copilot",
          sdkOptions: { executable },
        },
      ],
    });

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      resolvedExecutable: executable,
      executableSource: "config",
      executableSourceDetail: "reviewer copilot-sdk-local",
    });
  });

  it("does not report repo-local Copilot SDK executable overrides as usable runtimes", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("copilot-sdk-local");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["copilot-sdk-local"] },
      reviewers: [
        {
          id: "copilot-sdk-local",
          engine: "copilot",
          sdkOptions: { executable },
        },
      ],
    });

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: `missing executable: ${executable}`,
      executable,
      executableSource: "config",
      executableSourceDetail: "reviewer copilot-sdk-local",
    });
    expect(row.resolvedExecutable).toBeUndefined();
  });

  it("does not report dot-dot-prefixed repo-local Copilot SDK runtimes as usable", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = path.join(testRoot(), "..copilot-runtime", "copilot");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(executable, 0o755);
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["copilot-sdk-local"] },
      reviewers: [
        {
          id: "copilot-sdk-local",
          engine: "copilot",
          sdkOptions: { executable },
        },
      ],
    });

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: `missing executable: ${executable}`,
      executable,
      executableSource: "config",
      executableSourceDetail: "reviewer copilot-sdk-local",
    });
    expect(row.resolvedExecutable).toBeUndefined();
  });

  it("does not report generic Copilot SDK executable overrides as usable runtimes", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["copilot-sdk-local"] },
      reviewers: [
        {
          id: "copilot-sdk-local",
          engine: "copilot",
          sdkOptions: { executable: process.execPath },
        },
      ],
    });

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: `missing executable: ${process.execPath}`,
      executable: process.execPath,
      executableSource: "config",
      executableSourceDetail: "reviewer copilot-sdk-local",
    });
    expect(row.resolvedExecutable).toBeUndefined();
  });

  it("accepts readable Copilot SDK JavaScript runtime overrides", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = externalReadableJavaScriptFixture("copilot-sdk-runtime.js");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["copilot-sdk-local"] },
      reviewers: [
        {
          id: "copilot-sdk-local",
          engine: "copilot",
          sdkOptions: { executable },
        },
      ],
    });

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      resolvedExecutable: executable,
      executableSource: "config",
      executableSourceDetail: "reviewer copilot-sdk-local",
    });
  });

  it("resolves readable Copilot SDK JavaScript runtime overrides from PATH", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = externalReadableJavaScriptFixture("copilot-sdk-runtime.js");

    const row = await doctorRow("copilot-sdk", {
      PATH: path.dirname(executable),
      DIFFWARDEN_LIVE_COPILOT_SDK_EXECUTABLE: "copilot-sdk-runtime.js",
    });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable: "copilot-sdk-runtime.js",
      resolvedExecutable: executable,
      executableSource: "env",
      executableSourceDetail: "DIFFWARDEN_LIVE_COPILOT_SDK_EXECUTABLE",
    });
  });

  it("matches runtime platform rules when resolving Copilot command shims from PATH", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = externalExecutableFixture("copilot.cmd");
    const env = {
      PATH: path.dirname(executable),
      PATHEXT: ".cmd",
      DIFFWARDEN_LIVE_COPILOT_SDK_EXECUTABLE: "copilot",
    };

    const sdkRow = await doctorRow("copilot-sdk", env, "darwin");
    const nonWindowsCliRow = await doctorRow("copilot-cli", env, "darwin");
    const windowsCliRow = await doctorRow("copilot-cli", env, "win32");

    expect(sdkRow).toMatchObject({
      status: "missing executable: copilot",
      executable: "copilot",
      executableSource: "env",
      executableSourceDetail: "DIFFWARDEN_LIVE_COPILOT_SDK_EXECUTABLE",
    });
    expect(nonWindowsCliRow).toMatchObject({
      status: "missing executable: copilot",
      executable: "copilot",
      executableSource: "adapter-default",
    });
    expect(windowsCliRow).toMatchObject({
      status: `found: ${executable}`,
      executable: "copilot",
      resolvedExecutable: executable,
      executableSource: "adapter-default",
    });
  });

  it("does not require a standalone Copilot executable for SDK default runtime", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: expect.stringContaining("found bundled runtime: "),
      executableSource: "adapter-default",
      executableSourceDetail: "SDK bundled runtime",
      resolvedExecutable: expect.stringContaining(path.join("@github", "copilot", "index.js")),
    });
    expect(row.executable).toBeUndefined();
  });

  it("does not report a repo-local Copilot SDK bundled runtime as usable", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const rows = await collectLiveDoctorRows({
      cwd: testRoot(),
      repoRoot: process.cwd(),
      env: {
        HOME: testRoot(),
        XDG_CONFIG_HOME: path.join(testRoot(), ".config"),
        PATH: "",
      },
    });
    const row = rows.find((candidate) => candidate.id === "copilot-sdk");

    expect(row).toMatchObject({
      status: "missing bundled runtime",
      executableSource: "adapter-default",
      executableSourceDetail: "SDK bundled runtime",
    });
    expect(row?.resolvedExecutable).toBeUndefined();
  });

  it("does not require a standalone Copilot executable for active SDK reviewers without overrides", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["copilot-sdk-default"] },
      reviewers: [
        {
          id: "copilot-sdk-default",
          engine: "copilot",
        },
      ],
    });

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: expect.stringContaining("found bundled runtime: "),
      executableSource: "adapter-default",
      executableSourceDetail: "SDK bundled runtime",
      resolvedExecutable: expect.stringContaining(path.join("@github", "copilot", "index.js")),
    });
    expect(row.executable).toBeUndefined();
  });

  it("reports mixed Copilot SDK bundled and configured runtimes", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = externalExecutableFixture("copilot-sdk-local");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["copilot-sdk-default", "copilot-sdk-local"] },
      reviewers: [
        {
          id: "copilot-sdk-default",
          engine: "copilot",
        },
        {
          id: "copilot-sdk-local",
          engine: "copilot",
          sdkOptions: { executable },
        },
      ],
    });

    const row = await doctorRow("copilot-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: "found multiple active runtimes",
      executableSource: "config",
      executableSourceDetail:
        "multiple active reviewers: copilot-sdk-default (adapter-default: bundled runtime), copilot-sdk-local (config)",
    });
  });

  it("uses Copilot SDK executable env overrides", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = externalExecutableFixture("copilot-sdk-env");

    const row = await doctorRow("copilot-sdk", {
      PATH: "",
      DIFFWARDEN_LIVE_COPILOT_SDK_EXECUTABLE: executable,
    });

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      executableSource: "env",
      executableSourceDetail: "DIFFWARDEN_LIVE_COPILOT_SDK_EXECUTABLE",
    });
  });

  it("uses Droid SDK cliOptions executable as a legacy fallback", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("droid-cli-fallback");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["droid-sdk-local"] },
      reviewers: [
        {
          id: "droid-sdk-local",
          engine: "droid",
          cliOptions: { executable },
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

  it("prefers Droid SDK executable overrides over CLI executable overrides for SDK rows", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const sdkExecutable = executableFixture("droid-sdk-local");
    const cliExecutable = executableFixture("droid-cli-local");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["droid-sdk-local"] },
      reviewers: [
        {
          id: "droid-sdk-local",
          engine: "droid",
          sdkOptions: { executable: sdkExecutable },
          cliOptions: { executable: cliExecutable },
        },
      ],
    });

    const row = await doctorRow("droid-sdk", { PATH: "" });

    expect(row).toMatchObject({
      status: `found: ${sdkExecutable}`,
      executable: sdkExecutable,
      resolvedExecutable: sdkExecutable,
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

  it("warns and falls back when the active reviewer set references a disabled reviewer", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const executable = executableFixture("agy");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["agy-disabled"] },
      reviewers: [
        {
          id: "agy-disabled",
          engine: "antigravity",
          enabled: false,
          cliOptions: { executable: executableFixture("agy-disabled") },
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
      auth: "Reviewer is disabled: agy-disabled in reviewer set: primary",
    });
    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable: "agy",
      resolvedExecutable: executable,
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

  it("discovers parent config from non-git subdirectories", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-"));
    const child = path.join(testRoot(), "nested", "tool");
    mkdirSync(child, { recursive: true });
    const executable = executableFixture("codex-config");
    writeConfig({
      defaultReviewerSet: "primary",
      reviewerSets: { primary: ["codex-config"] },
      reviewers: [
        {
          id: "codex-config",
          engine: "codex",
          transport: "cli",
          cliOptions: { executable },
        },
      ],
    });

    const rows = await collectLiveDoctorRows({
      cwd: child,
      env: {
        HOME: testRoot(),
        XDG_CONFIG_HOME: path.join(testRoot(), ".config"),
        PATH: "",
      },
    });
    const row = rows.find((candidate) => candidate.id === "codex");

    expect(row).toMatchObject({
      status: `found: ${executable}`,
      executable,
      executableSource: "config",
      executableSourceDetail: "reviewer codex-config",
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

async function doctorRow(id: string, env: NodeJS.ProcessEnv, platform?: NodeJS.Platform) {
  const rows = await collectLiveDoctorRows({
    cwd: testRoot(),
    repoRoot: testRoot(),
    env: {
      HOME: testRoot(),
      XDG_CONFIG_HOME: path.join(testRoot(), ".config"),
      ...env,
    },
    ...(platform !== undefined ? { platform } : {}),
  });
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

function externalExecutableFixture(name: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-executable-"));
  const executable = path.join(directory, name);
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(executable, 0o755);
  return executable;
}

function externalReadableJavaScriptFixture(name: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "diffwarden-live-doctor-runtime-"));
  const executable = path.join(directory, name);
  writeFileSync(executable, "export {};\n", "utf8");
  chmodSync(executable, 0o644);
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
