#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  type ReviewerSdk,
  defaultReviewerModel,
  defaultReviewerTransport,
  getTransportCapability,
  isReviewerSdk,
  validateReviewerCapabilityOverrides,
} from "./adapters/capabilities.js";
import {
  type DiffwardenConfig,
  type EditReviewerPatch,
  type LoadedDiffwardenConfig,
  type PublicReviewerEntry,
  addReviewerToSetInUserConfig,
  addReviewerToUserConfig,
  createDiscoveredUserConfig,
  editReviewerInUserConfig,
  initDiffwardenConfig,
  loadDiffwardenConfig,
  removeReviewerFromSetInUserConfig,
  removeReviewerFromUserConfig,
  userConfigPath,
} from "./core/config.js";
import {
  type ReviewerCandidateRecommendation,
  type ReviewerDeepPreflightTarget,
  type ReviewerDiscoveryCandidate,
  discoverReviewers,
  recommendReviewerEntry,
  renderReviewerDiscoveryText,
} from "./core/discovery.js";
import {
  parseTimeoutSeconds,
  resolveReviewEnvOptionsWithSettings,
  resolveReviewerSelectionWithEnv,
} from "./core/env.js";
import { DiffwardenError, invalidCli, invalidConfig, reviewerFailed } from "./core/errors.js";
import { hasFindingAtOrAbovePriority, parseFindingFailureThreshold } from "./core/finding-gate.js";
import { resolveGitTarget } from "./core/git.js";
import {
  renderAgentReviewSummary,
  renderHumanReviewArtifact,
  renderHumanReviewEvent,
  renderHumanReviewSummary,
  shouldUseHumanColor,
} from "./core/human-render.js";
import {
  type Prompter,
  confirmScaffold,
  confirmWriteEntry,
  createReadlinePrompter,
  isInteractiveAvailable,
  promptSelectReviewerEntry,
  selectScaffoldReviewers,
} from "./core/interactive.js";
import { type MacosDoctorReport, runMacosDoctor } from "./core/macos.js";
import { renderJson } from "./core/render.js";
import {
  type ReviewReportOutputFormat,
  resolveReportingOptions,
  writeReviewReport,
} from "./core/reporting.js";
import type { ReviewerOverrideSource } from "./core/reviewer.js";
import {
  type ReviewerPreflightReport,
  diffwardenErrorFromReviewerError,
  runReviewBatchEvents,
  runReviewEvents,
  runReviewerPreflightReport,
} from "./core/runner.js";
import {
  type ReviewEvent,
  type ReviewPlan,
  type ReviewRunArtifact,
  type ReviewerError,
  reviewRunArtifactSchema,
} from "./core/schema.js";
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

type ReviewOutputMode = "human" | "agent" | "json" | "ndjson";
type ReviewShowOutputMode = Exclude<ReviewOutputMode, "ndjson">;

type ReviewCliOptions = {
  target: string;
  reviewer: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeout?: string;
  strict?: boolean;
  failOnFindings?: string;
  focus: string[];
  overview?: boolean;
  overviewConflict?: boolean;
  cwd: string;
  mode: ReviewOutputMode;
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
  .showHelpAfterError()
  .action(() => {
    program.help();
  });

const reviewCommand = program
  .command("review")
  .description("Run a code review.")
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
  .option("--focus <text>", "add a focused diff-backed review lane", collectValues, [])
  .option("--overview", "include the normal overview lane when focus lanes are present")
  .option("--no-overview", "suppress the normal overview lane when focus lanes are present")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--agent", "emit plain text optimized for coding agents")
  .option("--json", "emit the final review artifact JSON")
  .option("--ndjson", "emit newline-delimited review events")
  .option("--out <path>", "write the full review artifact JSON to a file")
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
      focus: string[];
      overview?: boolean;
      cwd: string;
      agent?: boolean;
      json?: boolean;
      ndjson?: boolean;
      out?: string;
      report?: boolean;
      reportDir?: string;
      reportScope?: string;
      reportMode?: string;
    }) => {
      if (!options.target) {
        reviewCommand.help();
        return;
      }

      await runReviewCli({
        ...options,
        target: options.target,
        mode: resolveReviewOutputMode(options),
        overviewConflict: hasBothOverviewFlags(process.argv),
      });
    },
  );

