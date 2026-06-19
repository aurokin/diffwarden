import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { mergeResolutionMetadataRecords } from "../adapters/metadata.js";
import type { DiffwardenConfig } from "./config.js";
import { invalidCli } from "./errors.js";
import type {
  ReviewArtifact,
  ReviewArtifactFinding,
  ReviewBatchArtifact,
  ReviewBatchLaneArtifact,
  ReviewPlan,
  ReviewReviewerArtifact,
  ReviewRunArtifact,
  ReviewTargetResolved,
} from "./schema.js";

export type ReportingScope = "global" | "repo";
export type ReportStorageScope = ReportingScope | "custom-dir";
export type ReportingMode = "full" | "metadata";
export type ReviewReportOutputFormat = "human" | "agent" | "json" | "ndjson";

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
      lane_ids?: string[];
    };

export type ReviewReport = {
  report_schema_version: 3;
  run_id: string;
  created_at: string;
  provenance: ReviewReportProvenance;
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
    lane_count?: number;
    successful_lane_count?: number;
    failed_lane_count?: number;
  };
  lanes?: ReviewReportLane[];
  artifact?: ReviewRunArtifact;
};

export type ReviewReportTarget = Omit<ReviewTargetResolved, "instructions"> & {
  custom_instructions?: string;
};

export type ReviewReportProvenance = {
  diffwarden: {
    version: string;
  };
  invocation: {
    target?: string;
    reviewers?: string[];
    reviewer_set?: string;
    model?: string;
    effort?: string;
    timeout_seconds?: number;
    strict: boolean;
    fail_on_findings?: string;
    format?: ReviewReportOutputFormat;
    output_mode?: ReviewReportOutputFormat;
    focus?: string[];
    include_overview?: boolean;
    review_plan?: ReviewPlan;
  };
  config?: {
    path: string;
    sha256: string;
  };
  reviewer_selection: {
    reviewer_set?: string;
    requested_reviewers?: string[];
    resolved_reviewers: string[];
  };
  target: {
    diff_sha256?: string;
    diff_bytes?: number;
    patch_persisted: false;
  };
};

export type ReviewReportReviewer = {
  id: string;
  engine: ReviewReviewerArtifact["engine"];
  transport?: NonNullable<ReviewReviewerArtifact["transport"]>;
  profile?: string;
  provider?: string;
  model?: string;
  model_resolution?: ReviewReportValueResolution;
  effort?: string;
  effort_resolution?: ReviewReportValueResolution;
  status: "success" | "failed";
  elapsed_ms?: number;
  usage?: unknown;
  adapter_metadata?: NonNullable<ReviewReviewerArtifact["adapter_metadata"]>;
  preflight_metadata?: NonNullable<NonNullable<ReviewReviewerArtifact["preflight"]>["metadata"]>;
  finding_count: number;
  finding_counts_by_priority: FindingCountsByPriority;
  findings: ReviewReportFinding[];
  error?: NonNullable<ReviewReviewerArtifact["error"]>;
};

export type ReviewReportLane = {
  id: string;
  kind: ReviewBatchLaneArtifact["kind"];
  focus?: string;
  status: ReviewBatchLaneArtifact["status"];
  elapsed_ms?: number;
  reviewer_count: number;
  successful_reviewer_count: number;
  failed_reviewer_count: number;
  finding_count: number;
  finding_counts_by_priority: FindingCountsByPriority;
  findings: ReviewReportFinding[];
  error?: NonNullable<Extract<ReviewBatchLaneArtifact, { status: "failed" }>["error"]>;
};

export type ReviewReportValueResolution = {
  requested?: string;
  resolved?: string;
  source?: string;
};

export type ReviewReportProvenanceInput = {
  diffwardenVersion?: string;
  targetSpec?: string;
  reviewers?: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeoutSeconds?: number;
  strict?: boolean;
  failOnFindings?: string;
  format?: ReviewReportOutputFormat;
  outputMode?: ReviewReportOutputFormat;
  focus?: string[];
  includeOverview?: boolean;
  reviewPlan?: ReviewPlan;
  config?: {
    path: string;
    sha256: string;
  };
  diff?: string;
};

