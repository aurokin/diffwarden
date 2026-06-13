#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { defaultReviewerModel, defaultReviewerTransport } from "./adapters/capabilities.js";
import {
  type LoadedDiffwardenConfig,
  initDiffwardenConfig,
  loadDiffwardenConfig,
} from "./core/config.js";
import {
  parseTimeoutSeconds,
  resolveReviewEnvOptionsWithSettings,
  resolveReviewerSelectionWithEnv,
} from "./core/env.js";
import {
  DiffwardenError,
  type ReviewErrorCode,
  invalidCli,
  invalidConfig,
  reviewerFailed,
} from "./core/errors.js";
import { hasFindingAtOrAbovePriority, parseFindingFailureThreshold } from "./core/finding-gate.js";
import { resolveGitTarget } from "./core/git.js";
import {
  renderHumanReviewEvent,
  renderHumanReviewSummary,
  shouldUseHumanColor,
} from "./core/human-render.js";
import { type MacosDoctorReport, runMacosDoctor } from "./core/macos.js";
import { renderJson, renderMarkdown } from "./core/render.js";
import {
  type ReviewReportOutputFormat,
  resolveReportingOptions,
  writeReviewReport,
} from "./core/reporting.js";
import type { ReviewerOverrideSource } from "./core/reviewer.js";
import {
  type ReviewerPreflightReport,
  runReviewEvents,
  runReviewerPreflightReport,
} from "./core/runner.js";
import type { ReviewArtifact, ReviewEvent, ReviewerError } from "./core/schema.js";
import { parseTargetSpec } from "./core/target.js";
import { version } from "./version.js";

const program = new Command();
program.enablePositionalOptions();
const collectReviewers = (value: string, previous: string[]): string[] => [...previous, value];
const collectValues = (value: string, previous: string[]): string[] => [...previous, value];

type ReviewerListSummary = {
  schema_version: 2;
  config: {
    path: string;
    sha256: string;
  };
  defaultReviewerSet?: string;
  reviewerSets: Record<string, string[]>;
  reviewers: ReviewerListEntry[];
};

type ReviewerListEntry = {
  id: string;
  engine: string;
  enabled: boolean;
  profile?: string;
  transport: "native" | "cli" | "app-server";
  provider?: string;
  model?: string;
  effort?: string;
};

type OverrideSelection = {
  value: string;
  source: ReviewerOverrideSource;
};

type ReviewOutputFormat = "markdown" | "json" | "ndjson";

type ReviewCliOptions = {
  target: string;
  reviewer: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  strict?: boolean;
  failOnFindings?: string;
  verbose?: boolean;
  cwd: string;
  format: ReviewOutputFormat | "human";
  out?: string;
  report?: boolean;
  reportDir?: string;
  reportScope?: string;
  reportMode?: string;
};

program
  .name("diffwarden")
  .description("A small CLI for agent-callable code review.")
  .version(version)
  .option(
    "--target <target>",
    "review target, such as uncommitted, base:main, commit:abc123, or custom:Review auth",
  )
  .option(
    "--reviewer <spec>",
    "reviewer spec, such as fake, cursor, claude, pi, droid, codex, gemini, opencode, grok, antigravity, or pi:profile",
    collectReviewers,
    [],
  )
  .option("--reviewer-set <name>", "reviewer set name from config")
  .option("--model <id>", "model override for the selected reviewer")
  .option("--effort <level>", "effort override for the selected reviewer")
  .option("--timeout <seconds>", "reviewer timeout in seconds")
  .option("--strict", "fail if any reviewer fails")
  .option("--fail-on-findings <priority>", "exit 1 when findings include P0, P1, P2, or P3")
  .option("--verbose", "include per-reviewer details in Markdown output")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--format <format>", "output format: markdown, json, or ndjson", "json")
  .option("--out <path>", "write the full ReviewArtifact JSON to a file")
  .option("--report", "persist this review to report history")
  .option("--no-report", "disable configured report history")
  .option("--report-dir <path>", "write report history under a custom directory")
  .option("--report-scope <scope>", "report storage scope: global or repo")
  .option("--report-mode <mode>", "report content mode: full or metadata")
  .action(
    async (options: {
      target?: string;
      reviewer: string[];
      reviewerSet?: string;
      model?: string;
      effort?: string;
      timeout?: string;
      strict?: boolean;
      failOnFindings?: string;
      verbose?: boolean;
      cwd: string;
      format: string;
      out?: string;
      report?: boolean;
      reportDir?: string;
      reportScope?: string;
      reportMode?: string;
    }) => {
      if (!options.target) {
        program.help();
        return;
      }

      await runReviewCli({
        ...options,
        target: options.target,
        format: parseReviewOutputFormat(options.format),
      });
    },
  );

