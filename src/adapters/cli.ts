import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalidCli } from "../core/errors.js";
import {
  claudeCliEffort,
  cliCapability,
  cliExecutableMetadata,
  cliExecutableSelection,
  droidCliEffort,
  grokCliEffort,
  providerQualifiedModel,
} from "./cli-helpers.js";
import { resolveExecutable, runCli, trimForMetadata } from "./cli-process.js";
import { cliSpecs } from "./cli-specs.js";
import type { CliEngine } from "./cli-types.js";
import { codexCliWebSearchPolicy, codexWebSearchMetadata } from "./codex-options.js";
import {
  type ResolutionSource,
  effortResolutionMetadata,
  mergeResolutionMetadataRecords,
  modelResolutionMetadata,
} from "./metadata.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerConfig,
} from "./types.js";

type CliRunContext = {
  kind: "cli";
  requestedExecutable: string;
  resolvedExecutable: string;
  path?: string;
};

export function createCliAdapter(engine: CliEngine): ReviewAdapter {
  const spec = cliSpecs[engine];
  const capability = cliCapability(engine);
  return {
    name: `${engine}:cli`,
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      return prepareCliAdapter(engine, capability, input).then((prepared) => prepared.preflight);
    },
    async prepare(input: ReviewAdapterPreflightInput) {
      return prepareCliAdapter(engine, capability, input);
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      validateSupportedCliOverrides(engine, input.reviewer);
      const tempDir = await mkdtemp(path.join(tmpdir(), "diffwarden-cli-"));
      try {
        const invocation = await spec.buildInvocation(input, tempDir);
        const executableSelection = cliExecutableSelection(
          input.reviewer,
          capability.defaultExecutable,
        );
        const runContext = cliRunContext(input.runContext);
        if (canUsePreparedExecutable(invocation.executable, input, runContext)) {
          invocation.resolvedExecutable = runContext.resolvedExecutable;
        }
        const result = await runCli(invocation, input);
        const output = await spec.parseOutput(result, invocation);
        output.metadata = mergeResolutionMetadataRecords(
          cliSelectionMetadata(engine, input.reviewer),
          output.metadata,
          {
            transport: "cli",
            ...cliExecutableMetadata(executableSelection, result.executable),
            stderr: trimForMetadata(result.stderr),
          },
        );
        return output;
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  };
}

async function prepareCliAdapter(
  engine: CliEngine,
  capability: ReturnType<typeof cliCapability>,
  input: ReviewAdapterPreflightInput,
): Promise<{ preflight: ReviewAdapterPreflightResult; runContext: CliRunContext }> {
  validateSupportedCliOverrides(engine, input.reviewer);
  const executableSelection = cliExecutableSelection(input.reviewer, capability.defaultExecutable);
  const resolvedExecutable = await resolveExecutable(executableSelection.executable, input.env);
  const metadata: ReviewAdapterPreflightResult["metadata"] = {
    readonlyCapability: capability.readonlyCapability,
    transport: "cli",
    ...cliExecutableMetadata(executableSelection, resolvedExecutable),
    ...cliSelectionMetadata(engine, input.reviewer),
  };

  return {
    preflight: {
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
    },
    runContext: {
      kind: "cli",
      requestedExecutable: executableSelection.executable,
      resolvedExecutable,
      ...pathContext(input.env),
    },
  };
}

function cliRunContext(value: unknown): CliRunContext | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "cli" ||
    !("requestedExecutable" in value) ||
    typeof value.requestedExecutable !== "string" ||
    !("resolvedExecutable" in value) ||
    typeof value.resolvedExecutable !== "string"
  ) {
    return undefined;
  }

  return value as CliRunContext;
}

function canUsePreparedExecutable(
  executable: string,
  input: ReviewAdapterInput,
  runContext: CliRunContext | undefined,
): runContext is CliRunContext {
  return (
    runContext !== undefined &&
    runContext.requestedExecutable === executable &&
    runContext.path === pathContext(input.env).path
  );
}

function pathContext(env: NodeJS.ProcessEnv | undefined): { path?: string } {
  const value = (env ?? process.env).PATH;
  return value === undefined ? {} : { path: value };
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

function cliSelectionMetadata(
  engine: CliEngine,
  reviewer: ReviewReviewerConfig,
): Record<string, string> {
  const model = providerQualifiedModel(reviewer);
  const effort = cliEffortResolution(engine, reviewer);

  return {
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(model !== undefined
      ? modelResolutionMetadata({
          requested: model,
          resolved: model,
          source: reviewer.modelSource ?? "requested",
        })
      : {}),
    ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
    ...(effort !== undefined
      ? effortResolutionMetadata({
          requested: reviewer.effort,
          resolved: effort.resolved,
          source: effort.source,
        })
      : {}),
    ...(engine === "codex" ? codexWebSearchMetadata(codexCliWebSearchPolicy(reviewer)) : {}),
  };
}

function cliEffortResolution(
  engine: CliEngine,
  reviewer: ReviewReviewerConfig,
): { resolved?: string; source: ResolutionSource } | undefined {
  const effort = reviewer.effort;
  if (effort === undefined) {
    return undefined;
  }

  if (effort === "off" && cliOmitsOffEffort(engine)) {
    return {
      source: "adapter-selection",
    };
  }

  const resolved = cliResolvedEffort(engine, effort);
  return {
    resolved,
    source: resolved === effort ? (reviewer.effortSource ?? "requested") : "adapter-selection",
  };
}

function cliOmitsOffEffort(engine: CliEngine): boolean {
  return ["claude", "codex", "droid", "grok", "opencode"].includes(engine);
}

function cliResolvedEffort(engine: CliEngine, effort: string): string {
  if (engine === "claude") {
    return effort === "off" ? "off" : claudeCliEffort(effort);
  }
  if (engine === "droid") {
    return effort === "off" ? "off" : droidCliEffort(effort);
  }
  if (engine === "grok") {
    return effort === "off" ? "off" : grokCliEffort(effort);
  }
  return effort;
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
