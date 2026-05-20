#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { invalidCli } from "./core/errors.js";
import { resolveGitTarget } from "./core/git.js";
import { renderJson, renderMarkdown } from "./core/render.js";
import { runReview } from "./core/runner.js";
import { parseTargetSpec } from "./core/target.js";

const program = new Command();

program
  .name("diffwarden")
  .description("A small CLI for agent-callable code review.")
  .version("0.0.0")
  .option("--target <target>", "review target, such as uncommitted, base:main, or commit:abc123")
  .option("--reviewer <spec>", "reviewer spec, such as fake, cursor, claude, or pi", "fake")
  .option("--model <id>", "model override for the selected reviewer")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--format <format>", "output format: markdown or json", "markdown")
  .option("--out <path>", "write the full ReviewArtifact JSON to a file")
  .action(
    async (options: {
      target?: string;
      reviewer: string;
      model?: string;
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
      const artifact = await runReview({
        cwd: options.cwd,
        resolved,
        reviewer: options.reviewer,
        ...(options.model ? { model: options.model } : {}),
      });

      if (options.out) {
        await writeFile(options.out, renderJson(artifact));
      }

      process.stdout.write(
        options.format === "json" ? renderJson(artifact) : renderMarkdown(artifact),
      );
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

function normalizeArgv(argv: string[]): string[] {
  if (argv[2] !== "--") {
    return argv;
  }

  return [argv[0] ?? "node", argv[1] ?? "diffwarden", ...argv.slice(3)];
}
