import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { DiffwardenConfig } from "./config.js";
import { invalidCli } from "./errors.js";
import type {
  ReviewArtifact,
  ReviewArtifactFinding,
  ReviewReviewerArtifact,
  ReviewTargetResolved,
} from "./schema.js";

export type ReportingScope = "global" | "repo";
export type ReportStorageScope = ReportingScope | "custom-dir";
export type ReportingMode = "full" | "metadata";

export type ReportingCliOptions = {
  report?: boolean;
  reportDir?: string;
  reportScope?: string;
  reportMode?: string;
};

export type ResolvedReportingOptions = {
  enabled: boolean;
  dir: string;
  scope: ReportStorageScope;
  mode: ReportingMode;
};

export type FindingCountsByPriority = {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  unspecified: number;
};

export type ReviewReportFinding =
  | ReviewArtifactFinding
  | {
      title: string;
      confidence_score: number;
      priority?: 0 | 1 | 2 | 3;
      code_location: ReviewArtifactFinding["code_location"];
      reviewer_ids?: string[];
    };

export type ReviewReport = {
  report_schema_version: 1;
  run_id: string;
  created_at: string;
  invocation: {
    cwd: string;
    target: ReviewReportTarget;
    reporting: {
      scope: ReportStorageScope;
      mode: ReportingMode;
    };
  };
  reviewers: ReviewReportReviewer[];
  summary: {
    reviewer_count: number;
    successful_reviewer_count: number;
    failed_reviewer_count: number;
    finding_count: number;
    finding_counts_by_priority: FindingCountsByPriority;
    files_with_findings: string[];
    changed_file_count: number;
    elapsed_ms?: number;
    overall_correctness: ReviewArtifact["result"]["overall_correctness"];
    overall_confidence_score: number;
  };
  artifact?: ReviewArtifact;
};

export type ReviewReportTarget = Omit<ReviewTargetResolved, "instructions"> & {
  custom_instructions?: string;
};

export type ReviewReportReviewer = {
  id: string;
  sdk: ReviewReviewerArtifact["sdk"];
  transport?: NonNullable<ReviewReviewerArtifact["transport"]>;
  profile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  status: "success" | "failed";
  elapsed_ms?: number;
  finding_count: number;
  finding_counts_by_priority: FindingCountsByPriority;
  findings: ReviewReportFinding[];
  error?: NonNullable<ReviewReviewerArtifact["error"]>;
};

export type WriteReviewReportOptions = {
  artifact: ReviewArtifact;
  reporting: ResolvedReportingOptions;
  now?: Date;
  runId?: string;
};

export type WriteReviewReportResult = {
  path: string;
  report: ReviewReport;
};

