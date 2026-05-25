import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(projectRoot, readPackageBinPath());

let tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("diffwarden CLI e2e", () => {
  it("reports the package version", async () => {
    const result = await runDiffwarden(process.cwd(), ["--version"]);
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));

    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr).toBe("");
  });

  it("reviews uncommitted changes with the fake reviewer in Markdown", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(path.join(repo, "new.txt"), "new\n");

    const result = await runDiffwarden(repo, [
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
    ]);

    expect(result.stdout).toContain("# Code Review");
    expect(result.stdout).toContain("Engine: fake");
    expect(result.stdout).toContain("Target: uncommitted");
    expect(result.stdout).toContain("Fake reviewer inspected 2 changed file(s).");
    expect(result.stderr).toBe("");
  });

  it("reviews base branch changes with the fake reviewer in JSON", async () => {
    const repo = createRepo();
    git(repo, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(path.join(repo, "tracked.txt"), "feature\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "feature"]);

    const result = await runDiffwarden(repo, [
      "--target",
      "base:main",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--format",
      "json",
    ]);
    const artifact = JSON.parse(result.stdout);

    expect(artifact.engine).toBe("fake");
    expect(artifact.target.kind).toBe("base");
    expect(artifact.target.base_ref).toBe("main");
    expect(artifact.target.changed_files).toEqual(["tracked.txt"]);
    expect(artifact.result.overall_correctness).toBe("patch is correct");
  });

  it("reviews a single commit with the fake reviewer in JSON", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "commit change\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "change"]);
    const commitSha = git(repo, ["rev-parse", "HEAD"]);

    const result = await runDiffwarden(repo, [
      "--target",
      `commit:${commitSha}`,
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--format",
      "json",
    ]);
    const artifact = JSON.parse(result.stdout);

    expect(artifact.target.kind).toBe("commit");
    expect(artifact.target.commit_sha).toBe(commitSha);
    expect(artifact.target.changed_files).toEqual(["tracked.txt"]);
  });

  it("reviews custom instructions with the fake reviewer in JSON", async () => {
    const repo = createRepo();

    const result = await runDiffwarden(repo, [
      "--target",
      "custom:Review auth paths",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--format",
      "json",
    ]);
    const artifact = JSON.parse(result.stdout);

    expect(artifact.target.kind).toBe("custom");
    expect(artifact.target.instructions).toBe("Review auth paths");
    expect(artifact.target.changed_files).toEqual([]);
    expect(artifact.validation.valid_locations).toBe(true);
    expect(artifact.validation.findings_overlap_diff).toBe(true);
  });

  it("accepts fail-on-findings when no matching findings are reported", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--fail-on-findings",
      "P2",
    ]);

    expect(result.stdout).toContain("# Code Review");
    expect(result.stderr).toBe("");
  });

  it("exits 1 after writing output when findings meet the fail-on-findings threshold", async () => {
    const repo = createRepo();
    const outputPath = path.join(repo, "review.json");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    try {
      await runDiffwarden(
        repo,
        [
          "--target",
          "uncommitted",
          "--reviewer",
          "fake",
          "--cwd",
          repo,
          "--format",
          "json",
          "--out",
          outputPath,
          "--fail-on-findings",
          "P2",
        ],
        {
          DIFFWARDEN_FAKE_FINDING_PATH: path.join(repo, "tracked.txt"),
        },
      );
      throw new Error("Expected diffwarden to exit 1");
    } catch (error) {
      expect(error).toMatchObject({
        code: 1,
        stderr: "",
      });
      if (!isExecError(error)) {
        throw error;
      }

      const stdoutArtifact = JSON.parse(error.stdout);
      const outArtifact = JSON.parse(readFileSync(outputPath, "utf8"));
      expect(stdoutArtifact.result.findings[0]).toMatchObject({
        title: "[P2] Fake finding",
        priority: 2,
      });
      expect(outArtifact.result.findings[0]).toMatchObject({
        title: "[P2] Fake finding",
        priority: 2,
      });
      expect(existsSync(outputPath)).toBe(true);
    }
  });

  it("streams NDJSON events to stdout ending with the final result", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--format",
      "ndjson",
    ]);

    const events = parseNdjson(result.stdout);
    expect(events[0]?.type).toBe("run_started");
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("final_result");
    expect((terminal as { schema_version?: number }).schema_version).toBe(2);
    const artifact = (terminal as { artifact?: { engine?: string } }).artifact;
    expect(artifact?.engine).toBe("fake");
    // No second terminal frame, and progress stays off stdout/stderr in NDJSON mode.
    expect(
      events.filter((event) => event.type === "final_result" || event.type === "error"),
    ).toHaveLength(1);
    expect(result.stderr).toBe("");
  });

  it("still honors --fail-on-findings and --out in NDJSON mode", async () => {
    const repo = createRepo();
    const outputPath = path.join(repo, "review.json");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    try {
      await runDiffwarden(
        repo,
        [
          "--target",
          "uncommitted",
          "--reviewer",
          "fake",
          "--cwd",
          repo,
          "--format",
          "ndjson",
          "--out",
          outputPath,
          "--fail-on-findings",
          "P2",
        ],
        {
          DIFFWARDEN_FAKE_FINDING_PATH: path.join(repo, "tracked.txt"),
        },
      );
      throw new Error("Expected diffwarden to exit 1");
    } catch (error) {
      if (!isExecError(error)) {
        throw error;
      }
      expect(error.code).toBe(1);
      expect(error.stderr).toBe("");
      const events = parseNdjson(error.stdout);
      expect(events.at(-1)?.type).toBe("final_result");
      const outArtifact = JSON.parse(readFileSync(outputPath, "utf8"));
      expect(outArtifact.result.findings[0]).toMatchObject({
        title: "[P2] Fake finding",
        priority: 2,
      });
    }
  });

  it("rejects --format ndjson combined with --verbose", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    await expect(
      runDiffwarden(repo, [
        "--target",
        "uncommitted",
        "--reviewer",
        "fake",
        "--cwd",
        repo,
        "--format",
        "ndjson",
        "--verbose",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("--verbose is not compatible with --format ndjson"),
    });
  });

  it("returns a CLI error for invalid fail-on-findings thresholds", async () => {
    const repo = createRepo();

    await expect(
      runDiffwarden(repo, [
        "--target",
        "uncommitted",
        "--reviewer",
        "fake",
        "--cwd",
        repo,
        "--fail-on-findings",
        "P4",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Invalid --fail-on-findings value"),
    });
  });

  it("writes report provenance for a review run", async () => {
    const repo = createRepo();
    const reportDir = path.join(repo, "reports");
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const expectedDiff = git(repo, ["diff"]);

    const result = await runDiffwarden(repo, [
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--format",
      "json",
      "--strict",
      "--fail-on-findings",
      "P2",
      "--report",
      "--report-dir",
      reportDir,
      "--report-mode",
      "metadata",
    ]);
    const artifact = JSON.parse(result.stdout);
    const report = readSingleJsonReport(reportDir);

    expect(artifact.target.changed_files).toEqual(["tracked.txt"]);
    expect(report).toMatchObject({
      report_schema_version: 3,
      provenance: {
        diffwarden: {
          version: packageJson.version,
        },
        invocation: {
          target: "uncommitted",
          reviewers: ["fake"],
          strict: true,
          fail_on_findings: "P2",
          format: "json",
        },
        reviewer_selection: {
          requested_reviewers: ["fake"],
          resolved_reviewers: ["fake"],
        },
        target: {
          diff_sha256: sha256(expectedDiff),
          diff_bytes: Buffer.byteLength(expectedDiff),
          patch_persisted: false,
        },
      },
      invocation: {
        cwd: repo,
        reporting: {
          scope: "custom-dir",
          mode: "metadata",
        },
      },
      reviewers: [
        expect.objectContaining({
          id: "fake",
          engine: "fake",
          status: "success",
          adapter_metadata: {
            captureMode: "native-structured",
            readonlyCapability: "enforced",
          },
          preflight_metadata: {
            readonlyCapability: "enforced",
          },
        }),
      ],
    });
    expect(report).not.toHaveProperty("artifact");
  });

  it("validates report options before resolving reviewers", async () => {
    const repo = createRepo();

    await expect(
      runDiffwarden(repo, [
        "--target",
        "uncommitted",
        "--reviewer",
        "not-a-reviewer",
        "--cwd",
        repo,
        "--report-scope",
        "workspace",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Invalid --report-scope value"),
    });
  });

  it("writes stdout before surfacing report write failures", async () => {
    const repo = createRepo();
    const reportDir = path.join(repo, "report-file");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(reportDir, "not a directory\n");

    try {
      await runDiffwarden(repo, [
        "--target",
        "uncommitted",
        "--reviewer",
        "fake",
        "--cwd",
        repo,
        "--report",
        "--report-dir",
        reportDir,
      ]);
      throw new Error("Expected diffwarden to fail writing report");
    } catch (error) {
      expect(error).toMatchObject({
        code: 1,
        stdout: expect.stringContaining("# Code Review"),
      });
    }
  });

  it("runs doctor preflight checks without requiring a target", async () => {
    const repo = createRepo();

    const result = await runDiffwarden(repo, [
      "doctor",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--format",
      "json",
    ]);
    const report = JSON.parse(result.stdout);

    expect(report.reviewers).toHaveLength(1);
    expect(report.reviewers[0]).toMatchObject({
      id: "fake",
      engine: "fake",
      status: "passed",
      preflight: {
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "runtime", status: "passed" }),
        ]),
      },
    });
    expect(result.stderr).toBe("");
  });

  it("returns a CLI error for unsupported targets", async () => {
    const repo = createRepo();

    await expect(
      runDiffwarden(repo, ["--target", "pr:1", "--reviewer", "fake", "--cwd", repo]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Invalid target: pr:1"),
    });
  });
});

async function runDiffwarden(
  cwd: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...isolatedEnv(),
    ...envOverrides,
  };
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function parseNdjson(stdout: string): Array<{ type: string }> {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string });
}

function readPackageBinPath(): string {
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const binPath = packageJson.bin?.diffwarden;
  if (typeof binPath !== "string") {
    throw new Error("package.json is missing bin.diffwarden");
  }
  return binPath;
}

function createRepo(): string {
  const repo = mkdtemp("diffwarden-e2e-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const home = mkdtemp("diffwarden-e2e-home-");
  const configHome = mkdtemp("diffwarden-e2e-config-");
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
  };
}

function isExecError(error: unknown): error is { code: number; stdout: string; stderr: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "stdout" in error &&
    "stderr" in error &&
    typeof error.code === "number" &&
    typeof error.stdout === "string" &&
    typeof error.stderr === "string"
  );
}

function readSingleJsonReport(dir: string): Record<string, unknown> {
  const paths = findJsonReports(dir);
  expect(paths).toHaveLength(1);
  return JSON.parse(readFileSync(paths[0] ?? "", "utf8"));
}

function findJsonReports(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return findJsonReports(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mkdtemp(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
