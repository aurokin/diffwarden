#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { initDiffwardenConfig, loadDiffwardenConfig } from "./core/config.js";
import {
  parseTimeoutSeconds,
  resolveReviewEnvOptionsWithSettings,
  resolveReviewerSelectionWithEnv,
} from "./core/env.js";
import { invalidCli } from "./core/errors.js";
import { resolveGitTarget } from "./core/git.js";
import { renderJson, renderMarkdown } from "./core/render.js";
import {
  type ReviewerPreflightReport,
  runReview,
  runReviewerPreflightReport,
} from "./core/runner.js";
import { parseTargetSpec } from "./core/target.js";
import { version } from "./version.js";

const program = new Command();
const collectReviewers = (value: string, previous: string[]): string[] => [...previous, value];

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
  .option("--verbose", "include per-reviewer details in Markdown output")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--format <format>", "output format: markdown or json", "markdown")
  .option("--out <path>", "write the full ReviewArtifact JSON to a file")
  .action(
    async (options: {
      target?: string;
      reviewer: string[];
      reviewerSet?: string;
      model?: string;
      effort?: string;
      timeout?: string;
      strict?: boolean;
      verbose?: boolean;
      cwd: string;
      format: string;
      out?: string;
    }) => {
      if (options.format !== "markdown" && options.format !== "json") {
        throw invalidCli(`Invalid --format value: ${options.format}`);
      }

      if (!options.target) {
        program.help();
        return;
      }

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
      const artifact = await runReview({
        cwd: options.cwd,
        resolved,
        ...reviewerOptions,
        ...(options.model !== undefined
          ? { model: options.model }
          : envOptions.model !== undefined
            ? { model: envOptions.model }
            : {}),
        ...(options.effort !== undefined
          ? { effort: options.effort }
          : envOptions.effort !== undefined
            ? { effort: envOptions.effort }
            : {}),
        ...(cliTimeoutSeconds !== undefined
          ? { timeoutSeconds: cliTimeoutSeconds }
          : envOptions.timeoutSeconds !== undefined
            ? { timeoutSeconds: envOptions.timeoutSeconds }
            : {}),
        ...(options.strict === true ? { strict: true } : {}),
        ...(loadedConfig !== undefined ? { config: loadedConfig.config } : {}),
      });

      if (options.out) {
        await writeFile(options.out, renderJson(artifact));
      }

      process.stdout.write(
        options.format === "json"
          ? renderJson(artifact)
          : renderMarkdown(artifact, { verbose: options.verbose === true }),
      );
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
      const report = await runReviewerPreflightReport({
        cwd: resolvedOptions.cwd,
        ...reviewerOptions,
        ...(resolvedOptions.model !== undefined
          ? { model: resolvedOptions.model }
          : envOptions.model !== undefined
            ? { model: envOptions.model }
            : {}),
        ...(resolvedOptions.effort !== undefined
          ? { effort: resolvedOptions.effort }
          : envOptions.effort !== undefined
            ? { effort: envOptions.effort }
            : {}),
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

function renderPreflightMarkdown(report: ReviewerPreflightReport): string {
  const lines = ["# Diffwarden Doctor", "", `CWD: ${report.cwd}`, ""];

  for (const reviewer of report.reviewers) {
    lines.push(`## ${reviewer.id}`, "");
    lines.push(`- Engine: ${reviewer.sdk}`);
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

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
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
    format?: string;
  }>();

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
    format: globalOptions.format ?? options.format,
  };
}

function normalizeArgv(argv: string[]): string[] {
  if (argv[2] !== "--") {
    return argv;
  }

  return [argv[0] ?? "node", argv[1] ?? "diffwarden", ...argv.slice(3)];
}