export type WriteReviewReportOptions = {
  artifact: ReviewRunArtifact;
  reporting: ResolvedReportingOptions;
  provenance?: ReviewReportProvenanceInput;
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
    ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
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
  artifact: ReviewRunArtifact;
  reporting: Pick<ResolvedReportingOptions, "scope" | "mode">;
  provenance?: ReviewReportProvenanceInput;
  now?: Date;
  runId?: string;
}): ReviewReport {
  const createdAt = (options.now ?? new Date()).toISOString();
  const runId = options.runId ?? randomUUID();
  const reviewers = artifactReviewers(options.artifact).map((reviewer) =>
    createReviewerReport(reviewer, options.reporting.mode),
  );
  const summaryFindings = options.artifact.result.findings.map((finding) =>
    reportFinding(finding, options.reporting.mode),
  );
  const report: ReviewReport = {
    report_schema_version: 3,
    run_id: runId,
    created_at: createdAt,
    provenance: reportProvenance(options.artifact, options.provenance),
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
      ...batchSummaryCounts(options.artifact),
    },
    ...batchLaneReports(options.artifact, options.reporting.mode),
    ...(options.reporting.mode === "full" ? { artifact: options.artifact } : {}),
  };

  return report;
}

function createReviewerReport(
  reviewer: ReviewReviewerArtifact,
  mode: ReportingMode,
): ReviewReportReviewer {
  const findings = (reviewer.result?.findings ?? []).map((finding) => reportFinding(finding, mode));
  const modelResolution = reportValueResolution(reviewer, {
    requested: "requestedModel",
    resolved: "resolvedModel",
    source: "modelResolutionSource",
  });
  const effortResolution = reportValueResolution(reviewer, {
    requested: "requestedEffort",
    resolved: "resolvedEffort",
    source: "effortResolutionSource",
  });

  return {
    id: reviewer.id,
    engine: reviewer.engine,
    ...(reviewer.transport !== undefined ? { transport: reviewer.transport } : {}),
    ...(reviewer.profile !== undefined ? { profile: reviewer.profile } : {}),
    ...(reviewer.provider !== undefined ? { provider: reviewer.provider } : {}),
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(modelResolution !== undefined ? { model_resolution: modelResolution } : {}),
    ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
    ...(effortResolution !== undefined ? { effort_resolution: effortResolution } : {}),
    status: reviewer.status === "failed" ? "failed" : "success",
    ...(reviewer.timing_ms !== undefined ? { elapsed_ms: reviewer.timing_ms } : {}),
    ...(reviewer.usage !== undefined ? { usage: reviewer.usage } : {}),
    ...(reviewer.adapter_metadata !== undefined
      ? { adapter_metadata: reviewer.adapter_metadata }
      : {}),
    ...(reviewer.preflight?.metadata !== undefined
      ? { preflight_metadata: reviewer.preflight.metadata }
      : {}),
    finding_count: findings.length,
    finding_counts_by_priority: countFindingsByPriority(findings),
    findings,
    ...(reviewer.error !== undefined ? { error: reviewer.error } : {}),
  };
}

function artifactReviewers(artifact: ReviewRunArtifact): ReviewReviewerArtifact[] {
  if (isBatchArtifact(artifact)) {
    const reviewersById = new Map<string, ReviewReviewerArtifact>();
    for (const lane of artifact.lanes) {
      if (lane.status === "failed") {
        continue;
      }
      for (const reviewer of lane.artifact.reviewers ?? []) {
        if (!reviewersById.has(reviewer.id)) {
          reviewersById.set(reviewer.id, reviewer);
        }
      }
    }
    return [...reviewersById.values()];
  }

  return artifact.reviewers ?? [];
}

function batchSummaryCounts(
  artifact: ReviewRunArtifact,
): Pick<ReviewReport["summary"], "lane_count" | "successful_lane_count" | "failed_lane_count"> {
  if (!isBatchArtifact(artifact)) {
    return {};
  }

  return {
    lane_count: artifact.lanes.length,
    successful_lane_count: artifact.lanes.filter((lane) => lane.status === "success").length,
    failed_lane_count: artifact.lanes.filter((lane) => lane.status === "failed").length,
  };
}

function batchLaneReports(
  artifact: ReviewRunArtifact,
  mode: ReportingMode,
): Pick<ReviewReport, "lanes"> {
  if (!isBatchArtifact(artifact)) {
    return {};
  }

  return {
    lanes: artifact.lanes.map((lane) => createLaneReport(lane, mode)),
  };
}