reviewCommand
  .command("show <path>")
  .description("Render a saved review artifact JSON file.")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--agent", "emit plain text optimized for coding agents")
  .option("--json", "emit normalized review artifact JSON")
  .action(
    async (
      artifactPath: string,
      options: { agent?: boolean; cwd: string; json?: boolean },
      command,
    ) => {
      const mode = resolveReviewShowOutputMode(options);
      const artifact = await readReviewArtifact(
        artifactPath,
        resolveReviewShowCwd(options, command),
      );
      if (mode === "json") {
        process.stdout.write(renderJson(artifact));
        return;
      }

      if (mode === "agent") {
        process.stdout.write(renderAgentReviewSummary(artifact));
        return;
      }

      process.stdout.write(
        renderHumanReviewArtifact(artifact, {
          color: shouldUseHumanColor({ env: process.env, stream: process.stdout }),
        }),
      );
    },
  );

program
  .command("init")
  .description("Create a starter user config file.")
  .option("--discover", "scaffold the config from reviewers discovered on this host")
  .option("--interactive", "confirm the discovered config before writing (requires --discover)")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(
    async (options: {
      discover?: boolean;
      interactive?: boolean;
      cwd: string;
      json?: boolean;
    }) => {
      if (options.discover === true) {
        await runInitDiscover(options);
        return;
      }
      if (options.interactive === true) {
        throw invalidCli("--interactive requires --discover");
      }

      const configPath = await initDiffwardenConfig();
      process.stdout.write(
        options.json === true
          ? `${JSON.stringify({ path: configPath, created: true }, null, 2)}\n`
          : `Created ${configPath}\n`,
      );
    },
  );

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
  .option("--json", "output machine-readable JSON")
  .action(
    async (options: {
      reviewer: string[];
      reviewerSet?: string;
      model?: string;
      effort?: string;
      timeout?: string;
      cwd: string;
      json?: boolean;
    }) => {
      // Non-review commands intentionally use command-local options only.
      // The old root/global merge path was tied to the removed --format surface.
      const loadedConfig = await loadDiffwardenConfig({ cwd: options.cwd });
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
      const model = overrideSelection(options.model, envOptions.model);
      const effort = overrideSelection(options.effort, envOptions.effort);
      const report = await runReviewerPreflightReport({
        cwd: options.cwd,
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
        options.json === true
          ? `${JSON.stringify(report, null, 2)}\n`
          : renderPreflightText(report),
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
  .option("--json", "output machine-readable JSON")
  .action(async (options: { cwd: string; json?: boolean }) => {
    // Keep reviewer inspection local to this command; root-level aliases are not supported.
    const loadedConfig = await loadDiffwardenConfig({ cwd: options.cwd });
    if (loadedConfig === undefined) {
      throw invalidConfig(
        "No diffwarden config found; run diffwarden init to create a config or pass --cwd to a configured repository",
      );
    }

    const summary = summarizeReviewers(loadedConfig);
    process.stdout.write(
      options.json === true
        ? `${JSON.stringify(summary, null, 2)}\n`
        : renderReviewerListText(summary),
    );
  });

reviewers
  .command("discover")
  .description(
    "Probe the host for usable reviewer engines without running reviews or spending model budget.",
  )
  .option("--cwd <path>", "working directory", process.cwd())
  .option(
    "--deep",
    "additionally run adapter preflight checks (may spawn CLIs or call provider APIs)",
  )
  .option("--json", "output machine-readable JSON")
  .action(async (options: { cwd: string; deep?: boolean; json?: boolean }) => {
    const result = await discoverReviewers({
      cwd: options.cwd,
      env: process.env,
      ...(options.deep === true
        ? {
            deep: true,
            deepPreflight: (targets) =>
              runReviewerPreflightReport({
                cwd: options.cwd,
                reviewers: targets.map(deepPreflightTargetId),
                config: deepPreflightConfig(targets),
              }),
          }
        : {}),
    });

    process.stdout.write(
      options.json === true
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderReviewerDiscoveryText(result, {
            color: shouldUseHumanColor({ env: process.env, stream: process.stdout }),
          }),
    );
  });

reviewers
  .command("add [engine]")
  .description("Add a reviewer to the user config (~/.config/diffwarden/diffwarden.config.json).")
  .option("--id <id>", "reviewer id (defaults to the engine name)")
  .option("--transport <transport>", "transport: sdk, cli, or app-server")
  .option("--model <id>", "model for the reviewer")
  .option("--effort <level>", "effort for the reviewer")
  .option("--provider <name>", "provider hint for the reviewer")
  .option("--set <name>", "also add the reviewer id to this reviewer set")
  .option("--disabled", "write the reviewer as a disabled placeholder (enabled: false)")
  .option("--interactive", "select and confirm the reviewer before writing (requires a TTY)")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(async (engineArg: string | undefined, options: ReviewerAddCliOptions) => {
    const entry =
      options.interactive === true
        ? await resolveInteractiveAddEntry(engineArg, options)
        : buildRequiredAddEntry(engineArg, options);
    if (entry === undefined) {
      return;
    }

    // By design the write target is the env-located user config (decision: always user, never
    // project), so it is not derived from --cwd. --cwd only scopes the shadow-config check below.
    const result = await addReviewerToUserConfig({
      entry,
      env: process.env,
      ...(options.set !== undefined ? { reviewerSet: options.set } : {}),
    });

    await warnIfProjectConfigShadows(options.cwd, result.path);

    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            path: result.path,
            created: result.created,
            action: result.action,
            reviewer: entry,
            ...(options.set !== undefined ? { reviewerSet: options.set } : {}),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const verb = result.action === "updated" ? "Updated" : "Added";
    const setSuffix =
      options.set !== undefined ? ` and added it to reviewer set ${options.set}` : "";
    process.stdout.write(
      `${verb} reviewer ${entry.id} (${entry.engine})${setSuffix} in ${result.path}\n`,
    );
  });

reviewers
  .command("remove <id>")
  .description("Remove a reviewer from the user config and prune it from reviewer sets.")
  .option("--force", "remove even if it empties the default reviewer set")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(async (id: string, options: { force?: boolean; cwd: string; json?: boolean }) => {
    // By design the write target is the env-located user config (decision: always user, never
    // project), so it is not derived from --cwd; --cwd only scopes the shadow-config check.
    const result = await removeReviewerFromUserConfig({
      id,
      env: process.env,
      ...(options.force === true ? { force: true } : {}),
    });

    await warnIfProjectConfigShadows(options.cwd, result.path);

    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          { path: result.path, removed: id, prunedFromSets: result.prunedFromSets },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const setSuffix =
      result.prunedFromSets.length > 0
        ? ` and pruned it from reviewer set ${result.prunedFromSets.join(", ")}`
        : "";
    process.stdout.write(`Removed reviewer ${id}${setSuffix} in ${result.path}\n`);
  });

reviewers
  .command("edit <id>")
  .description("Edit fields on a configured reviewer in the user config.")
  .option("--transport <transport>", "transport: sdk, cli, or app-server")
  .option("--model <id>", "model for the reviewer")
  .option("--effort <level>", "effort for the reviewer")
  .option("--provider <name>", "provider hint for the reviewer")
  .option("--enabled", "mark the reviewer enabled (clear a disabled placeholder)")
  .option("--disabled", "mark the reviewer disabled (enabled: false)")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(async (id: string, options: ReviewerEditCliOptions) => {
    const patch = buildReviewerEditPatch(options);

    // Write target is the env-located user config by design; --cwd only scopes the shadow check.
    const result = await editReviewerInUserConfig({ id, patch, env: process.env });

    await warnIfProjectConfigShadows(options.cwd, result.path);

    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ path: result.path, reviewer: result.reviewer }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`Updated reviewer ${id} in ${result.path}\n`);
  });

const reviewerSet = reviewers
  .command("set")
  .description("Manage reviewer set membership in the user config.");

reviewerSet
  .command("add <set> <reviewer>")
  .description("Add a configured reviewer id to a reviewer set.")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(async (setName: string, reviewerId: string, options: { cwd: string; json?: boolean }) => {
    const result = await addReviewerToSetInUserConfig({
      setName,
      reviewerId,
      env: process.env,
    });

    await warnIfProjectConfigShadows(options.cwd, result.path);

    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ path: result.path, set: result.set, members: result.members }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`Added ${reviewerId} to reviewer set ${setName} in ${result.path}\n`);
  });

