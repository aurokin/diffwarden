import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReviewReport,
  resolveReportingOptions,
  writeReviewReport,
} from "../src/core/reporting.js";
import type { ReviewArtifact, ReviewBatchArtifact } from "../src/core/schema.js";

let root: string | undefined;

afterEach(() => {
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

describe("resolveReportingOptions", () => {
  it("keeps reporting disabled by default", () => {
    const options = resolveReportingOptions({
      cwd: "/repo",
      repoRoot: "/repo",
      cli: {},
      env: { HOME: "/home/test" },
    });

    expect(options).toEqual({
      enabled: false,
      dir: "",
      scope: "global",
      mode: "full",
    });
  });

  it("resolves global report history under XDG_STATE_HOME", () => {
    const options = resolveReportingOptions({
      cwd: "/repo",
      repoRoot: "/repo",
      cli: { report: true },
      env: { XDG_STATE_HOME: "/state" },
    });

    expect(options).toEqual({
      enabled: true,
      dir: path.join("/state", "diffwarden", "reports"),
      scope: "global",
      mode: "full",
    });
  });

  it("lets custom report directories override configured scope", () => {
    const options = resolveReportingOptions({
      cwd: "/repo",
      repoRoot: "/repo",
      cli: { report: true, reportDir: "reports" },
      config: {
        reporting: {
          enabled: true,
          scope: "repo",
        },
      },
    });

    expect(options).toMatchObject({
      enabled: true,
      dir: path.join("/repo", "reports"),
      scope: "custom-dir",
    });
  });

  it("lets CLI disable configured reporting", () => {
    const options = resolveReportingOptions({
      cwd: "/repo",
      repoRoot: "/repo",
      cli: { report: false },
      config: {
        reporting: {
          enabled: true,
        },
      },
    });

    expect(options.enabled).toBe(false);
  });

  it("rejects unsupported CLI reporting options", () => {
    expect(() =>
      resolveReportingOptions({
        cwd: "/repo",
        repoRoot: "/repo",
        cli: { reportScope: "workspace" },
      }),
    ).toThrow("Invalid --report-scope value");
    expect(() =>
      resolveReportingOptions({
        cwd: "/repo",
        repoRoot: "/repo",
        cli: { reportMode: "summary" },
      }),
    ).toThrow("Invalid --report-mode value");
  });
});

describe("createReviewReport", () => {
  it("includes invocation metadata, per-reviewer findings, and summary counts", () => {
    const artifact = reviewArtifact();

    const report = createReviewReport({
      artifact,
      reporting: {
        scope: "custom-dir",
        mode: "full",
      },
      provenance: {
        diffwardenVersion: "0.2.4",
        targetSpec: "custom:Review auth paths",
        reviewers: ["pi-default", "codex", "claude-cli"],
        model: "anthropic/claude-sonnet",
        timeoutSeconds: 300,
        strict: true,
        failOnFindings: "P2",
        format: "json",
        config: {
          path: "/repo/diffwarden.config.json",
          sha256: "config-sha",
        },
        diff: "diff --git a/auth.ts b/auth.ts\n",
      },
      now: new Date("2026-05-24T18:42:31.123Z"),
      runId: "run-1",
    });

    expect(report).toMatchObject({
      report_schema_version: 3,
      run_id: "run-1",
      created_at: "2026-05-24T18:42:31.123Z",
      provenance: {
        diffwarden: {
          version: "0.2.4",
        },
        invocation: {
          target: "custom:Review auth paths",
          reviewers: ["pi-default", "codex", "claude-cli"],
          model: "anthropic/claude-sonnet",
          timeout_seconds: 300,
          strict: true,
          fail_on_findings: "P2",
          format: "json",
        },
        config: {
          path: "/repo/diffwarden.config.json",
          sha256: "config-sha",
        },
        reviewer_selection: {
          requested_reviewers: ["pi-default", "codex", "claude-cli"],
          resolved_reviewers: ["pi-default", "codex", "claude-cli"],
        },
        target: {
          patch_persisted: false,
        },
      },
      invocation: {
        cwd: "/repo/packages/app",
        target: {
          kind: "custom",
          repo_root: "/repo",
          custom_instructions: "Review auth paths",
        },
        reporting: {
          scope: "custom-dir",
          mode: "full",
        },
      },
      summary: {
        reviewer_count: 3,
        successful_reviewer_count: 2,
        failed_reviewer_count: 1,
        finding_count: 2,
        finding_counts_by_priority: {
          p0: 0,
          p1: 1,
          p2: 0,
          p3: 1,
          unspecified: 0,
        },
        files_with_findings: ["/repo/auth.ts", "/repo/session.ts"],
        changed_file_count: 2,
        elapsed_ms: 1234,
      },
    });
    expect(report.reviewers[0]).toMatchObject({
      id: "pi-default",
      engine: "pi",
      transport: "native",
      elapsed_ms: 700,
      usage: {
        inputTokens: 10,
        outputTokens: 3,
      },
      adapter_metadata: {
        sdkVersion: "pi-sdk-test",
        requestedModel: "anthropic/claude-sonnet",
        resolvedModel: "openrouter/anthropic/claude-sonnet",
        modelResolutionSource: "provider-result",
        requestedEffort: "high",
        resolvedEffort: "medium",
        effortResolutionSource: "provider-result",
      },
      preflight_metadata: {
        readonlyCapability: "tool-restricted",
        requestedModel: "anthropic/claude-sonnet",
        resolvedModel: "anthropic/claude-sonnet",
        modelResolutionSource: "config",
      },
      model_resolution: {
        requested: "anthropic/claude-sonnet",
        resolved: "openrouter/anthropic/claude-sonnet",
        source: "provider-result",
      },
      effort_resolution: {
        requested: "high",
        resolved: "medium",
        source: "provider-result",
      },
      finding_count: 1,
    });
    expect(report.reviewers[1]).toMatchObject({
      id: "codex",
      engine: "codex",
      transport: "cli",
      finding_count: 1,
    });
    expect(report.reviewers[2]).toMatchObject({
      id: "claude-cli",
      engine: "claude",
      transport: "cli",
      status: "failed",
      error: {
        code: "reviewer_failed",
      },
    });
    expect(report.artifact).toBe(artifact);
  });

  it("redacts finding bodies and omits the artifact in metadata mode", () => {
    const report = createReviewReport({
      artifact: reviewArtifact(),
      reporting: {
        scope: "global",
        mode: "metadata",
      },
      runId: "run-1",
    });

    expect(report.artifact).toBeUndefined();
    expect(report.provenance.target.patch_persisted).toBe(false);
    expect(report.reviewers[0]?.findings[0]).toEqual({
      title: "Auth bypass",
      confidence_score: 0.91,
      priority: 1,
      code_location: {
        absolute_file_path: "/repo/auth.ts",
        line_range: {
          start: 10,
          end: 12,
        },
      },
    });
  });

  it("falls back to preflight value resolution when run metadata is unavailable", () => {
    const artifact = reviewArtifact();
    const reviewer = artifact.reviewers?.[0];
    if (reviewer === undefined) {
      throw new Error("missing reviewer fixture");
    }
    reviewer.adapter_metadata = undefined;
    reviewer.preflight = {
      checks: [{ name: "mock", status: "passed" }],
      metadata: {
        requestedModel: "sonnet",
        resolvedModel: "claude-sonnet-4-5",
        modelResolutionSource: "adapter-selection",
      },
    };

    const report = createReviewReport({
      artifact,
      reporting: {
        scope: "global",
        mode: "metadata",
      },
      runId: "run-1",
    });

    expect(report.reviewers[0]?.model_resolution).toEqual({
      requested: "sonnet",
      resolved: "claude-sonnet-4-5",
      source: "adapter-selection",
    });
    expect(report.reviewers[0]?.effort_resolution).toBeUndefined();
  });

  it("merges preflight intent with run-time resolution evidence", () => {
    const artifact = reviewArtifact();
    const reviewer = artifact.reviewers?.[0];
    if (reviewer === undefined) {
      throw new Error("missing reviewer fixture");
    }
    reviewer.preflight = {
      checks: [{ name: "mock", status: "passed" }],
      metadata: {
        requestedModel: "configured-model",
        resolvedModel: "configured-model",
        modelResolutionSource: "config",
      },
    };
    reviewer.adapter_metadata = {
      resolvedModel: "runtime-model",
      modelResolutionSource: "provider-result",
    };

    const report = createReviewReport({
      artifact,
      reporting: {
        scope: "global",
        mode: "metadata",
      },
      runId: "run-1",
    });

    expect(report.reviewers[0]?.model_resolution).toEqual({
      requested: "configured-model",
      resolved: "runtime-model",
      source: "provider-result",
    });
  });

  it("keeps selected preflight values ahead of lower-confidence provider-local run evidence", () => {
    const artifact = reviewArtifact();
    const reviewer = artifact.reviewers?.[0];
    if (reviewer === undefined) {
      throw new Error("missing reviewer fixture");
    }
    reviewer.preflight = {
      checks: [{ name: "mock", status: "passed" }],
      metadata: {
        requestedModel: "configured-model",
        resolvedModel: "configured-model",
        modelResolutionSource: "config",
      },
    };
    reviewer.adapter_metadata = {
      droidSessionModel: "session-model",
      resolvedModel: "session-model",
      modelResolutionSource: "provider-local",
    };

    const report = createReviewReport({
      artifact,
      reporting: {
        scope: "global",
        mode: "metadata",
      },
      runId: "run-1",
    });

    expect(report.reviewers[0]?.model_resolution).toEqual({
      requested: "configured-model",
      resolved: "configured-model",
      source: "config",
    });
    expect(report.reviewers[0]?.adapter_metadata).toMatchObject({
      droidSessionModel: "session-model",
    });
  });

  it("records focus batch provenance and metadata lane summaries", () => {
    const artifact = reviewBatchArtifact();
    const firstLane = artifact.lanes[0];
    if (firstLane === undefined) {
      throw new Error("missing lane fixture");
    }
    artifact.plan.focus.push("focus on reports");
    artifact.plan.lanes.push({ id: "focus-2", kind: "focus", focus: "focus on reports" });
    artifact.lanes.push({
      ...firstLane,
      id: "focus-2",
      focus: "focus on reports",
    });

    const report = createReviewReport({
      artifact,
      reporting: {
        scope: "global",
        mode: "metadata",
      },
      provenance: {
        diffwardenVersion: "0.3.3",
        targetSpec: "base:main",
        reviewers: ["pi-default"],
        strict: false,
        format: "json",
        outputMode: "json",
        focus: artifact.plan.focus,
        includeOverview: false,
        reviewPlan: artifact.plan,
        diff: "diff --git a/auth.ts b/auth.ts\n",
      },
      runId: "run-batch",
    });

    expect(report.artifact).toBeUndefined();
    expect(report.provenance.invocation).toMatchObject({
      target: "base:main",
      format: "json",
      output_mode: "json",
      focus: artifact.plan.focus,
      include_overview: false,
      review_plan: artifact.plan,
    });
    expect(report.provenance.target).toMatchObject({
      diff_sha256: sha256("diff --git a/auth.ts b/auth.ts\n"),
      diff_bytes: Buffer.byteLength("diff --git a/auth.ts b/auth.ts\n"),
      patch_persisted: false,
    });
    expect(report.summary).toMatchObject({
      lane_count: 2,
      successful_lane_count: 2,
      failed_lane_count: 0,
      finding_count: 2,
    });
    expect(report.lanes?.[0]).toMatchObject({
      id: "focus-1",
      kind: "focus",
      focus: "focus on state",
      status: "success",
      reviewer_count: 3,
      finding_count: 2,
    });
    expect(report.lanes?.[0]?.findings[0]).not.toHaveProperty("body");
    expect(report.lanes).toHaveLength(2);
    expect(report.reviewers).toHaveLength(3);
  });
});

describe("writeReviewReport", () => {
  it("writes report JSON into a date-partitioned directory", async () => {
    root = mkdtempSync(path.join(tmpdir(), "diffwarden-report-"));

    const result = await writeReviewReport({
      artifact: reviewArtifact(),
      reporting: {
        enabled: true,
        dir: root,
        scope: "custom-dir",
        mode: "full",
      },
      now: new Date("2026-05-24T18:42:31.123Z"),
      runId: "run-1",
    });

    const expectedPath = path.join(root, "2026", "05", "24", "2026-05-24T18-42-31.123Z-run-1.json");
    expect(result?.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(JSON.parse(readFileSync(expectedPath, "utf8"))).toMatchObject({
      run_id: "run-1",
      summary: {
        finding_count: 2,
      },
    });
  });
});

function reviewArtifact(): ReviewArtifact {
  return {
    schema_version: 2,
    reviewers: [
      {
        id: "pi-default",
        engine: "pi",
        transport: "native",
        status: "success",
        model: "anthropic/claude-sonnet",
        preflight: {
          checks: [{ name: "mock", status: "passed" }],
          metadata: {
            readonlyCapability: "tool-restricted",
            requestedModel: "anthropic/claude-sonnet",
            resolvedModel: "anthropic/claude-sonnet",
            modelResolutionSource: "config",
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 3,
        },
        adapter_metadata: {
          sdkVersion: "pi-sdk-test",
          requestedModel: "anthropic/claude-sonnet",
          resolvedModel: "openrouter/anthropic/claude-sonnet",
          modelResolutionSource: "provider-result",
          requestedEffort: "high",
          resolvedEffort: "medium",
          effortResolutionSource: "provider-result",
        },
        result: {
          findings: [
            {
              title: "Auth bypass",
              body: "Session validation is skipped.",
              confidence_score: 0.91,
              priority: 1,
              code_location: {
                absolute_file_path: "/repo/auth.ts",
                line_range: {
                  start: 10,
                  end: 12,
                },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "Auth checks are incomplete.",
          overall_confidence_score: 0.88,
        },
        validation: validation(),
        timing_ms: 700,
      },
      {
        id: "codex",
        engine: "codex",
        transport: "cli",
        status: "success",
        result: {
          findings: [
            {
              title: "Session leak",
              body: "Session state is retained after logout.",
              confidence_score: 0.86,
              priority: 3,
              code_location: {
                absolute_file_path: "/repo/session.ts",
                line_range: {
                  start: 22,
                  end: 24,
                },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "Logout handling is incomplete.",
          overall_confidence_score: 0.82,
        },
        validation: validation(),
        timing_ms: 400,
      },
      {
        id: "claude-cli",
        engine: "claude",
        transport: "cli",
        status: "failed",
        error: {
          code: "reviewer_failed",
          message: "Claude exploded",
          exit_code: 3,
        },
        timing_ms: 134,
      },
    ],
    cwd: "/repo/packages/app",
    target: {
      kind: "custom",
      repo_root: "/repo",
      head_sha: "abc123",
      instructions: "Review auth paths",
      diff_command: "custom instructions",
      changed_files: ["auth.ts", "session.ts"],
    },
    result: {
      findings: [
        {
          title: "Auth bypass",
          body: "Session validation is skipped.",
          confidence_score: 0.91,
          priority: 1,
          code_location: {
            absolute_file_path: "/repo/auth.ts",
            line_range: {
              start: 10,
              end: 12,
            },
          },
          reviewer_ids: ["pi-default"],
        },
        {
          title: "Session leak",
          body: "Session state is retained after logout.",
          confidence_score: 0.86,
          priority: 3,
          code_location: {
            absolute_file_path: "/repo/session.ts",
            line_range: {
              start: 22,
              end: 24,
            },
          },
          reviewer_ids: ["codex"],
        },
      ],
      overall_correctness: "patch is incorrect",
      overall_explanation: "Multiple reviewers found auth/session issues.",
      overall_confidence_score: 0.88,
    },
    validation: validation(),
    warnings: ["Reviewer claude-cli failed: Claude exploded"],
    timing_ms: 1234,
  };
}

function reviewBatchArtifact(): ReviewBatchArtifact {
  const laneArtifact = reviewArtifact();
  laneArtifact.target = {
    kind: "base",
    repo_root: "/repo",
    base_ref: "main",
    base_sha: "base",
    head_sha: "head",
    diff_command: "git diff base HEAD",
    changed_files: ["auth.ts", "session.ts"],
  };

  return {
    schema_version: 2,
    kind: "batch",
    cwd: "/repo/packages/app",
    target: laneArtifact.target,
    plan: {
      include_overview: false,
      focus: ["focus on state"],
      lanes: [{ id: "focus-1", kind: "focus", focus: "focus on state" }],
    },
    result: {
      ...laneArtifact.result,
      findings: laneArtifact.result.findings.map((finding) => ({
        ...finding,
        lane_ids: ["focus-1"],
      })),
    },
    validation: validation(),
    lanes: [
      {
        id: "focus-1",
        kind: "focus",
        focus: "focus on state",
        status: "success",
        artifact: laneArtifact,
        timing_ms: 1234,
      },
    ],
    timing_ms: 1234,
  };
}

function validation(): ReviewArtifact["validation"] {
  return {
    parse_mode: "strict-json",
    valid_schema: true,
    findings_overlap_diff: true,
    valid_locations: true,
    invalid_locations: [],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