function createLaneReport(lane: ReviewBatchLaneArtifact, mode: ReportingMode): ReviewReportLane {
  if (lane.status === "failed") {
    return {
      id: lane.id,
      kind: lane.kind,
      ...(lane.focus !== undefined ? { focus: lane.focus } : {}),
      status: lane.status,
      ...(lane.timing_ms !== undefined ? { elapsed_ms: lane.timing_ms } : {}),
      reviewer_count: 0,
      successful_reviewer_count: 0,
      failed_reviewer_count: 0,
      finding_count: 0,
      finding_counts_by_priority: countFindingsByPriority([]),
      findings: [],
      error: lane.error,
    };
  }

  const reviewers = lane.artifact.reviewers ?? [];
  const findings = lane.artifact.result.findings.map((finding) => reportFinding(finding, mode));
  return {
    id: lane.id,
    kind: lane.kind,
    ...(lane.focus !== undefined ? { focus: lane.focus } : {}),
    status: lane.status,
    ...(lane.timing_ms !== undefined ? { elapsed_ms: lane.timing_ms } : {}),
    reviewer_count: reviewers.length,
    successful_reviewer_count: reviewers.filter((reviewer) => reviewer.status !== "failed").length,
    failed_reviewer_count: reviewers.filter((reviewer) => reviewer.status === "failed").length,
    finding_count: findings.length,
    finding_counts_by_priority: countFindingsByPriority(findings),
    findings,
  };
}

function reportValueResolution(
  reviewer: ReviewReviewerArtifact,
  fields: {
    requested: string;
    resolved: string;
    source: string;
  },
): ReviewReportValueResolution | undefined {
  const metadata = mergeResolutionMetadataRecords(
    reviewer.preflight?.metadata,
    reviewer.adapter_metadata,
  );
  if (Object.keys(metadata).length === 0) {
    return undefined;
  }

  const resolution = {
    ...stringMetadataField(metadata, fields.requested, "requested"),
    ...stringMetadataField(metadata, fields.resolved, "resolved"),
    ...stringMetadataField(metadata, fields.source, "source"),
  };

  return Object.keys(resolution).length === 0 ? undefined : resolution;
}

function stringMetadataField<K extends keyof ReviewReportValueResolution>(
  metadata: Record<string, unknown>,
  metadataKey: string,
  reportKey: K,
): Pick<ReviewReportValueResolution, K> {
  const value = metadata[metadataKey];
  return typeof value === "string"
    ? ({ [reportKey]: value } as Pick<ReviewReportValueResolution, K>)
    : ({} as Pick<ReviewReportValueResolution, K>);
}

function reportProvenance(
  artifact: ReviewRunArtifact,
  input: ReviewReportProvenanceInput | undefined,
): ReviewReportProvenance {
  const diff = artifact.target.kind === "custom" ? undefined : input?.diff;

  return {
    diffwarden: {
      version: input?.diffwardenVersion ?? "unknown",
    },
    invocation: {
      ...(input?.targetSpec !== undefined ? { target: input.targetSpec } : {}),
      ...(input?.reviewers !== undefined ? { reviewers: input.reviewers } : {}),
      ...(input?.reviewerSet !== undefined ? { reviewer_set: input.reviewerSet } : {}),
      ...(input?.model !== undefined ? { model: input.model } : {}),
      ...(input?.effort !== undefined ? { effort: input.effort } : {}),
      ...(input?.timeoutSeconds !== undefined ? { timeout_seconds: input.timeoutSeconds } : {}),
      strict: input?.strict === true,
      ...(input?.failOnFindings !== undefined ? { fail_on_findings: input.failOnFindings } : {}),
      ...(input?.format !== undefined ? { format: input.format } : {}),
      ...(input?.outputMode !== undefined ? { output_mode: input.outputMode } : {}),
      ...(input?.focus !== undefined ? { focus: input.focus } : {}),
      ...(input?.includeOverview !== undefined ? { include_overview: input.includeOverview } : {}),
      ...(input?.reviewPlan !== undefined ? { review_plan: input.reviewPlan } : {}),
    },
    ...(input?.config !== undefined ? { config: input.config } : {}),
    reviewer_selection: {
      ...(input?.reviewerSet !== undefined ? { reviewer_set: input.reviewerSet } : {}),
      ...(input?.reviewers !== undefined ? { requested_reviewers: input.reviewers } : {}),
      resolved_reviewers: [...new Set(artifactReviewers(artifact).map((reviewer) => reviewer.id))],
    },
    target: {
      ...(diff !== undefined
        ? {
            diff_sha256: sha256(diff),
            diff_bytes: Buffer.byteLength(diff),
          }
        : {}),
      patch_persisted: false,
    },
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
    ...("lane_ids" in finding && Array.isArray(finding.lane_ids)
      ? { lane_ids: finding.lane_ids as string[] }
      : {}),
  };
}

function isBatchArtifact(artifact: ReviewRunArtifact): artifact is ReviewBatchArtifact {
  return "kind" in artifact && artifact.kind === "batch";
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