const reviewCommand = program
  .command("review")
  .description("Run a review with a human-facing terminal display.")
  .option(
    "--target <target>",
    "review target, such as uncommitted, base:main, commit:abc123, or custom:Review auth",
  )
  .option(
    "--reviewer <spec>",
    "reviewer spec, such as fake, cursor, claude, pi, droid, codex, gemini, opencode, grok, antigravity, or pi:profile",
    collectReviewers,
    [],
  )
  .option("--reviewer-set <name>", "reviewer set name from config")
  .option("--model <id>", "model override for the selected reviewer")
  .option("--effort <level>", "effort override for the selected reviewer")
  .option("--timeout <seconds>", "reviewer timeout in seconds")
  .option("--strict", "fail if any reviewer fails")
  .option("--fail-on-findings <priority>", "exit 1 when findings include P0, P1, P2, or P3")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--out <path>", "write the full ReviewArtifact JSON to a file")
  .option("--report", "persist this review to report history")
  .option("--no-report", "disable configured report history")
  .option("--report-dir <path>", "write report history under a custom directory")
  .option("--report-scope <scope>", "report storage scope: global or repo")
  .option("--report-mode <mode>", "report content mode: full or metadata")
  .action(
    async (options: {
      target?: string;
      reviewer: string[];
      reviewerSet?: string;
      model?: string;
      effort?: string;
      timeout?: string;
      strict?: boolean;
      failOnFindings?: string;
      cwd: string;
      out?: string;
      report?: boolean;
      reportDir?: string;
      reportScope?: string;
      reportMode?: string;
    }) => {
      if (explicitGlobalOption<string>("format") !== undefined) {
        throw invalidCli("--format is not compatible with diffwarden review");
      }

      const resolvedOptions = resolveHumanReviewOptions(options);
      if (!resolvedOptions.target) {
        reviewCommand.help();
        return;
      }

      await runReviewCli({
        ...resolvedOptions,
        target: resolvedOptions.target,
        format: "human",
      });
    },
  );

program
  .command("init")
  .description("Create a starter user config file.")
  .action(async () => {
    const configPath = await initDiffwardenConfig();
    process.stdout.write(`Created ${configPath}\n`);
  });

program
  .command("doctor")
  .description("Resolve reviewers and run adapter preflight checks without reviewing a diff.")
  .option(
    "--reviewer <spec>",
    "reviewer spec, such as cursor, claude, pi, or a configured reviewer id",
    collectReviewers,
    [],
  )
  .option("--reviewer-set <name>", "reviewer set name from config")
  .option("--model <id>", "model override for the selected reviewer")
  .option("--effort <level>", "effort override for the selected reviewer")
  .option("--timeout <seconds>", "reviewer timeout in seconds")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--format <format>", "output format: markdown or json", "markdown")
  .action(
    async (options: {
      reviewer: string[];
      reviewerSet?: string;
      model?: string;
      effort?: string;
      timeout?: string;
      cwd: string;
      format: string;
    }) => {
      const resolvedOptions = resolveDoctorOptions(options);
      if (resolvedOptions.format !== "markdown" && resolvedOptions.format !== "json") {
        throw invalidCli(`Invalid --format value: ${resolvedOptions.format}`);
      }

      const loadedConfig = await loadDiffwardenConfig({ cwd: resolvedOptions.cwd });
      const cliTimeoutSeconds = parseTimeoutSeconds("--timeout", resolvedOptions.timeout);
      const envOptions = resolveReviewEnvOptionsWithSettings(process.env, {
        includeTimeout: cliTimeoutSeconds === undefined,
      });
      const reviewerOptions = resolveReviewerSelectionWithEnv({
        reviewers: resolvedOptions.reviewer,
        reviewerSet: resolvedOptions.reviewerSet,
        envOptions,
        allowEnvReviewerSelection: loadedConfig !== undefined,
      });
      const model = overrideSelection(resolvedOptions.model, envOptions.model);
      const effort = overrideSelection(resolvedOptions.effort, envOptions.effort);
      const report = await runReviewerPreflightReport({
        cwd: resolvedOptions.cwd,
        ...reviewerOptions,
        ...(model !== undefined ? { model: model.value, modelSource: model.source } : {}),
        ...(effort !== undefined ? { effort: effort.value, effortSource: effort.source } : {}),
        ...(cliTimeoutSeconds !== undefined
          ? { timeoutSeconds: cliTimeoutSeconds }
          : envOptions.timeoutSeconds !== undefined
            ? { timeoutSeconds: envOptions.timeoutSeconds }
            : {}),
        ...(loadedConfig !== undefined ? { config: loadedConfig.config } : {}),
      });

      process.stdout.write(
        resolvedOptions.format === "json"
          ? `${JSON.stringify(report, null, 2)}\n`
          : renderPreflightMarkdown(report),
      );

      if (report.reviewers.some((reviewer) => reviewer.status === "failed")) {
        process.exitCode = 1;
      }
    },
  );

