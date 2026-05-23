import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalidCli } from "../core/errors.js";
import { cliCapability, cliExecutable } from "./cli-helpers.js";
import { resolveExecutable, runCli, trimForMetadata } from "./cli-process.js";
import { cliSpecs } from "./cli-specs.js";
import type { CliEngine } from "./cli-types.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerConfig,
} from "./types.js";

export function createCliAdapter(engine: CliEngine): ReviewAdapter {
  const spec = cliSpecs[engine];
  const capability = cliCapability(engine);
  return {
    name: `${engine}:cli`,
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      validateSupportedCliOverrides(engine, input.reviewer);
      const executable = cliExecutable(input.reviewer, capability.defaultExecutable);
      const resolvedExecutable = await resolveExecutable(executable, input.env);
      const metadata: ReviewAdapterPreflightResult["metadata"] = {
        readonlyCapability: capability.readonlyCapability,
        transport: "cli",
        executable: resolvedExecutable,
        ...(input.reviewer.model !== undefined ? { model: input.reviewer.model } : {}),
        ...(input.reviewer.effort !== undefined ? { effort: input.reviewer.effort } : {}),
      };

      return {
        checks: [
          {
            name: "executable",
            status: "passed",
            detail: `Using ${resolvedExecutable}.`,
          },
          {
            name: "readonly",
            status: capability.readonlyCapability === "prompt-only" ? "warning" : "passed",
            detail: readonlyDetail(capability.readonlyCapability),
          },
          {
            name: "auth",
            status: "skipped",
            detail: "CLI authentication is delegated to the selected executable.",
          },
          {
            name: "model",
            status: input.reviewer.model === undefined ? "skipped" : "passed",
            detail:
              input.reviewer.model === undefined
                ? "No model override was requested."
                : `Passing model override to CLI: ${input.reviewer.model}.`,
          },
          {
            name: "effort",
            status: input.reviewer.effort === undefined ? "skipped" : "passed",
            detail:
              input.reviewer.effort === undefined
                ? "No effort override was requested."
                : `Passing effort override to CLI: ${input.reviewer.effort}.`,
          },
        ],
        metadata,
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      validateSupportedCliOverrides(engine, input.reviewer);
      const tempDir = await mkdtemp(path.join(tmpdir(), "diffwarden-cli-"));
      try {
        const invocation = await spec.buildInvocation(input, tempDir);
        const result = await runCli(invocation, input);
        const output = await spec.parseOutput(result, invocation);
        output.metadata = {
          ...output.metadata,
          transport: "cli",
          executable: result.executable,
          stderr: trimForMetadata(result.stderr),
        };
        return output;
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  };
}

function validateSupportedCliOverrides(engine: CliEngine, reviewer: ReviewReviewerConfig): void {
  const capability = cliCapability(engine);
  if (!capability.supportsModel && reviewer.model !== undefined) {
    throw invalidCli(`${engine} CLI transport does not support per-run model overrides`);
  }
  if (!capability.supportsEffort && reviewer.effort !== undefined) {
    throw invalidCli(`${engine} CLI transport does not support per-run effort overrides`);
  }
}

function readonlyDetail(
  capability: NonNullable<ReviewAdapterOutput["metadata"]>["readonlyCapability"],
): string {
  if (capability === "enforced") {
    return "CLI invocation includes an engine-level read-only sandbox.";
  }
  if (capability === "tool-restricted") {
    return "CLI invocation restricts available tools to read-oriented review operations.";
  }
  return "CLI invocation uses the most restrictive documented mode, but read-only behavior is prompt-dependent.";
}
