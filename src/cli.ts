#!/usr/bin/env node
import { Command } from "commander";
import { invalidCli } from "./core/errors.js";

const program = new Command();

program
  .name("diffwarden")
  .description("A small CLI for agent-callable code review.")
  .version("0.0.0")
  .option("--target <target>", "review target, such as uncommitted, base:main, or commit:abc123")
  .option("--reviewer <spec>", "reviewer spec; repeat support is planned")
  .option("--format <format>", "output format: markdown or json", "markdown")
  .option("--out <path>", "write the full ReviewArtifact JSON to a file")
  .action((options: { target?: string; format: string }) => {
    if (options.format !== "markdown" && options.format !== "json") {
      throw invalidCli(`Invalid --format value: ${options.format}`);
    }

    if (!options.target) {
      program.help();
    }

    throw invalidCli("Review execution is not implemented yet. Scaffold is ready.");
  });

try {
  program.parse();
} catch (error) {
  if (error instanceof Error) {
    const exitCode = "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
    process.stderr.write(`${error.message}\n`);
    process.exit(exitCode);
  }

  process.stderr.write("Unknown error\n");
  process.exit(1);
}