reviewerSet
  .command("remove <set> <reviewer>")
  .description("Remove a reviewer id from a reviewer set.")
  .option("--force", "remove even if it empties the default reviewer set")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(
    async (
      setName: string,
      reviewerId: string,
      options: { force?: boolean; cwd: string; json?: boolean },
    ) => {
      const result = await removeReviewerFromSetInUserConfig({
        setName,
        reviewerId,
        env: process.env,
        ...(options.force === true ? { force: true } : {}),
      });

      await warnIfProjectConfigShadows(options.cwd, result.path);

      if (options.json === true) {
        process.stdout.write(
          `${JSON.stringify({ path: result.path, set: result.set, members: result.members }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(
        `Removed ${reviewerId} from reviewer set ${setName} in ${result.path}\n`,
      );
    },
  );

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
  const reviewPlan = resolveReviewPlan({
    focus: options.focus,
    overviewConflict: options.overviewConflict === true,
    targetKind: resolved.target.kind,
    ...(options.overview !== undefined ? { overview: options.overview } : {}),
    ...(loadedConfig !== undefined ? { config: loadedConfig.config } : {}),
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
  const ndjson = options.mode === "ndjson";
  const human = options.mode === "human";
  const agent = options.mode === "agent";
  const showProgress = options.mode === "json" && process.stderr.isTTY === true;
  const humanColor = human
    ? shouldUseHumanColor({ env: process.env, stream: process.stdout })
    : false;
  const runOptions = {
    cwd: options.cwd,
    resolved,
    ...reviewerOptions,
    ...(model !== undefined ? { model: model.value, modelSource: model.source } : {}),
    ...(effort !== undefined ? { effort: effort.value, effortSource: effort.source } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(options.strict === true ? { strict: true } : {}),
    ...(loadedConfig !== undefined ? { config: loadedConfig.config } : {}),
  };
  const events =
    reviewPlan === undefined
      ? runReviewEvents(runOptions)
      : runReviewBatchEvents({
          ...runOptions,
          plan: reviewPlan,
        });

  let artifact: ReviewRunArtifact | undefined;
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
    throw diffwardenErrorFromReviewerError(terminalError);
  }

  if (artifact === undefined) {
    throw reviewerFailed("Review produced no result");
  }

  if (options.out) {
    await writeFile(options.out, renderJson(artifact));
  }

  if (human) {
    process.stdout.write(renderHumanReviewSummary(artifact, { color: humanColor }));
  } else if (agent) {
    process.stdout.write(renderAgentReviewSummary(artifact));
  } else if (!ndjson) {
    process.stdout.write(renderJson(artifact));
  }

  const provenanceFormat: ReviewReportOutputFormat = options.mode;
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
      outputMode: provenanceFormat,
      ...(reviewPlan !== undefined
        ? {
            focus: reviewPlan.focus,
            includeOverview: reviewPlan.include_overview,
            reviewPlan,
          }
        : {}),
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

function writeHumanBlock(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

function formatReviewProgressLine(reviewEvent: ReviewEvent): string | undefined {
  switch (reviewEvent.type) {
    case "batch_started":
      return `diffwarden: reviewing ${reviewEvent.plan.lanes.length} lane${
        reviewEvent.plan.lanes.length === 1 ? "" : "s"
      } with ${reviewEvent.reviewers.map((reviewer) => reviewer.id).join(", ")}`;
    case "run_started":
      return `${formatProgressLanePrefix(reviewEvent.lane_id)}diffwarden: reviewing with ${reviewEvent.reviewers
        .map((reviewer) => reviewer.id)
        .join(", ")}`;
    case "reviewer_started":
      return `  … ${formatProgressLanePrefix(reviewEvent.lane_id)}${
        reviewEvent.reviewer_id
      } running`;
    case "reviewer_result":
      return `  ✓ ${formatProgressLanePrefix(reviewEvent.lane_id)}${
        reviewEvent.reviewer_id
      } finished${formatProgressTiming(reviewEvent.artifact.timing_ms)}`;
    case "reviewer_failed":
      return `  ✗ ${formatProgressLanePrefix(reviewEvent.lane_id)}${
        reviewEvent.reviewer_id
      } failed: ${reviewEvent.error.message}`;
    case "lane_finished":
      return `  ✓ lane ${reviewEvent.lane_id} finished${formatProgressTiming(
        reviewEvent.timing_ms,
      )}`;
    case "lane_failed":
      return `  ✗ lane ${reviewEvent.lane_id} failed: ${reviewEvent.error.message}`;
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

function formatProgressLanePrefix(laneId: string | undefined): string {
  return laneId === undefined ? "" : `[${laneId}] `;
}

function formatProgressTiming(timingMs: number | undefined): string {
  return timingMs === undefined ? "" : ` (${(timingMs / 1000).toFixed(1)}s)`;
}

function resolveReviewPlan(options: {
  focus: string[];
  overview?: boolean;
  overviewConflict: boolean;
  targetKind: string;
  config?: LoadedDiffwardenConfig["config"];
}): ReviewPlan | undefined {
  if (options.overviewConflict) {
    throw invalidCli("Choose only one overview control: --overview or --no-overview");
  }

  const focus = options.focus.map((value) => value.trim());
  const emptyFocusIndex = focus.findIndex((value) => value === "");
  if (emptyFocusIndex >= 0) {
    throw invalidCli(`Invalid --focus value at position ${emptyFocusIndex + 1}: expected text`);
  }

  if (focus.length === 0) {
    if (options.overview !== undefined) {
      throw invalidCli("--overview and --no-overview require at least one --focus");
    }
    return undefined;
  }

  if (options.targetKind === "custom") {
    throw invalidCli("--focus is only supported for diff-backed targets, not custom:<text>");
  }

  const includeOverview = options.overview ?? options.config?.reviewPlan?.includeOverview ?? true;
  const lanes: ReviewPlan["lanes"] = [
    ...(includeOverview ? [{ id: "overview", kind: "overview" as const }] : []),
    ...focus.map((focusText, index) => ({
      id: `focus-${index + 1}`,
      kind: "focus" as const,
      focus: focusText,
    })),
  ];

  return {
    include_overview: includeOverview,
    focus,
    lanes,
  };
}

function renderPreflightText(report: ReviewerPreflightReport): string {
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

type ReviewerAddCliOptions = {
  id?: string;
  transport?: string;
  model?: string;
  effort?: string;
  provider?: string;
  set?: string;
  disabled?: boolean;
  interactive?: boolean;
  cwd: string;
  json?: boolean;
};

type ReviewerEditCliOptions = {
  transport?: string;
  model?: string;
  effort?: string;
  provider?: string;
  enabled?: boolean;
  disabled?: boolean;
  cwd: string;
  json?: boolean;
};

function buildReviewerEditPatch(options: ReviewerEditCliOptions): EditReviewerPatch {
  if (options.enabled === true && options.disabled === true) {
    throw invalidCli("Pass only one of --enabled or --disabled");
  }
  const { transport } = options;
  if (
    transport !== undefined &&
    transport !== "sdk" &&
    transport !== "cli" &&
    transport !== "app-server"
  ) {
    throw invalidCli(`Invalid transport: ${transport}`);
  }
  const patch: EditReviewerPatch = {
    ...(transport !== undefined ? { transport } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.enabled === true ? { enabled: true } : {}),
    ...(options.disabled === true ? { enabled: false } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw invalidCli(
      "Specify at least one field to edit: --transport, --model, --effort, --provider, --enabled, or --disabled",
    );
  }
  return patch;
}

function buildRequiredAddEntry(
  engineArg: string | undefined,
  options: ReviewerAddCliOptions,
): PublicReviewerEntry {
  if (engineArg === undefined) {
    throw invalidCli("Specify a reviewer engine to add, or use --interactive");
  }
  return buildReviewerAddEntry(engineArg, options);
}

function assertNoEntryShapingFlags(options: ReviewerAddCliOptions): void {
  const used = [
    options.id !== undefined ? "--id" : undefined,
    options.transport !== undefined ? "--transport" : undefined,
    options.model !== undefined ? "--model" : undefined,
    options.effort !== undefined ? "--effort" : undefined,
    options.provider !== undefined ? "--provider" : undefined,
    options.disabled === true ? "--disabled" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (used.length > 0) {
    throw invalidCli(
      `${used.join(", ")} require naming an engine. Interactive selection without an engine uses the discovered recommendation; run "diffwarden reviewers add <engine> [flags]" to customize the entry.`,
    );
  }
}

async function resolveInteractiveAddEntry(
  engineArg: string | undefined,
  options: ReviewerAddCliOptions,
): Promise<PublicReviewerEntry | undefined> {
  if (engineArg === undefined) {
    // The selection path uses the discovered recommendation; entry-shaping flags would be
    // silently dropped, so reject them instead of writing something other than what was asked.
    assertNoEntryShapingFlags(options);
  }
  if (!isInteractiveAvailable(process.stdin)) {
    throw invalidCli("--interactive requires an interactive terminal (TTY)");
  }

  // Prompts go to stderr so --json keeps stdout clean for the machine-readable result.
  const prompter = createReadlinePrompter({ output: process.stderr });
  try {
    const entry =
      engineArg !== undefined
        ? buildReviewerAddEntry(engineArg, options)
        : await selectInteractiveAddEntry(prompter, options.cwd);
    if (entry === undefined) {
      process.stdout.write("No reviewers available to add.\n");
      return undefined;
    }

    if (!(await confirmWriteEntry(prompter, entry, userConfigPath(process.env)))) {
      process.stdout.write("Aborted.\n");
      return undefined;
    }
    return entry;
  } finally {
    prompter.close();
  }
}

async function selectInteractiveAddEntry(
  prompter: Prompter,
  cwd: string,
): Promise<PublicReviewerEntry | undefined> {
  const result = await discoverReviewers({ cwd, env: process.env });
  return promptSelectReviewerEntry(prompter, result);
}

function buildReviewerAddEntry(
  engineArg: string,
  options: ReviewerAddCliOptions,
): PublicReviewerEntry {
  if (!isReviewerSdk(engineArg) || engineArg === "fake") {
    throw invalidCli(`Unknown reviewer engine: ${engineArg}`);
  }
  const engine: ReviewerSdk = engineArg;
  const transport = resolveAddTransport(engine, options.transport);
  const base = recommendReviewerEntry(engine, transport);
  const model = options.model ?? base.model;
  // Reject overrides the resolved transport cannot honor before writing, so setup fails fast
  // instead of producing a config that only errors at review/preflight time.
  validateReviewerCapabilityOverrides({
    id: options.id ?? base.id,
    sdk: engine,
    transport,
    ...(model !== undefined ? { model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    readonly: true,
  });
  return {
    id: options.id ?? base.id,
    engine,
    ...(base.transport !== undefined ? { transport: base.transport } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.disabled === true ? { enabled: false } : {}),
  };
}

function resolveAddTransport(engine: ReviewerSdk, requested: string | undefined) {
  const transport = requested ?? defaultReviewerTransport(engine) ?? "sdk";
  if (transport !== "sdk" && transport !== "cli" && transport !== "app-server") {
    throw invalidCli(`Invalid transport: ${requested}`);
  }
  if (getTransportCapability(engine, transport)?.supported !== true) {
    throw invalidCli(`${engine} does not support ${transport} transport`);
  }
  return transport;
}

function deepPreflightTargetId(target: ReviewerDeepPreflightTarget): string {
  return `discover-${target.engine}-${target.transport}`;
}

/**
 * Build an ephemeral config so `--deep` can preflight a specific (engine, transport) pair.
 * Bare reviewer specs resolve to an engine's default transport; pinning transport here lets
 * deep verify non-default transports (e.g. codex app-server) instead of only the default.
 */
function deepPreflightConfig(targets: ReviewerDeepPreflightTarget[]): DiffwardenConfig {
  return {
    reviewers: targets.map((target) => ({
      id: deepPreflightTargetId(target),
      // Discovery never enumerates the fake engine, so this narrowing is always sound.
      sdk: target.engine as Exclude<ReviewerSdk, "fake">,
      transport: target.transport,
    })),
  };
}

async function warnIfProjectConfigShadows(cwd: string, writtenPath: string): Promise<void> {
  // Best-effort advisory only. A malformed project config in cwd must not fail the command or
  // suppress JSON output after the user config write already succeeded.
  let loaded: LoadedDiffwardenConfig | undefined;
  try {
    loaded = await loadDiffwardenConfig({ cwd });
  } catch {
    return;
  }
  if (loaded !== undefined && path.resolve(loaded.path) !== path.resolve(writtenPath)) {
    process.stderr.write(
      `Note: a project config at ${loaded.path} takes precedence over ${writtenPath}; reviews run from this directory will not use reviewers added to the user config.\n`,
    );
  }
}

async function runInitDiscover(options: {
  cwd: string;
  json?: boolean;
  interactive?: boolean;
}): Promise<void> {
  const result = await discoverReviewers({ cwd: options.cwd, env: process.env });
  const discovered = selectDiscoveredReviewers(result.candidates);
  if (discovered.length === 0) {
    throw invalidCli(
      "No usable reviewers found on this host. Run diffwarden reviewers discover to see options, install or authenticate an engine, then retry, or run diffwarden init for a starter config.",
    );
  }

  let reviewers = discovered;
  if (options.interactive === true) {
    if (!isInteractiveAvailable(process.stdin)) {
      throw invalidCli("--interactive requires an interactive terminal (TTY)");
    }
    // Prompts go to stderr so --json keeps stdout clean for the machine-readable result.
    const prompter = createReadlinePrompter({ output: process.stderr });
    try {
      reviewers = await selectScaffoldReviewers(prompter, discovered);
      if (reviewers.length === 0) {
        process.stdout.write("No reviewers selected. Aborted.\n");
        return;
      }
      if (!(await confirmScaffold(prompter, reviewers, userConfigPath(process.env)))) {
        process.stdout.write("Aborted.\n");
        return;
      }
    } finally {
      prompter.close();
    }
  }

  // --cwd scopes discovery (the host probe above); the scaffold always writes the env-located
  // user config by design (decision: always user, never project), not a cwd-relative file.
  const configPath = await createDiscoveredUserConfig({ reviewers, env: process.env });
  process.stdout.write(
    options.json === true
      ? `${JSON.stringify({ path: configPath, created: true, reviewers }, null, 2)}\n`
      : `Created ${configPath} with ${reviewers.length} reviewer${
          reviewers.length === 1 ? "" : "s"
        }: ${reviewers.map((reviewer) => reviewer.id).join(", ")}\n`,
  );
}

function selectDiscoveredReviewers(
  candidates: ReviewerDiscoveryCandidate[],
): PublicReviewerEntry[] {
  const byEngine = new Map<ReviewerSdk, ReviewerCandidateRecommendation>();
  for (const candidate of candidates) {
    if (candidate.status !== "available" || candidate.recommended === undefined) {
      continue;
    }
    const existing = byEngine.get(candidate.engine);
    // Prefer the primary transport, whose recommendation omits the transport field.
    if (
      existing === undefined ||
      (existing.transport !== undefined && candidate.recommended.transport === undefined)
    ) {
      byEngine.set(candidate.engine, candidate.recommended);
    }
  }

  return [...byEngine.values()].map((recommendation) => ({
    id: recommendation.id,
    engine: recommendation.engine,
    ...(recommendation.transport !== undefined ? { transport: recommendation.transport } : {}),
    ...(recommendation.model !== undefined ? { model: recommendation.model } : {}),
  }));
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

function renderReviewerListText(summary: ReviewerListSummary): string {
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

function resolveReviewOutputMode(options: {
  agent?: boolean;
  json?: boolean;
  ndjson?: boolean;
}): ReviewOutputMode {
  const selected = [
    options.agent === true ? "agent" : undefined,
    options.json === true ? "json" : undefined,
    options.ndjson === true ? "ndjson" : undefined,
  ].filter((mode): mode is ReviewOutputMode => mode !== undefined);

  if (selected.length > 1) {
    throw invalidCli("Choose only one review output mode: --agent, --json, or --ndjson");
  }

  return selected[0] ?? "human";
}

function hasBothOverviewFlags(argv: string[]): boolean {
  let sawOverview = false;
  let sawNoOverview = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--focus") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("--focus=")) {
      continue;
    }
    if (arg === "--overview") {
      sawOverview = true;
    } else if (arg === "--no-overview") {
      sawNoOverview = true;
    }
  }
  return sawOverview && sawNoOverview;
}

function resolveReviewShowOutputMode(options: {
  agent?: boolean;
  json?: boolean;
}): ReviewShowOutputMode {
  const parentOptions = reviewCommand.opts<{ agent?: boolean; json?: boolean; ndjson?: boolean }>();
  if (parentOptions.ndjson === true) {
    throw invalidCli("--ndjson is not compatible with diffwarden review show");
  }

  const selected = new Set<ReviewShowOutputMode>();
  if (options.agent === true || parentOptions.agent === true) {
    selected.add("agent");
  }
  if (options.json === true || parentOptions.json === true) {
    selected.add("json");
  }

  if (selected.size > 1) {
    throw invalidCli("Choose only one review show output mode: --agent or --json");
  }

  return [...selected][0] ?? "human";
}

function resolveReviewShowCwd(options: { cwd: string }, command: Command): string {
  if (command.getOptionValueSource("cwd") !== "default") {
    return options.cwd;
  }

  return reviewCommand.opts<{ cwd?: string }>().cwd ?? options.cwd;
}

async function readReviewArtifact(artifactPath: string, cwd: string): Promise<ReviewRunArtifact> {
  let raw: string;
  try {
    raw = await readFile(path.resolve(cwd, artifactPath), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    throw invalidCli(`Unable to read ReviewArtifact JSON: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw invalidCli(`Invalid ReviewArtifact JSON: ${message}`);
  }

  const result = reviewRunArtifactSchema.safeParse(parsedJson);
  if (!result.success) {
    throw invalidCli(`Invalid ReviewArtifact JSON: ${result.error.message}`);
  }

  return result.data;
}

function normalizeArgv(argv: string[]): string[] {
  if (argv[2] !== "--") {
    return argv;
  }

  return [argv[0] ?? "node", argv[1] ?? "diffwarden", ...argv.slice(3)];
}
