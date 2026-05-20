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
import { runReview } from "./core/runner.js";
import { parseTargetSpec } from "./core/target.js";

const program = new Command();
const collectReviewers = (value: string, previous: string[]): string[] => [...previous, value];

program
  .name("diffwarden")
  .description("A small CLI for agent-callable code review.")
  .version("0.0.0")
  .option("--target <target>", "review target, such as uncommitted, base:main, or commit:abc123")
  .option(
    "--reviewer <spec>",
    "reviewer spec, such as fake, cursor, claude, pi, or pi:profile",
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

function normalizeArgv(argv: string[]): string[] {
  if (argv[2] !== "--") {
    return argv;
  }

  return [argv[0] ?? "node", argv[1] ?? "diffwarden", ...argv.slice(3)];
}