const reviewers = program.command("reviewers").description("Inspect configured reviewers.");

reviewers
  .command("list")
  .description("List configured reviewers and reviewer sets without running preflight checks.")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--format <format>", "output format: markdown or json", "markdown")
  .action(async (options: { cwd: string; format: string }) => {
    const resolvedOptions = resolveReviewerListOptions(options);
    if (resolvedOptions.format !== "markdown" && resolvedOptions.format !== "json") {
      throw invalidCli(`Invalid --format value: ${resolvedOptions.format}`);
    }

    const loadedConfig = await loadDiffwardenConfig({ cwd: resolvedOptions.cwd });
    if (loadedConfig === undefined) {
      throw invalidConfig(
        "No diffwarden config found; run diffwarden init to create a config or pass --cwd to a configured repository",
      );
    }

    const summary = summarizeReviewers(loadedConfig);
    process.stdout.write(
      resolvedOptions.format === "json"
        ? `${JSON.stringify(summary, null, 2)}\n`
        : renderReviewerListMarkdown(summary),
    );
  });

const macos = program.command("macos").description("Inspect macOS executable trust state.");

macos
  .command("doctor")
  .description("Check quarantine, codesign, and Gatekeeper assessment for executables.")
  .option("--path <path>", "executable path to inspect", collectValues, [])
  .option(
    "--executable <name>",
    "executable name to resolve through PATH and inspect",
    collectValues,
    [],
  )
  .option("--json", "output machine-readable JSON")
  .action(async (options: { path: string[]; executable: string[]; json?: boolean }) => {
    if (options.path.length === 0 && options.executable.length === 0) {
      throw invalidCli("Pass at least one --path or --executable value");
    }

    const report = await runMacosDoctor({
      paths: options.path,
      executables: options.executable,
      env: process.env,
    });

    process.stdout.write(
      options.json === true
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderMacosDoctorMarkdown(report),
    );

    if (report.executables.some((executable) => executable.status === "failed")) {
      process.exitCode = 1;
    }
  });

try {
  await program.parseAsync(normalizeArgv(process.argv));
} catch (error) {
  if (error instanceof Error) {
    const exitCode = "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
    process.stderr.write(`${error.message}\n`);
    process.exit(exitCode);
  }

  process.stderr.write("Unknown error\n");
  process.exit(1);
}