export function resolveReportingOptions(options: {
  cwd: string;
  repoRoot: string;
  cli: ReportingCliOptions;
  config?: DiffwardenConfig;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): ResolvedReportingOptions {
  const config = options.config?.reporting;
  const enabled = options.cli.report ?? config?.enabled === true;
  const mode = parseReportingMode(options.cli.reportMode ?? config?.mode ?? "full");
  const configuredScope = options.cli.reportScope ?? config?.scope ?? "global";
  const scope = parseReportingScope(configuredScope);
  const explicitDir = options.cli.reportDir ?? config?.dir;

  if (!enabled) {
    return {
      enabled: false,
      dir: "",
      scope: explicitDir === undefined ? scope : "custom-dir",
      mode,
    };
  }

  if (explicitDir !== undefined) {
    return {
      enabled: true,
      dir: path.resolve(options.cwd, explicitDir),
      scope: "custom-dir",
      mode,
    };
  }

  return {
    enabled: true,
    dir:
      scope === "repo"
        ? path.join(options.repoRoot, ".diffwarden", "reports")
        : path.join(
            userStateDir(options.env ?? process.env, options.homeDir),
            "diffwarden",
            "reports",
          ),
    scope,
    mode,
  };
}

export async function writeReviewReport(
  options: WriteReviewReportOptions,
): Promise<WriteReviewReportResult | undefined> {
  if (!options.reporting.enabled) {
    return undefined;
  }

  const now = options.now ?? new Date();
  const runId = options.runId ?? randomUUID();
  const report = createReviewReport({
    artifact: options.artifact,
    reporting: options.reporting,
    now,
    runId,
  });
  const dir = path.join(
    options.reporting.dir,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  );
  const filePath = path.join(dir, `${safeTimestamp(now)}-${runId}.json`);

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

  return {
    path: filePath,
    report,
  };
}

export function createReviewReport(options: {
  artifact: ReviewArtifact;
  reporting: Pick<ResolvedReportingOptions, "scope" | "mode">;
  now?: Date;
  runId?: string;
}): ReviewReport {
  const createdAt = (options.now ?? new Date()).toISOString();
  const runId = options.runId ?? randomUUID();
  const reviewers = (options.artifact.reviewers ?? []).map((reviewer) =>
    createReviewerReport(reviewer, options.reporting.mode),
  );
  const summaryFindings = options.artifact.result.findings.map((finding) =>
    reportFinding(finding, options.reporting.mode),
  );
  const report: ReviewReport = {
    report_schema_version: 1,
    run_id: runId,
    created_at: createdAt,
    invocation: {
      cwd: options.artifact.cwd,
      target: reportTarget(options.artifact.target),
      reporting: {
        scope: options.reporting.scope,
        mode: options.reporting.mode,
      },
    },
    reviewers,
    summary: {
      reviewer_count: reviewers.length,
      successful_reviewer_count: reviewers.filter((reviewer) => reviewer.status === "success")
        .length,
      failed_reviewer_count: reviewers.filter((reviewer) => reviewer.status === "failed").length,
      finding_count: summaryFindings.length,
      finding_counts_by_priority: countFindingsByPriority(summaryFindings),
      files_with_findings: filesWithFindings(summaryFindings),
      changed_file_count: options.artifact.target.changed_files.length,
      ...(options.artifact.timing_ms !== undefined
        ? { elapsed_ms: options.artifact.timing_ms }
        : {}),
      overall_correctness: options.artifact.result.overall_correctness,
      overall_confidence_score: options.artifact.result.overall_confidence_score,
    },
    ...(options.reporting.mode === "full" ? { artifact: options.artifact } : {}),
  };

  return report;
}

function createReviewerReport(
  reviewer: ReviewReviewerArtifact,
  mode: ReportingMode,
): ReviewReportReviewer {
  const findings = (reviewer.result?.findings ?? []).map((finding) => reportFinding(finding, mode));

  return {
    id: reviewer.id,
    sdk: reviewer.sdk,
    ...(reviewer.transport !== undefined ? { transport: reviewer.transport } : {}),
    ...(reviewer.profile !== undefined ? { profile: reviewer.profile } : {}),
    ...(reviewer.provider !== undefined ? { provider: reviewer.provider } : {}),
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
    status: reviewer.status === "failed" ? "failed" : "success",
    ...(reviewer.timing_ms !== undefined ? { elapsed_ms: reviewer.timing_ms } : {}),
    finding_count: findings.length,
    finding_counts_by_priority: countFindingsByPriority(findings),
    findings,
    ...(reviewer.error !== undefined ? { error: reviewer.error } : {}),
  };
}

function reportFinding(finding: ReviewArtifactFinding, mode: ReportingMode): ReviewReportFinding {
  if (mode === "full") {
    return finding;
  }

  return {
    title: finding.title,
    confidence_score: finding.confidence_score,
    ...(finding.priority !== undefined ? { priority: finding.priority } : {}),
    code_location: finding.code_location,
    ...(finding.reviewer_ids !== undefined ? { reviewer_ids: finding.reviewer_ids } : {}),
  };
}

function reportTarget(target: ReviewTargetResolved): ReviewReportTarget {
  const { instructions, ...rest } = target;
  return {
    ...rest,
    ...(instructions !== undefined ? { custom_instructions: instructions } : {}),
  };
}

function countFindingsByPriority(findings: ReviewReportFinding[]): FindingCountsByPriority {
  const counts: FindingCountsByPriority = {
    p0: 0,
    p1: 0,
    p2: 0,
    p3: 0,
    unspecified: 0,
  };

  for (const finding of findings) {
    if (finding.priority === 0) {
      counts.p0 += 1;
    } else if (finding.priority === 1) {
      counts.p1 += 1;
    } else if (finding.priority === 2) {
      counts.p2 += 1;
    } else if (finding.priority === 3) {
      counts.p3 += 1;
    } else {
      counts.unspecified += 1;
    }
  }

  return counts;
}

function filesWithFindings(findings: ReviewReportFinding[]): string[] {
  return [...new Set(findings.map((finding) => finding.code_location.absolute_file_path))].sort();
}

function parseReportingScope(value: string): ReportingScope {
  if (value === "global" || value === "repo") {
    return value;
  }

  throw invalidCli(`Invalid --report-scope value: ${value}`);
}

function parseReportingMode(value: string): ReportingMode {
  if (value === "full" || value === "metadata") {
    return value;
  }

  throw invalidCli(`Invalid --report-mode value: ${value}`);
}

function userStateDir(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  if (env.XDG_STATE_HOME?.trim()) {
    return env.XDG_STATE_HOME;
  }

  return path.join(env.HOME?.trim() ? env.HOME : homeDir, ".local", "state");
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}
