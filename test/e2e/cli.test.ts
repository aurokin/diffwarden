import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("shows command help when no command is selected", async () => {
    const result = await runDiffwarden(process.cwd(), []);

    expect(result.stdout).toContain("Usage: diffwarden");
    expect(result.stdout).toContain("review");
    expect(result.stderr).toBe("");
  });

  it("rejects command-local options at the root", async () => {
    await expect(
      runDiffwarden(process.cwd(), ["--cwd", process.cwd(), "reviewers", "list"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown option '--cwd'"),
    });

    await expect(
      runDiffwarden(process.cwd(), ["--reviewer", "fake", "doctor"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown option '--reviewer'"),
    });
  });

  it("reviews uncommitted changes with the fake reviewer in JSON mode", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(path.join(repo, "new.txt"), "new\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--json",
    ]);
    const artifact = JSON.parse(result.stdout);

    expect(artifact).toMatchObject({
      schema_version: 2,
      engine: "fake",
      target: {
        kind: "uncommitted",
      },
      result: {
        overall_correctness: "patch is correct",
      },
    });
    expect(artifact.target.changed_files).toEqual(
      expect.arrayContaining(["new.txt", "tracked.txt"]),
    );
    expect(artifact.target.changed_files).toHaveLength(2);
    expect(artifact.result.overall_explanation).toContain(
      "Fake reviewer inspected 2 changed file(s).",
    );
    expect(result.stderr).toBe("");
  });

  it("emits plain agent-readable review output", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--agent",
    ]);

    expect(result.stdout).toContain("Diffwarden Review");
    expect(result.stdout).toContain("Target: uncommitted");
    expect(result.stdout).toContain("Verdict: patch is correct");
    expect(result.stdout).toContain("Fake reviewer inspected 1 changed file(s).");
    expect(result.stdout).not.toContain("\u001B[");
    expect(result.stderr).toBe("");
  });

  it("reviews custom instructions with the fake reviewer in JSON", async () => {
    const repo = createRepo();

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "custom:Review auth paths",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--json",
    ]);
    const artifact = JSON.parse(result.stdout);

    expect(artifact.target.kind).toBe("custom");
    expect(artifact.target.instructions).toBe("Review auth paths");
    expect(artifact.target.changed_files).toEqual([]);
    expect(artifact.validation.valid_locations).toBe(true);
    expect(artifact.validation.findings_overlap_diff).toBe(true);
  });

  it("runs one focused diff-backed lane in JSON mode", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--no-overview",
      "--focus",
      "focus on state management",
      "--json",
    ]);
    const artifact = JSON.parse(result.stdout);

    expect(artifact).toMatchObject({
      schema_version: 2,
      kind: "batch",
      plan: {
        include_overview: false,
        focus: ["focus on state management"],
        lanes: [{ id: "focus-1", kind: "focus", focus: "focus on state management" }],
      },
      lanes: [
        {
          id: "focus-1",
          kind: "focus",
          focus: "focus on state management",
          status: "success",
        },
      ],
    });
    expect(artifact.lanes[0].artifact.target.changed_files).toEqual(["tracked.txt"]);
  });

  it("rejects focus lanes for custom targets", async () => {
    const repo = createRepo();

    await expect(
      runDiffwarden(repo, [
        "review",
        "--target",
        "custom:Review auth paths",
        "--reviewer",
        "fake",
        "--cwd",
        repo,
        "--focus",
        "focus on auth",
        "--json",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("--focus is only supported for diff-backed targets"),
    });
  });

  it("applies reviewPlan.includeOverview and lets --overview override it", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(
      path.join(repo, "diffwarden.config.json"),
      `${JSON.stringify({ reviewPlan: { includeOverview: false } }, null, 2)}\n`,
    );

    const configResult = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--focus",
      "focus on state",
      "--json",
    ]);
    expect(
      JSON.parse(configResult.stdout).plan.lanes.map((lane: { id: string }) => lane.id),
    ).toEqual(["focus-1"]);

    const cliResult = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--overview",
      "--focus",
      "focus on state",
      "--json",
    ]);
    expect(JSON.parse(cliResult.stdout).plan.lanes.map((lane: { id: string }) => lane.id)).toEqual([
      "overview",
      "focus-1",
    ]);
  });

  it("allows focus text that looks like an overview flag", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--no-overview",
      "--focus",
      "--overview",
      "--json",
    ]);

    expect(JSON.parse(result.stdout).plan).toMatchObject({
      include_overview: false,
      focus: ["--overview"],
      lanes: [{ id: "focus-1", kind: "focus", focus: "--overview" }],
    });
  });

  it("rejects conflicting overview controls", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    await expect(
      runDiffwarden(repo, [
        "review",
        "--target",
        "uncommitted",
        "--reviewer",
        "fake",
        "--cwd",
        repo,
        "--overview",
        "--no-overview",
        "--focus",
        "focus on state",
        "--json",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Choose only one overview control"),
    });
  });

  it("exits 1 after writing output when findings meet the fail-on-findings threshold", async () => {
    const repo = createRepo();
    const outputPath = path.join(repo, "review.json");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    try {
      await runDiffwarden(
        repo,
        [
          "review",
          "--target",
          "uncommitted",
          "--reviewer",
          "fake",
          "--cwd",
          repo,
          "--json",
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

  it("exits 1 for focus batch findings that meet the fail-on-findings threshold", async () => {
    const repo = createRepo();
    const outputPath = path.join(repo, "review-batch.json");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    try {
      await runDiffwarden(
        repo,
        [
          "review",
          "--target",
          "uncommitted",
          "--reviewer",
          "fake",
          "--cwd",
          repo,
          "--no-overview",
          "--focus",
          "focus on state",
          "--json",
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
      expect(stdoutArtifact).toMatchObject({
        kind: "batch",
        result: {
          findings: [
            expect.objectContaining({
              title: "[P2] Fake finding",
              priority: 2,
              lane_ids: ["focus-1"],
            }),
          ],
        },
      });
      expect(outArtifact.kind).toBe("batch");
    }
  });

  it("streams NDJSON events to stdout ending with the final result", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--ndjson",
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

  it("streams focus batch NDJSON events with lane ids", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--no-overview",
      "--focus",
      "focus on state",
      "--ndjson",
    ]);

    const events = parseNdjson(result.stdout);
    expect(events[0]?.type).toBe("batch_started");
    expect(
      events.some((event) => event.type === "run_started" && event.lane_id === "focus-1"),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "lane_finished" && event.lane_id === "focus-1"),
    ).toBe(true);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("final_result");
    expect((terminal as { artifact?: { kind?: string } }).artifact?.kind).toBe("batch");
    expect(
      events.filter((event) => event.type === "final_result" || event.type === "error"),
    ).toHaveLength(1);
    expect(result.stderr).toBe("");
  });

  it("rejects multiple review output modes", async () => {
    await expect(
      runDiffwarden(process.cwd(), [
        "review",
        "--target",
        "uncommitted",
        "--reviewer",
        "fake",
        "--json",
        "--ndjson",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "Choose only one review output mode: --agent, --json, or --ndjson",
      ),
    });
  });

  it("writes report provenance for a review run", async () => {
    const repo = createRepo();
    const reportDir = path.join(repo, "reports");
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const expectedDiff = git(repo, ["diff"]);

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--json",
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

  it("writes stdout before surfacing report write failures", async () => {
    const repo = createRepo();
    const reportDir = path.join(repo, "report-file");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(reportDir, "not a directory\n");

    try {
      await runDiffwarden(repo, [
        "review",
        "--target",
        "uncommitted",
        "--reviewer",
        "fake",
        "--cwd",
        repo,
        "--json",
        "--report",
        "--report-dir",
        reportDir,
      ]);
      throw new Error("Expected diffwarden to fail writing report");
    } catch (error) {
      expect(error).toMatchObject({
        code: 1,
        stdout: expect.stringContaining('"schema_version": 2'),
      });
    }
  });

  it("runs the explicit human review display and can write JSON with --out", async () => {
    const repo = createRepo();
    const outputPath = path.join(repo, "review.json");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--out",
      outputPath,
    ]);

    expect(result.stdout).toContain("diffwarden review");
    expect(result.stdout).toContain("Target: uncommitted");
    expect(result.stdout).toContain("Reviewers: fake");
    expect(result.stdout).toContain("fake preflight");
    expect(result.stdout).toContain("fake reviewing");
    expect(result.stdout).toContain("Result");
    expect(result.stdout).toContain("Verdict: patch is correct");
    expect(result.stdout).toContain("No findings.");
    expect(result.stderr).toBe("");

    const artifact = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(artifact).toMatchObject({
      schema_version: 2,
      engine: "fake",
      target: { kind: "uncommitted" },
    });
  });

  it("renders a saved review artifact", async () => {
    const repo = createRepo();
    const outputPath = path.join(repo, "review.json");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--json",
      "--out",
      outputPath,
    ]);

    const result = await runDiffwarden(repo, ["review", "show", outputPath]);

    expect(result.stdout).toContain("diffwarden review");
    expect(result.stdout).toContain("Target: uncommitted");
    expect(result.stdout).toContain("Reviewers: fake");
    expect(result.stdout).toContain("Verdict: patch is correct");
    expect(result.stdout).toContain("No findings.");
    expect(result.stderr).toBe("");

    const parentJsonResult = await runDiffwarden(repo, ["review", "--json", "show", outputPath]);
    const artifact = JSON.parse(parentJsonResult.stdout);
    expect(artifact).toMatchObject({
      schema_version: 2,
      target: { kind: "uncommitted" },
    });

    const agentResult = await runDiffwarden(repo, ["review", "show", outputPath, "--agent"]);
    expect(agentResult.stdout).toContain("Diffwarden Review");
    expect(agentResult.stdout).toContain("Verdict: patch is correct");
    expect(agentResult.stdout).not.toContain("\u001B[");
  });

  it("renders a saved focus batch artifact", async () => {
    const repo = createRepo();
    const outputPath = path.join(repo, "review-batch.json");
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--no-overview",
      "--focus",
      "focus on state",
      "--json",
      "--out",
      outputPath,
    ]);

    const human = await runDiffwarden(repo, ["review", "show", outputPath]);
    expect(human.stdout).toContain("diffwarden review batch");
    expect(human.stdout).toContain("Lane focus-1: focus on state");

    const agent = await runDiffwarden(repo, ["review", "show", outputPath, "--agent"]);
    expect(agent.stdout).toContain("Diffwarden Review Batch");
    expect(agent.stdout).toContain("focus-1: focus on state");

    const json = await runDiffwarden(repo, ["review", "show", outputPath, "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schema_version: 2,
      kind: "batch",
    });
  });

  it("resolves review show artifact paths relative to review --cwd", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--json",
      "--out",
      "review.json",
    ]);

    const result = await runDiffwarden(process.cwd(), [
      "review",
      "--cwd",
      repo,
      "show",
      "review.json",
    ]);

    expect(result.stdout).toContain("diffwarden review");
    expect(result.stdout).toContain("Target: uncommitted");
    expect(result.stdout).toContain("Reviewers: fake");
    expect(result.stderr).toBe("");
  });

  it("rejects event-stream mode for saved review artifacts", async () => {
    await expect(
      runDiffwarden(process.cwd(), ["review", "--ndjson", "show", "missing-review.json"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("--ndjson is not compatible with diffwarden review show"),
    });
  });

  it("reports missing saved review artifacts as CLI input errors", async () => {
    await expect(
      runDiffwarden(process.cwd(), ["review", "show", "missing-review.json"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Unable to read ReviewArtifact JSON"),
    });
  });

  it("runs the human review display with local review options after the subcommand", async () => {
    const repo = createRepo();
    writeFileSync(path.join(repo, "tracked.txt"), "changed\n");

    const result = await runDiffwarden(repo, [
      "review",
      "--target",
      "uncommitted",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
    ]);

    expect(result.stdout).toContain("diffwarden review");
    expect(result.stdout).toContain("Target: uncommitted");
    expect(result.stdout).toContain("Reviewers: fake");
    expect(result.stdout).toContain("fake preflight");
    expect(result.stdout).toContain("fake reviewing");
    expect(result.stdout).toContain("Result");
    expect(result.stdout).toContain("Verdict: patch is correct");
    expect(result.stdout).toContain("No findings.");
    expect(result.stderr).toBe("");
  });

  it("runs doctor preflight checks without requiring a target", async () => {
    const repo = createRepo();

    const result = await runDiffwarden(repo, [
      "doctor",
      "--reviewer",
      "fake",
      "--cwd",
      repo,
      "--json",
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

  it("lists configured reviewers in human text without running preflight", async () => {
    const repo = createRepo();
    writeDiffwardenConfig(repo);

    const result = await runDiffwarden(repo, ["reviewers", "list", "--cwd", repo]);

    expect(result.stdout).toContain("# Diffwarden Reviewers");
    expect(result.stdout).toContain(`Config: ${expectedConfigPath(repo)}`);
    expect(result.stdout).toContain("Default reviewer set: 2");
    expect(result.stdout).toContain("| 2 | cursor-fast, pi-openrouter-high | yes |");
    expect(result.stdout).toContain(
      "| cursor-fast | cursor | no | fast | native |  | composer-2.5 |  |",
    );
    expect(result.stdout).toContain(
      "| pi-openrouter-high | pi | yes | openrouter-high | native | openrouter | anthropic/claude-sonnet | high |",
    );
    expect(result.stdout).not.toContain("OPENROUTER_API_KEY");
    expect(result.stdout).not.toContain("providerProfile");
    expect(result.stderr).toBe("");
  });

  it("lists configured reviewers in JSON without leaking nested option bags", async () => {
    const repo = createRepo();
    writeDiffwardenConfig(repo);

    const result = await runDiffwarden(repo, ["reviewers", "list", "--cwd", repo, "--json"]);
    const summary = JSON.parse(result.stdout);

    expect(summary).toMatchObject({
      schema_version: 2,
      config: {
        path: expectedConfigPath(repo),
        sha256: expect.any(String),
      },
      defaultReviewerSet: "2",
      reviewerSets: {
        "1": ["pi-default"],
        "2": ["cursor-fast", "pi-openrouter-high"],
      },
      reviewers: [
        {
          id: "pi-default",
          engine: "pi",
          enabled: true,
          transport: "native",
        },
        {
          id: "cursor-fast",
          engine: "cursor",
          enabled: false,
          profile: "fast",
          transport: "native",
          model: "composer-2.5",
        },
        {
          id: "pi-openrouter-high",
          engine: "pi",
          enabled: true,
          profile: "openrouter-high",
          transport: "native",
          provider: "openrouter",
          model: "anthropic/claude-sonnet",
          effort: "high",
        },
      ],
    });
    expect(result.stdout).not.toContain("providerOptions");
    expect(result.stdout).not.toContain("sdkOptions");
    expect(result.stdout).not.toContain("OPENROUTER_API_KEY");
    expect(result.stderr).toBe("");
  });

  it("requires config before listing reviewers", async () => {
    const repo = createRepo();

    await expect(runDiffwarden(repo, ["reviewers", "list", "--cwd", repo])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("No diffwarden config found"),
    });
  });
});

describe("diffwarden discovery & setup e2e", () => {
  it("probes the host for reviewers in human text without spending budget", async () => {
    const result = await runDiffwarden(process.cwd(), ["reviewers", "discover"]);

    expect(result.stdout).toContain("Diffwarden reviewer discovery");
    expect(result.stdout).toContain("Ready to use (");
    expect(result.stdout).toContain("Needs attention (");
    expect(result.stdout).toContain("Not installed (");
    expect(result.stdout).toContain("Shallow probe only");
    expect(result.stderr).toBe("");
  });

  it("emits structured discovery JSON with a partitioned, credential-free summary", async () => {
    const result = await runDiffwarden(process.cwd(), ["reviewers", "discover", "--json"]);
    const discovery = JSON.parse(result.stdout);

    expect(discovery).toMatchObject({ schema_version: 1, deep: false });
    expect(Array.isArray(discovery.candidates)).toBe(true);
    expect(discovery.candidates.length).toBeGreaterThan(0);

    for (const candidate of discovery.candidates) {
      expect(candidate).toMatchObject({
        engine: expect.any(String),
        transport: expect.any(String),
        status: expect.any(String),
        authState: expect.any(String),
        detail: expect.any(String),
      });
      // The isolated env carries no API keys and a fresh HOME, so nothing can verify auth.
      expect(candidate.authState).not.toBe("verified");
    }

    // Every candidate falls into exactly one rendered group; the summary partitions them.
    const summarized =
      discovery.summary.available.length +
      discovery.summary.needsAttention.length +
      discovery.summary.missing.length;
    expect(summarized).toBe(discovery.candidates.length);
    expect(result.stderr).toBe("");
  });

  it("adds a reviewer to the user config and reports the env-located write target", async () => {
    const configHome = mkdtemp("diffwarden-e2e-xdg-");
    const configPath = userConfigFile(configHome);

    const result = await runDiffwarden(process.cwd(), ["reviewers", "add", "codex", "--json"], {
      XDG_CONFIG_HOME: configHome,
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      path: configPath,
      created: true,
      action: "added",
      reviewer: { id: "codex", engine: "codex" },
    });
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.reviewers).toHaveLength(1);
    expect(written.reviewers[0]).toEqual({ id: "codex", engine: "codex" });
    expect(result.stderr).toBe("");
  });

  it("adds a reviewer to a reviewer set and merges in place on re-add", async () => {
    const configHome = mkdtemp("diffwarden-e2e-xdg-");
    const env = { XDG_CONFIG_HOME: configHome };
    const configPath = userConfigFile(configHome);

    const first = await runDiffwarden(
      process.cwd(),
      ["reviewers", "add", "codex", "--set", "1", "--json"],
      env,
    );
    expect(JSON.parse(first.stdout)).toMatchObject({
      created: true,
      action: "added",
      reviewerSet: "1",
      reviewer: { id: "codex", engine: "codex" },
    });
    expect(JSON.parse(readFileSync(configPath, "utf8")).reviewerSets).toEqual({ "1": ["codex"] });

    // Re-adding the same id updates in place rather than appending a duplicate.
    const second = await runDiffwarden(process.cwd(), ["reviewers", "add", "codex", "--json"], env);
    expect(JSON.parse(second.stdout)).toMatchObject({ created: false, action: "updated" });
    expect(JSON.parse(readFileSync(configPath, "utf8")).reviewers).toHaveLength(1);
  });

  it("rejects an add with no engine and an unknown engine", async () => {
    await expect(runDiffwarden(process.cwd(), ["reviewers", "add"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Specify a reviewer engine to add"),
    });

    await expect(runDiffwarden(process.cwd(), ["reviewers", "add", "bogus"])).rejects.toMatchObject(
      {
        code: 2,
        stderr: expect.stringContaining("Unknown reviewer engine: bogus"),
      },
    );
  });

  it("writes a static starter config for a non-TTY init and requires a TTY for --interactive", async () => {
    const configHome = mkdtemp("diffwarden-e2e-xdg-");
    const configPath = userConfigFile(configHome);

    // A bare init in a non-TTY (the child process here) stays declarative: static starter, no prompt.
    const result = await runDiffwarden(process.cwd(), ["init"], {
      XDG_CONFIG_HOME: configHome,
    });
    expect(result.stdout).toContain(`Created ${configPath}`);
    expect(existsSync(configPath)).toBe(true);

    // --interactive forces the guided flow, which needs a real TTY; a non-TTY must error, not hang.
    // A discoverable engine ensures we reach the TTY guard rather than the empty-discovery error.
    const binDir = makeFakeExecutables(["grok"]);
    await expect(
      runDiffwarden(process.cwd(), ["init", "--interactive"], {
        XDG_CONFIG_HOME: mkdtemp("diffwarden-e2e-xdg-"),
        PATH: binDir,
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("requires an interactive terminal (TTY)"),
    });
  });

  it("scaffolds the user config from discovered reviewers with init --discover", async () => {
    const configHome = mkdtemp("diffwarden-e2e-xdg-");
    const configPath = userConfigFile(configHome);
    // grok is login-delegated, so a resolvable executable alone makes it an available candidate.
    const binDir = makeFakeExecutables(["grok"]);

    const result = await runDiffwarden(process.cwd(), ["init", "--discover", "--json"], {
      XDG_CONFIG_HOME: configHome,
      PATH: binDir,
    });

    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ path: configPath, created: true });
    expect(output.reviewers).toEqual(
      expect.arrayContaining([expect.objectContaining({ engine: "grok" })]),
    );
    expect(existsSync(configPath)).toBe(true);
  });
});

describe("diffwarden reviewer mutation e2e", () => {
  it("round-trips edit, set membership, and remove through the CLI", async () => {
    const configHome = mkdtemp("diffwarden-e2e-xdg-");
    const env = { XDG_CONFIG_HOME: configHome };
    const configPath = userConfigFile(configHome);

    await runDiffwarden(process.cwd(), ["reviewers", "add", "codex", "--json"], env);
    await runDiffwarden(process.cwd(), ["reviewers", "add", "grok", "--json"], env);

    const edited = await runDiffwarden(
      process.cwd(),
      ["reviewers", "edit", "codex", "--model", "gpt-5.5", "--json"],
      env,
    );
    expect(JSON.parse(edited.stdout).reviewer).toMatchObject({ id: "codex", model: "gpt-5.5" });

    await runDiffwarden(process.cwd(), ["reviewers", "set", "add", "1", "codex", "--json"], env);
    const setAdd = await runDiffwarden(
      process.cwd(),
      ["reviewers", "set", "add", "1", "grok", "--json"],
      env,
    );
    expect(JSON.parse(setAdd.stdout)).toMatchObject({ set: "1", members: ["codex", "grok"] });

    const removed = await runDiffwarden(
      process.cwd(),
      ["reviewers", "remove", "grok", "--json"],
      env,
    );
    expect(JSON.parse(removed.stdout)).toMatchObject({ removed: "grok", prunedFromSets: ["1"] });

    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.reviewers.map((r: { id: string }) => r.id)).toEqual(["codex"]);
    expect(raw.reviewerSets["1"]).toEqual(["codex"]);
  });

  it("rejects remove/edit of an unknown reviewer and an empty edit", async () => {
    const configHome = mkdtemp("diffwarden-e2e-xdg-");
    const env = { XDG_CONFIG_HOME: configHome };
    await runDiffwarden(process.cwd(), ["reviewers", "add", "codex", "--json"], env);

    await expect(
      runDiffwarden(process.cwd(), ["reviewers", "remove", "ghost"], env),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('No reviewer with id "ghost"'),
    });

    await expect(
      runDiffwarden(process.cwd(), ["reviewers", "edit", "codex"], env),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Specify at least one field to edit"),
    });
  });

  it("requires an id for a no-id remove/edit in a non-TTY", async () => {
    const configHome = mkdtemp("diffwarden-e2e-xdg-");
    const env = { XDG_CONFIG_HOME: configHome };
    await runDiffwarden(process.cwd(), ["reviewers", "add", "codex", "--json"], env);

    // No id + non-TTY: the picker would hang, so both commands error with an actionable hint.
    await expect(runDiffwarden(process.cwd(), ["reviewers", "remove"], env)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Specify a reviewer id to remove"),
    });

    await expect(
      runDiffwarden(process.cwd(), ["reviewers", "edit", "--disabled"], env),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Specify a reviewer id to edit"),
    });

    // The patch is still validated first: a no-field edit reports the missing field, not the id.
    await expect(runDiffwarden(process.cwd(), ["reviewers", "edit"], env)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Specify at least one field to edit"),
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

function parseNdjson(
  stdout: string,
): Array<{ type: string; lane_id?: string; artifact?: { kind?: string; engine?: string } }> {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          lane_id?: string;
          artifact?: { kind?: string; engine?: string };
        },
    );
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

function writeDiffwardenConfig(repo: string): void {
  writeFileSync(
    path.join(repo, "diffwarden.config.json"),
    `${JSON.stringify(
      {
        defaultReviewerSet: "2",
        reviewerSets: {
          "1": ["pi-default"],
          "2": ["cursor-fast", "pi-openrouter-high"],
        },
        reviewers: [
          {
            id: "pi-default",
            engine: "pi",
          },
          {
            id: "cursor-fast",
            engine: "cursor",
            profile: "fast",
            transport: "sdk",
            enabled: false,
            model: "composer-2.5",
          },
          {
            id: "pi-openrouter-high",
            engine: "pi",
            profile: "openrouter-high",
            provider: "openrouter",
            model: "anthropic/claude-sonnet",
            effort: "high",
            providerOptions: {
              apiKeyEnv: "OPENROUTER_API_KEY",
            },
            sdkOptions: {
              providerProfile: "openrouter",
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function expectedConfigPath(repo: string): string {
  return path.join(repo, "diffwarden.config.json");
}

function userConfigFile(configHome: string): string {
  return path.join(configHome, "diffwarden", "diffwarden.config.json");
}

function makeFakeExecutables(names: string[]): string {
  const binDir = mkdtemp("diffwarden-e2e-bin-");
  for (const name of names) {
    const file = path.join(binDir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return binDir;
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