async function runReviewCli(options: ReviewCliOptions): Promise<void> {
  if (options.verbose === true && options.format !== "markdown") {
    throw invalidCli("--verbose is only compatible with --format markdown");
  }

  const failOnFindings =
    options.failOnFindings === undefined
      ? undefined
      : parseFindingFailureThreshold(options.failOnFindings);
  const targetSpec = parseTargetSpec(options.target);
  const resolved = await resolveGitTarget(options.cwd, targetSpec);
  const loadedConfig = await loadDiffwardenConfig({
    cwd: options.cwd,
    repoRoot: resolved.target.repo_root,
  });
  const cliTimeoutSeconds = parseTimeoutSeconds("--timeout", options.timeout);
  const envOptions = resolveReviewEnvOptionsWithSettings(process.env, {
    includeTimeout: cliTimeoutSeconds === undefined,
  });
  const reviewerOptions = resolveReviewerSelectionWithEnv({
    reviewers: options.reviewer,
    reviewerSet: options.reviewerSet,
    envOptions,
    allowEnvReviewerSelection: loadedConfig !== undefined,
  });
  const provenanceReviewerSet =
    reviewerOptions.reviewerSet ??
    (reviewerOptions.reviewers === undefined ? loadedConfig?.config.defaultReviewerSet : undefined);
  const model = overrideSelection(options.model, envOptions.model);
  const effort = overrideSelection(options.effort, envOptions.effort);
  const timeoutSeconds = cliTimeoutSeconds ?? envOptions.timeoutSeconds;
  const reportingOptions = resolveReportingOptions({
    cwd: options.cwd,
    repoRoot: resolved.target.repo_root,
    cli: {
      ...(options.report !== undefined ? { report: options.report } : {}),
      ...(options.reportDir !== undefined ? { reportDir: options.reportDir } : {}),
      ...(options.reportScope !== undefined ? { reportScope: options.reportScope } : {}),
      ...(options.reportMode !== undefined ? { reportMode: options.reportMode } : {}),
    },
    ...(loadedConfig !== undefined ? { config: loadedConfig.config } : {}),
  });
  const ndjson = options.format === "ndjson";
  const human = options.format === "human";
  const showProgress = !ndjson && !human && process.stderr.isTTY === true;
  const humanColor = human
    ? shouldUseHumanColor({ env: process.env, stream: process.stdout })
    : false;
  const events = runReviewEvents({
    cwd: options.cwd,
    resolved,
    ...reviewerOptions,
    ...(model !== undefined ? { model: model.value, modelSource: model.source } : {}),
    ...(effort !== undefined ? { effort: effort.value, effortSource: effort.source } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(options.strict === true ? { strict: true } : {}),
    ...(loadedConfig !== undefined ? { config: loadedConfig.config } : {}),
  });

  let artifact: ReviewArtifact | undefined;
  let terminalError: ReviewerError | undefined;
  let next = await events.next();
  while (next.done !== true) {
    const reviewEvent = next.value;
    if (ndjson) {
      process.stdout.write(`${JSON.stringify(reviewEvent)}\n`);
    } else if (human) {
      writeHumanBlock(renderHumanReviewEvent(reviewEvent, { color: humanColor }));
    } else if (showProgress) {
      const line = formatReviewProgressLine(reviewEvent);
      if (line !== undefined) {
        process.stderr.write(`${line}\n`);
      }
    }
    if (reviewEvent.type === "final_result") {
      artifact = reviewEvent.artifact;
    } else if (reviewEvent.type === "error") {
      terminalError = reviewEvent.error;
    }
    next = await events.next();
  }

  if (terminalError !== undefined) {
    // The terminal `error` frame already conveyed the failure. In NDJSON mode we
    // set the exit code without throwing so the stream stays a clean sequence of
    // frames; otherwise we throw to reuse the standard stderr error path.
    if (ndjson) {
      process.exitCode = terminalError.exit_code ?? 3;
      return;
    }
    throw new DiffwardenError(
      terminalError.code as ReviewErrorCode,
      terminalError.message,
      terminalError.exit_code ?? 3,
    );
  }

  if (artifact === undefined) {
    throw reviewerFailed("Review produced no result");
  }

  if (options.out) {
    await writeFile(options.out, renderJson(artifact));
  }

  if (human) {
    process.stdout.write(renderHumanReviewSummary(artifact, { color: humanColor }));
  } else if (!ndjson) {
    process.stdout.write(
      options.format === "json"
        ? renderJson(artifact)
        : renderMarkdown(artifact, { verbose: options.verbose === true }),
    );
  }

  const provenanceFormat: ReviewReportOutputFormat = options.format;
  await writeReviewReport({
    artifact,
    reporting: reportingOptions,
    provenance: {
      diffwardenVersion: version,
      targetSpec: options.target,
      ...reviewerOptions,
      ...(provenanceReviewerSet !== undefined ? { reviewerSet: provenanceReviewerSet } : {}),
      ...(model !== undefined ? { model: model.value } : {}),
      ...(effort !== undefined ? { effort: effort.value } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      strict: options.strict === true,
      ...(options.failOnFindings !== undefined ? { failOnFindings: options.failOnFindings } : {}),
      format: provenanceFormat,
      ...(loadedConfig !== undefined
        ? { config: { path: loadedConfig.path, sha256: loadedConfig.sha256 } }
        : {}),
      diff: resolved.diff,
    },
  });

  if (
    failOnFindings !== undefined &&
    hasFindingAtOrAbovePriority(artifact.result, failOnFindings)
  ) {
    process.exitCode = 1;
  }
}

function parseReviewOutputFormat(value: string): ReviewOutputFormat {
  if (value === "markdown" || value === "json" || value === "ndjson") {
    return value;
  }
  throw invalidCli(`Invalid --format value: ${value}`);
}

function writeHumanBlock(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

function formatReviewProgressLine(reviewEvent: ReviewEvent): string | undefined {
  switch (reviewEvent.type) {
    case "run_started":
      return `diffwarden: reviewing with ${reviewEvent.reviewers
        .map((reviewer) => reviewer.id)
        .join(", ")}`;
    case "reviewer_started":
      return `  … ${reviewEvent.reviewer_id} running`;
    case "reviewer_result":
      return `  ✓ ${reviewEvent.reviewer_id} finished${formatProgressTiming(
        reviewEvent.artifact.timing_ms,
      )}`;
    case "reviewer_failed":
      return `  ✗ ${reviewEvent.reviewer_id} failed: ${reviewEvent.error.message}`;
    case "final_result": {
      const count = reviewEvent.artifact.result.findings.length;
      return `diffwarden: aggregated ${count} finding${count === 1 ? "" : "s"}`;
    }
    default:
      // preflight_started/preflight_finished are kept quiet to limit noise;
      // `error` is surfaced by the top-level stderr error handler.
      return undefined;
  }
}

function formatProgressTiming(timingMs: number | undefined): string {
  return timingMs === undefined ? "" : ` (${(timingMs / 1000).toFixed(1)}s)`;
}

function renderPreflightMarkdown(report: ReviewerPreflightReport): string {
  const lines = ["# Diffwarden Doctor", "", `CWD: ${report.cwd}`, ""];

  for (const reviewer of report.reviewers) {
    lines.push(`## ${reviewer.id}`, "");
    lines.push(`- Engine: ${reviewer.engine}`);
    lines.push(`- Status: ${reviewer.status}`);
    if (reviewer.model !== undefined) {
      lines.push(`- Model: ${reviewer.model}`);
    }
    if (reviewer.effort !== undefined) {
      lines.push(`- Effort: ${reviewer.effort}`);
    }

    if (reviewer.error !== undefined) {
      lines.push(`- Error: ${reviewer.error.message}`);
    }

    const checks = reviewer.preflight?.checks ?? [];
    if (checks.length > 0) {
      lines.push("", "| Check | Status | Detail |");
      lines.push("| --- | --- | --- |");
      for (const check of checks) {
        lines.push(
          `| ${escapeMarkdownTable(check.name)} | ${check.status} | ${escapeMarkdownTable(
            check.detail ?? "",
          )} |`,
        );
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderMacosDoctorMarkdown(report: MacosDoctorReport): string {
  const lines = ["# Diffwarden macOS Doctor", "", `Platform: ${report.platform}`, ""];

  for (const executable of report.executables) {
    lines.push(`## ${executable.input}`, "");
    lines.push(`- Status: ${executable.status}`);
    if (executable.path !== undefined) {
      lines.push(`- Path: ${executable.path}`);
    }

    if (executable.checks.length > 0) {
      lines.push("", "| Check | Status | Detail |");
      lines.push("| --- | --- | --- |");
      for (const check of executable.checks) {
        lines.push(
          `| ${escapeMarkdownTable(check.name)} | ${check.status} | ${escapeMarkdownTable(
            check.detail ?? "",
          )} |`,
        );
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function summarizeReviewers(loadedConfig: LoadedDiffwardenConfig): ReviewerListSummary {
  return {
    schema_version: 2,
    config: {
      path: loadedConfig.path,
      sha256: loadedConfig.sha256,
    },
    ...(loadedConfig.config.defaultReviewerSet !== undefined
      ? { defaultReviewerSet: loadedConfig.config.defaultReviewerSet }
      : {}),
    reviewerSets: loadedConfig.config.reviewerSets ?? {},
    reviewers: (loadedConfig.config.reviewers ?? []).map((reviewer) => {
      const transport = reviewer.transport ?? defaultReviewerTransport(reviewer.sdk) ?? "sdk";
      const model = reviewer.model ?? defaultReviewerModel(reviewer.sdk);

      return {
        id: reviewer.id,
        engine: reviewer.sdk,
        enabled: reviewer.enabled !== false,
        ...(reviewer.profile !== undefined ? { profile: reviewer.profile } : {}),
        transport: publicTransport(transport),
        ...(reviewer.provider !== undefined ? { provider: reviewer.provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
      };
    }),
  };
}

function renderReviewerListMarkdown(summary: ReviewerListSummary): string {
  const lines = [
    "# Diffwarden Reviewers",
    "",
    `Config: ${summary.config.path}`,
    `Default reviewer set: ${summary.defaultReviewerSet ?? "(none)"}`,
    "",
    "## Reviewer Sets",
    "",
  ];

  const reviewerSetEntries = Object.entries(summary.reviewerSets);
  if (reviewerSetEntries.length === 0) {
    lines.push("_None configured._", "");
  } else {
    lines.push("| Set | Reviewers | Default |");
    lines.push("| --- | --- | --- |");
    for (const [name, reviewers] of reviewerSetEntries) {
      lines.push(
        `| ${escapeMarkdownTable(name)} | ${escapeMarkdownTable(reviewers.join(", "))} | ${
          name === summary.defaultReviewerSet ? "yes" : "no"
        } |`,
      );
    }
    lines.push("");
  }

  lines.push("## Reviewers", "");
  if (summary.reviewers.length === 0) {
    lines.push("_None configured._", "");
  } else {
    lines.push("| ID | Engine | Enabled | Profile | Transport | Provider | Model | Effort |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const reviewer of summary.reviewers) {
      const row = [
        reviewer.id,
        reviewer.engine,
        reviewer.enabled ? "yes" : "no",
        reviewer.profile ?? "",
        reviewer.transport,
        reviewer.provider ?? "",
        reviewer.model ?? "",
        reviewer.effort ?? "",
      ]
        .map(escapeMarkdownTable)
        .join(" | ");
      lines.push(`| ${row} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function publicTransport(transport: "sdk" | "cli" | "app-server"): "native" | "cli" | "app-server" {
  return transport === "sdk" ? "native" : transport;
}

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function resolveReviewerListOptions(options: { cwd: string; format: string }): {
  cwd: string;
  format: string;
} {
  const globalOptions = program.opts<{
    cwd?: string;
  }>();
  const globalFormat = explicitGlobalOption<string>("format");

  return {
    cwd: globalOptions.cwd ?? options.cwd,
    format: globalFormat ?? options.format,
  };
}

function resolveDoctorOptions(options: {
  reviewer: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  cwd: string;
  format: string;
}): {
  reviewer: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  cwd: string;
  format: string;
} {
  const globalOptions = program.opts<{
    reviewer?: string[];
    reviewerSet?: string;
    model?: string;
    effort?: string;
    timeout?: string;
    cwd?: string;
  }>();
  const globalFormat = explicitGlobalOption<string>("format");

  return {
    reviewer:
      options.reviewer.length > 0 ? options.reviewer : (globalOptions.reviewer ?? options.reviewer),
    ...(options.reviewerSet !== undefined
      ? { reviewerSet: options.reviewerSet }
      : globalOptions.reviewerSet !== undefined
        ? { reviewerSet: globalOptions.reviewerSet }
        : {}),
    ...(options.model !== undefined
      ? { model: options.model }
      : globalOptions.model !== undefined
        ? { model: globalOptions.model }
        : {}),
    ...(options.effort !== undefined
      ? { effort: options.effort }
      : globalOptions.effort !== undefined
        ? { effort: globalOptions.effort }
        : {}),
    ...(options.timeout !== undefined
      ? { timeout: options.timeout }
      : globalOptions.timeout !== undefined
        ? { timeout: globalOptions.timeout }
        : {}),
    cwd: globalOptions.cwd ?? options.cwd,
    format: globalFormat ?? options.format,
  };
}

function resolveHumanReviewOptions(options: {
  target?: string;
  reviewer: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  strict?: boolean;
  failOnFindings?: string;
  cwd: string;
  out?: string;
  report?: boolean;
  reportDir?: string;
  reportScope?: string;
  reportMode?: string;
}): Omit<ReviewCliOptions, "format" | "target"> & { target?: string } {
  const globalOptions = program.opts<{
    reviewer?: string[];
    reviewerSet?: string;
    model?: string;
    effort?: string;
    timeout?: string;
    target?: string;
    cwd?: string;
    strict?: boolean;
    failOnFindings?: string;
    out?: string;
    report?: boolean;
    reportDir?: string;
    reportScope?: string;
    reportMode?: string;
  }>();
  const globalReport = explicitGlobalOption<boolean>("report");

  return {
    reviewer:
      options.reviewer.length > 0 ? options.reviewer : (globalOptions.reviewer ?? options.reviewer),
    ...(options.reviewerSet !== undefined
      ? { reviewerSet: options.reviewerSet }
      : globalOptions.reviewerSet !== undefined
        ? { reviewerSet: globalOptions.reviewerSet }
        : {}),
    ...(options.model !== undefined
      ? { model: options.model }
      : globalOptions.model !== undefined
        ? { model: globalOptions.model }
        : {}),
    ...(options.effort !== undefined
      ? { effort: options.effort }
      : globalOptions.effort !== undefined
        ? { effort: globalOptions.effort }
        : {}),
    ...(options.timeout !== undefined
      ? { timeout: options.timeout }
      : globalOptions.timeout !== undefined
        ? { timeout: globalOptions.timeout }
        : {}),
    ...(options.target !== undefined
      ? { target: options.target }
      : globalOptions.target !== undefined
        ? { target: globalOptions.target }
        : {}),
    cwd: globalOptions.cwd ?? options.cwd,
    ...(options.strict !== undefined
      ? { strict: options.strict }
      : globalOptions.strict !== undefined
        ? { strict: globalOptions.strict }
        : {}),
    ...(options.failOnFindings !== undefined
      ? { failOnFindings: options.failOnFindings }
      : globalOptions.failOnFindings !== undefined
        ? { failOnFindings: globalOptions.failOnFindings }
        : {}),
    ...(options.out !== undefined
      ? { out: options.out }
      : globalOptions.out !== undefined
        ? { out: globalOptions.out }
        : {}),
    ...(options.report !== undefined
      ? { report: options.report }
      : globalReport !== undefined
        ? { report: globalReport }
        : {}),
    ...(options.reportDir !== undefined
      ? { reportDir: options.reportDir }
      : globalOptions.reportDir !== undefined
        ? { reportDir: globalOptions.reportDir }
        : {}),
    ...(options.reportScope !== undefined
      ? { reportScope: options.reportScope }
      : globalOptions.reportScope !== undefined
        ? { reportScope: globalOptions.reportScope }
        : {}),
    ...(options.reportMode !== undefined
      ? { reportMode: options.reportMode }
      : globalOptions.reportMode !== undefined
        ? { reportMode: globalOptions.reportMode }
        : {}),
  };
}

function explicitGlobalOption<T>(name: string): T | undefined {
  return program.getOptionValueSource(name) === "default"
    ? undefined
    : (program.getOptionValue(name) as T | undefined);
}

function overrideSelection(
  cliValue: string | undefined,
  envValue: string | undefined,
): OverrideSelection | undefined {
  if (cliValue !== undefined) {
    return { value: cliValue, source: "requested" };
  }
  if (envValue !== undefined) {
    return { value: envValue, source: "env" };
  }
  return undefined;
}

function normalizeArgv(argv: string[]): string[] {
  if (argv[2] !== "--") {
    return argv;
  }

  return [argv[0] ?? "node", argv[1] ?? "diffwarden", ...argv.slice(3)];
}
