#!/usr/bin/env node
import { existsSync } from "node:fs";
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
  type LayeredUserConfigView,
  type LoadedDiffwardenConfig,
  type PublicReviewerEntry,
  type RemoveReviewerFromUserConfigResult,
  addReviewerToSetInUserConfig,
  addReviewerToUserConfig,
  addReviewersToLocalConfig,
  addReviewersToUserConfig,
  createDiscoveredUserConfig,
  diffwardenConfigSchema,
  editReviewerInLocalConfig,
  editReviewerInUserConfig,
  initDiffwardenConfig,
  listUserConfigReviewerSets,
  listUserConfigReviewers,
  loadDiffwardenConfig,
  loadLayeredUserConfigView,
  loadUserConfigReviewerEntries,
  removeReviewerFromLocalConfig,
  removeReviewerFromSetInUserConfig,
  removeReviewerFromUserConfig,
  replaceReviewerLocalOverride,
  replaceReviewerSetInUserConfig,
  setReviewerInUserConfig,
  userConfigPath,
  userLocalConfigPath,
  validateConfigLayers,
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
import { isInteractiveAvailable, shouldRunInteractiveSetup } from "./core/interactive.js";
import { createLiveReviewProgress } from "./core/live-progress.js";
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
  windowsDoctorCaveat,
} from "./core/runner.js";
import {
  type ReviewEvent,
  type ReviewFailureArtifact,
  type ReviewPlan,
  type ReviewRunArtifact,
  type ReviewerError,
  reviewFailureArtifactSchema,
  reviewRunArtifactSchema,
} from "./core/schema.js";
import {
  runClackReviewerAdd,
  runClackReviewerEdit,
  runClackReviewerRemove,
  runClackReviewerSetEdit,
  runClackReviewerSetup,
} from "./core/setup-clack.js";
import { parseTargetSpec } from "./core/target.js";
import {
  asciiGlyphs,
  clampSummaryWidth,
  supportsLiveMotion,
  supportsUnicodeGlyphs,
  unicodeGlyphs,
} from "./core/terminal-caps.js";
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
    /** Present when a host-local overlay was merged over the user config. */
    local?: {
      path: string;
      sha256: string;
    };
  };
  defaultReviewerSet?: string;
  reviewerSets: Record<string, string[]>;
  reviewers: ReviewerListEntry[];
  /** Per-reviewer id → fields the local overlay overrides (present only when an overlay is active). */
  localOverrides?: Record<string, string[]>;
  /** Reviewer ids defined only in the local overlay (present only when an overlay is active). */
  localOnlyReviewers?: string[];
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
  fallbackModel?: string;
  timeout?: string;
  strict?: boolean;
  failOnFindings?: string;
  focus: string[];
  overview?: boolean;
  overviewConflict?: boolean;
  cwd: string;
  mode: ReviewOutputMode;
  debugReviewerOutput?: boolean;
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
  .option("--fallback-model <id>", "fallback model override for the selected reviewer")
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
  .option(
    "--debug-reviewer-output",
    "capture bounded raw reviewer transport output into artifacts (and stream it with --ndjson)",
  )
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
      debugReviewerOutput?: boolean;
      out?: string;
      report?: boolean;
      reportDir?: string;
      reportScope?: string;
      reportMode?: string;
    }) => {
      if (!options.target) {
        // No implicit default: a silently assumed target could trigger unexpected model spend.
        throw invalidCli(
          "Missing required option --target. Pass --target uncommitted for working-tree changes or --target base:<branch> for a branch diff.",
        );
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
          unicode: supportsUnicodeGlyphs(process.env),
          width: clampSummaryWidth(process.stdout.columns),
        }),
      );
    },
  );

program
  .command("init")
  .description("Create a starter user config file, or scaffold one from discovered reviewers.")
  .option("--discover", "scaffold the config from reviewers discovered on this host")
  .option("--interactive", "force the discover/scaffold flow (the default in a TTY; needs a TTY)")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(
    async (options: {
      discover?: boolean;
      interactive?: boolean;
      cwd: string;
      json?: boolean;
    }) => {
      // Interactive-by-default in a TTY: bare `init` at a terminal runs the discover/scaffold flow;
      // --json or a non-TTY writes the static starter config. --discover still forces discovery even
      // when non-interactive (e.g. `init --discover --json` scaffolds every reviewer without prompts).
      const interactive = shouldRunInteractiveSetup(options);
      if (interactive || options.discover === true) {
        await runInitDiscover({
          cwd: options.cwd,
          interactive,
          ...(options.json === true ? { json: true } : {}),
        });
        return;
      }

      const configPath = await initDiffwardenConfig();
      await warnIfOrphanOverlayConflicts(configPath);
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
  .option("--fallback-model <id>", "fallback model override for the selected reviewer")
  .option("--timeout <seconds>", "reviewer timeout in seconds")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(
    async (options: {
      reviewer: string[];
      reviewerSet?: string;
      model?: string;
      effort?: string;
      fallbackModel?: string;
      timeout?: string;
      cwd: string;
      json?: boolean;
    }) => {
      // Non-review commands intentionally use command-local options only.
      // The old root/global merge path was tied to the removed --format surface.
      const configHealth = await inspectConfigForDoctor(options.cwd);
      if (configHealth.fatal !== undefined) {
        // Diagnose a failing config load instead of dying on it: name the file at fault and the
        // fix, then exit non-zero. This is doctor's job when a fleet-synced base and a host
        // overlay disagree.
        if (options.json === true) {
          process.stdout.write(
            `${JSON.stringify(
              { error: configHealth.fatal.message, diagnosis: configHealth.fatal.diagnosis },
              null,
              2,
            )}\n`,
          );
        } else {
          const lines = [
            "# Diffwarden Doctor",
            "",
            `Config failed to load: ${configHealth.fatal.message}`,
            "",
            ...configHealth.fatal.diagnosis.map((line) => `- ${line}`),
            "",
          ];
          process.stdout.write(`${lines.join("\n")}\n`);
        }
        process.exitCode = 1;
        return;
      }
      const loadedConfig = configHealth.loaded;
      for (const warning of configHealth.warnings) {
        process.stderr.write(`Warning: ${warning}\n`);
      }
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
      const fallbackModel = options.fallbackModel ?? envOptions.fallbackModel;
      const report = await runReviewerPreflightReport({
        cwd: options.cwd,
        ...reviewerOptions,
        ...(model !== undefined ? { model: model.value, modelSource: model.source } : {}),
        ...(effort !== undefined ? { effort: effort.value, effortSource: effort.source } : {}),
        ...(fallbackModel !== undefined ? { fallbackModel } : {}),
        ...(cliTimeoutSeconds !== undefined
          ? { timeoutSeconds: cliTimeoutSeconds }
          : envOptions.timeoutSeconds !== undefined
            ? { timeoutSeconds: envOptions.timeoutSeconds }
            : {}),
        ...(loadedConfig !== undefined ? { config: loadedConfig.config } : {}),
      });

      process.stdout.write(
        options.json === true
          ? `${JSON.stringify(
              {
                ...report,
                ...(configHealth.identity !== undefined ? { config: configHealth.identity } : {}),
              },
              null,
              2,
            )}\n`
          : renderPreflightText(report, configHealth.identity),
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
  .option("--local", "write to the host-local overlay (diffwarden.config.local.json), never synced")
  .option("--interactive", "force the discovered picker for a bare add (no engine); needs a TTY")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(async (engineArg: string | undefined, options: ReviewerAddCliOptions) => {
    // `--interactive` forces the discovered picker, which is inherently the no-engine flow (there is
    // nothing to discover-pick once you have named the engine). Rejecting the combination surfaces
    // the contradictory intent instead of silently dropping the flag and writing the named engine.
    if (engineArg !== undefined && options.interactive === true) {
      throw invalidCli(
        '--interactive forces the discovered picker and cannot be combined with a named engine. Run a bare "diffwarden reviewers add --interactive" to pick, or drop --interactive to add the named engine directly.',
      );
    }

    // Reviewer set membership is fleet policy and lives in the base config; a local set entry
    // would shadow the ENTIRE base set on this host. Refuse the combination.
    if (options.local === true && options.set !== undefined) {
      throw invalidCli("reviewer set membership is base-owned; run without --local");
    }

    // Interactive (clack multiselect) only when no engine is named: a bare `add` at a terminal opens
    // the discovered picker → configure → merge each into the existing config. A named engine is
    // always declarative (build + write that entry). A non-TTY bare `add` errors with the engine
    // hint, and `--interactive` in a non-TTY errors rather than hanging. shouldRunInteractiveSetup
    // already honors --interactive AND --json (json wins, so `add --interactive --json` never prompts).
    const interactive = engineArg === undefined && shouldRunInteractiveSetup(options);
    if (interactive) {
      await runClackAddFlow(options);
      return;
    }

    const entry = buildRequiredAddEntry(engineArg, options);

    if (options.local === true) {
      const result = await addReviewersToLocalConfig({ entries: [entry], env: process.env });
      await warnIfProjectConfigShadows(options.cwd, result.path);
      if (options.json === true) {
        process.stdout.write(
          `${JSON.stringify(
            {
              path: result.path,
              created: result.created,
              action: result.actions[0],
              reviewer: entry,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      const verb = result.actions[0] === "updated" ? "Updated" : "Added";
      process.stdout.write(
        `${verb} reviewer ${entry.id} (${entry.engine}) in the local overlay ${result.path}\n`,
      );
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
    await warnIfLocalOverlayShadows(entry.id, Object.keys(entry), { touchesEnabled: false });

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
  .command("remove [id]")
  .description("Remove a reviewer from the user config and prune it from reviewer sets.")
  .option("--force", "remove even if it empties the default reviewer set")
  .option("--local", "remove only the host-local overlay entry (clears this host's overrides)")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(
    async (
      idArg: string | undefined,
      options: { force?: boolean; local?: boolean; cwd: string; json?: boolean },
    ) => {
      // Interactive-by-default in a TTY: a bare `remove` at a terminal picks the reviewer from the
      // clack picker and confirms; naming an id stays declarative, and a non-TTY / --json bare
      // `remove` errors instead of hanging.
      const selection =
        idArg !== undefined
          ? { id: idArg, target: options.local === true ? ("local" as const) : ("base" as const) }
          : await resolveClackRemoveSelection(options);
      if (selection === undefined) {
        return;
      }

      if (selection.target === "local") {
        const result = await removeReviewerFromLocalConfig({ id: selection.id, env: process.env });
        for (const setName of result.setsReferencing) {
          process.stderr.write(
            `Warning: reviewer set "${setName}" still references "${selection.id}", which no longer exists on this host; reviews using that set will fail until it is pruned.\n`,
          );
        }
        if (options.json === true) {
          process.stdout.write(
            `${JSON.stringify(
              {
                path: result.path,
                removed: selection.id,
                setsReferencing: result.setsReferencing,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }
        process.stdout.write(
          result.wasAppended
            ? `Removed reviewer ${selection.id} from the local overlay ${result.path}\n`
            : `Cleared host overrides for ${selection.id} in ${result.path}\n`,
        );
        return;
      }

      // By design the write target is the env-located user config (decision: always user, never
      // project), so it is not derived from --cwd; --cwd only scopes the shadow-config check.
      const result = await removeReviewerFromUserConfig({
        id: selection.id,
        env: process.env,
        ...(options.force === true ? { force: true } : {}),
      });

      await warnIfProjectConfigShadows(options.cwd, result.path);
      reportRemoveOverlayOutcome(selection.id, result);

      if (options.json === true) {
        process.stdout.write(
          `${JSON.stringify(
            {
              path: result.path,
              removed: selection.id,
              prunedFromSets: result.prunedFromSets,
              ...(result.local !== undefined ? { local: result.local } : {}),
            },
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
      process.stdout.write(`Removed reviewer ${selection.id}${setSuffix} in ${result.path}\n`);
    },
  );

/** Stderr advisories for the overlay side of a base remove: prune outcome + dangling local set members. */
function reportRemoveOverlayOutcome(id: string, result: RemoveReviewerFromUserConfigResult): void {
  if (result.local === undefined) {
    return;
  }
  if (result.local.pruned) {
    process.stderr.write(`Also removed the host overrides for ${id} from ${result.local.path}\n`);
  }
  if (result.local.pruneError !== undefined) {
    process.stderr.write(
      `Warning: could not remove the overlay entry for "${id}" from ${result.local.path} (${result.local.pruneError}); the next diffwarden run will fail until it is removed by hand.\n`,
    );
  }
  for (const setName of result.local.localSetsReferencing) {
    process.stderr.write(
      `Warning: the local overlay's reviewer set "${setName}" still references "${id}"; reviews using that set will fail until it is edited in ${result.local.path}.\n`,
    );
  }
}

reviewers
  .command("edit [id]")
  .description("Edit fields on a configured reviewer in the user config.")
  .option("--transport <transport>", "transport: sdk, cli, or app-server")
  .option("--model <id>", "model for the reviewer")
  .option("--effort <level>", "effort for the reviewer")
  .option("--provider <name>", "provider hint for the reviewer")
  .option("--enabled", "mark the reviewer enabled (clear a disabled placeholder)")
  .option("--disabled", "mark the reviewer disabled (enabled: false)")
  .option("--local", "write to the host-local overlay (diffwarden.config.local.json), never synced")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--json", "output machine-readable JSON")
  .action(async (idArg: string | undefined, options: ReviewerEditCliOptions) => {
    // No field flags + a real TTY ⇒ the immersive clack editor (pick the reviewer if no id, then
    // edit transport/model/effort/enabled in the UI). Any field flag switches to the set-only patch
    // path below (which a non-TTY / --json edit always takes).
    if (!hasEditFieldFlags(options) && shouldRunInteractiveSetup(options)) {
      await runClackEditFlow(idArg, options);
      return;
    }

    // Validate the patch first so a no-field edit fails fast regardless of TTY, before the id check.
    const patch = buildReviewerEditPatch(options);

    // A field flag is the declarative path: it never prompts. Naming the id is required here — to pick
    // a reviewer interactively, run a bare `reviewers edit` (no field flags) for the clack editor.
    if (idArg === undefined) {
      throw invalidCli(
        'Specify a reviewer id to edit (e.g. "diffwarden reviewers edit <id> --model ..."), or run "diffwarden reviewers edit" with no field flags to pick one interactively.',
      );
    }

    if (options.local === true) {
      const result = await editReviewerInLocalConfig({ id: idArg, patch, env: process.env });
      await warnIfProjectConfigShadows(options.cwd, result.path);
      if (options.json === true) {
        process.stdout.write(
          `${JSON.stringify({ path: result.path, reviewer: result.reviewer }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(`Updated reviewer ${idArg} in the local overlay ${result.path}\n`);
      return;
    }

    // A base edit of an id that exists only in the overlay would report "not found" against the
    // wrong file; point at --local instead (mirrors the remove pointer).
    await assertNotLocalOnlyReviewer(idArg);

    // Write target is the env-located user config by design; --cwd only scopes the shadow check.
    const result = await editReviewerInUserConfig({ id: idArg, patch, env: process.env });

    await warnIfProjectConfigShadows(options.cwd, result.path);
    await warnIfLocalOverlayShadows(idArg, Object.keys(patch), {
      touchesEnabled: patch.enabled !== undefined,
    });

    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ path: result.path, reviewer: result.reviewer }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`Updated reviewer ${idArg} in ${result.path}\n`);
  });

/** Base-edit guard: an id defined only in the local overlay gets a --local pointer, not "not found". */
async function assertNotLocalOnlyReviewer(id: string): Promise<void> {
  const localPath = userLocalConfigPath(process.env);
  if (!existsSync(localPath)) {
    return;
  }
  let view: LayeredUserConfigView;
  try {
    view = await loadLayeredUserConfigView({ env: process.env });
  } catch {
    // Missing/broken base: let the declarative path surface its own error.
    return;
  }
  if (view.appendedReviewerIds.includes(id)) {
    throw invalidCli(
      `Reviewer "${id}" is defined only in the local overlay at ${view.localPath}. Re-run with --local to edit it.`,
    );
  }
}

const reviewerSet = reviewers
  .command("set")
  .description(
    "Manage reviewer sets in the user config. Bare `reviewers set` opens the interactive editor in a TTY.",
  )
  .action(async () => {
    // Bare `reviewers set`: interactive editor (membership + default-set designation) in a
    // TTY; non-TTY callers must use the declarative add/remove subcommands.
    if (!isInteractiveAvailable(process.stdin)) {
      throw invalidCli(
        "reviewers set is interactive and requires a TTY. Use `reviewers set add <set> <reviewer>` / `reviewers set remove <set> <reviewer>` instead.",
      );
    }
    await runClackSetFlow();
  });

async function runClackSetFlow(): Promise<void> {
  // Read the sets/digest snapshot before the reviewer list: any config change after the
  // digest read then fails the save-time sha guard instead of silently becoming baseline.
  const { sets, defaultReviewerSet, sha256 } = await listUserConfigReviewerSets({
    env: process.env,
  });
  const { path: configPath, reviewers: configured } = await listUserConfigReviewers({
    env: process.env,
  });
  if (configured.length === 0) {
    process.stdout.write("No configured reviewers — add reviewers before editing sets.\n");
    return;
  }

  const edited = await runClackReviewerSetEdit({
    reviewers: configured,
    sets,
    defaultReviewerSet,
    configPath,
  });
  if (edited === undefined) {
    process.stdout.write("Aborted.\n");
    return;
  }

  const result = await replaceReviewerSetInUserConfig({
    setName: edited.setName,
    members: edited.members,
    ...(edited.makeDefault ? { makeDefault: true } : {}),
    env: process.env,
    // Abort instead of clobbering a concurrent config change made while the prompts were open.
    expectedSha256: sha256,
  });
  await warnIfLocalSetShadows(edited.setName);
  process.stdout.write(
    `Updated reviewer set ${edited.setName} (${
      result.members.length === 0 ? "empty" : result.members.join(", ")
    })${edited.makeDefault ? " · now the default set" : ""} in ${result.path}\n`,
  );
}

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
    await warnIfLocalSetShadows(setName);

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
      await warnIfLocalSetShadows(setName);

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
  const fallbackModel = options.fallbackModel ?? envOptions.fallbackModel;
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
  // Decision S1: human live progress renders to stderr; the final summary owns stdout — so
  // `diffwarden review > out.md` captures a clean summary while the terminal stays animated.
  // S1a: color is decided per stream; a redirected stdout must not strip color from the live
  // block (nor vice versa).
  const unicode = supportsUnicodeGlyphs(process.env);
  const summaryRenderOptions = {
    color: human ? shouldUseHumanColor({ env: process.env, stream: process.stdout }) : false,
    unicode,
    width: clampSummaryWidth(process.stdout.columns),
  };
  const progressColor = shouldUseHumanColor({ env: process.env, stream: process.stderr });
  const liveProgress =
    human && supportsLiveMotion(process.stderr, process.env)
      ? createLiveReviewProgress({
          stream: process.stderr,
          color: progressColor,
          glyphs: unicode ? unicodeGlyphs : asciiGlyphs,
        })
      : undefined;
  const runOptions = {
    cwd: options.cwd,
    resolved,
    ...reviewerOptions,
    ...(model !== undefined ? { model: model.value, modelSource: model.source } : {}),
    ...(effort !== undefined ? { effort: effort.value, effortSource: effort.source } : {}),
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(options.strict === true ? { strict: true } : {}),
    ...(options.debugReviewerOutput === true ? { debugReviewerOutput: true } : {}),
    // Streaming intent lets transports switch to native stream output modes;
    // it exists only when the events have a live consumer (--ndjson).
    ...(options.debugReviewerOutput === true && ndjson ? { debugReviewerStreaming: true } : {}),
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
  // The live block owns cursor motion on stderr until finish(); finish runs in `finally` so
  // every exit path (terminal error, thrown adapter failure, Ctrl-C-adjacent rejections)
  // tears the volatile region down before anything else writes to the terminal.
  try {
    let next = await events.next();
    while (next.done !== true) {
      const reviewEvent = next.value;
      if (ndjson) {
        process.stdout.write(`${JSON.stringify(reviewEvent)}\n`);
      } else if (human) {
        if (liveProgress !== undefined) {
          liveProgress.handleEvent(reviewEvent);
        } else {
          // Append-only fallback tier (5.2): non-TTY / dumb / narrow stderr gets plain
          // progress lines, still on stderr per S1.
          writeHumanBlock(renderHumanReviewEvent(reviewEvent, { color: progressColor }));
        }
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
  } finally {
    liveProgress?.finish();
  }

  if (terminalError !== undefined) {
    if (options.out) {
      // A failed run still writes --out: consumers polling the path need the recorded
      // failure, not ENOENT.
      const failureArtifact: ReviewFailureArtifact = {
        schema_version: 2,
        kind: "failure",
        status: "failed",
        error: terminalError,
      };
      await writeFile(options.out, renderJson(failureArtifact));
    }
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
    process.stdout.write(renderHumanReviewSummary(artifact, summaryRenderOptions));
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
        ? {
            config: {
              path: loadedConfig.path,
              sha256: loadedConfig.sha256,
              ...(loadedConfig.overlay !== undefined
                ? {
                    local: { path: loadedConfig.overlay.path, sha256: loadedConfig.overlay.sha256 },
                  }
                : {}),
            },
          }
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
  // S1: progress is stderr's; stdout carries only the final summary in human mode.
  process.stderr.write(value.endsWith("\n") ? value : `${value}\n`);
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

function renderPreflightText(
  report: ReviewerPreflightReport,
  configIdentity?: DoctorConfigHealth["identity"],
): string {
  const lines = [
    "# Diffwarden Doctor",
    "",
    `CWD: ${report.cwd}`,
    ...(configIdentity !== undefined ? [`Config: ${configIdentity.path}`] : []),
    ...(configIdentity?.local !== undefined ? [`Local overlay: ${configIdentity.local.path}`] : []),
    "",
  ];

  const caveat = windowsDoctorCaveat();
  if (caveat !== undefined) {
    lines.push(caveat, "");
  }

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
  local?: boolean;
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
  local?: boolean;
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

/**
 * The bare `reviewers add` clack flow: discover, offer the not-yet-configured reviewers in the same
 * multiselect→configure picker as `init`, then merge each chosen entry into the user config. Reached
 * only behind the TTY gate; entry-shaping flags are rejected because the picker uses the discovered
 * recommendation (they would be silently dropped).
 */
async function runClackAddFlow(options: ReviewerAddCliOptions): Promise<void> {
  if (!isInteractiveAvailable(process.stdin)) {
    throw invalidCli("--interactive requires an interactive terminal (TTY)");
  }
  assertNoEntryShapingFlags(options);

  const configPath = userConfigPath(process.env);
  const localPath = userLocalConfigPath(process.env);
  const overlayExists = existsSync(localPath);
  const discovery = await discoverReviewers({ cwd: options.cwd, env: process.env });
  // Reserve EVERY id already on disk — in the base AND the local overlay (the collision space is
  // the MERGED reviewer list) — including hand-edited/legacy rows that loadUserConfigReviewerEntries
  // would drop (unknown engine, etc.): mergeReviewerById matches by id alone, so an in-picker rename
  // to such an id would otherwise silently overwrite it. listUserConfigReviewers keeps every
  // string-id row. Capture the read-time shas so the final write can abort if the target file
  // changed while the picker was open.
  const existing = existsSync(configPath)
    ? await listUserConfigReviewers({ env: process.env })
    : undefined;
  const layered =
    existsSync(configPath) && overlayExists
      ? await loadLayeredUserConfigView({ env: process.env })
      : undefined;
  const existingIds = new Set(
    layered !== undefined
      ? layered.summaries.map((reviewer) => reviewer.id)
      : (existing?.reviewers.map((reviewer) => reviewer.id) ?? []),
  );
  // selectDiscoveredReviewers curates ONE recommendation per engine (primary transport preferred) —
  // the same set `init` offers. So the collapse happens before this existing-id filter by design: if
  // the primary id (e.g. `codex`) is already configured, bare add won't re-offer that engine under a
  // secondary transport (e.g. `codex-app-server`). Adding a specific non-default transport is the job
  // of the declarative `reviewers add <engine> --transport <t>` path, not the discovery picker.
  const ready = selectDiscoveredReviewers(discovery.candidates).filter(
    (entry) => !existingIds.has(entry.id),
  );
  if (ready.length === 0) {
    process.stdout.write(
      "No new reviewers to add — every discovered reviewer is already configured.\n",
    );
    return;
  }

  // Interactive parity: with an overlay present, the flow asks where the new reviewers land
  // (inside its intro frame). Without one, base is the only sensible target and single-file users
  // see nothing new. An explicit --local flag skips the question; --set implies base (set
  // membership is base-owned, so there is nothing to ask).
  const askTarget = options.local !== true && overlayExists && options.set === undefined;
  if (options.local === true && !existsSync(configPath)) {
    throw invalidCli(
      `No diffwarden user config at ${configPath}; the local overlay only overlays a base config. Run diffwarden init first.`,
    );
  }

  const outcome = await runClackReviewerAdd({
    ready,
    candidates: discovery.candidates,
    configPath: options.local === true ? localPath : configPath,
    reservedIds: existingIds,
    ...(askTarget ? { targetSelect: { basePath: configPath, localPath } } : {}),
  });
  if (outcome === undefined || outcome.entries.length === 0) {
    process.stdout.write("Aborted.\n");
    return;
  }
  const sculpted = outcome.entries;
  const target: "base" | "local" =
    options.local === true ? "local" : askTarget ? outcome.target : "base";

  if (target === "local") {
    // The local batch merges by id into the overlay in one atomic write; the merged view is
    // validated before the write, and the local file's own CAS guards the prompt window.
    await addReviewersToLocalConfig({
      entries: sculpted,
      env: process.env,
      ...(layered?.localSha256 !== undefined ? { expectedSha256: layered.localSha256 } : {}),
    });
    await warnIfProjectConfigShadows(options.cwd, localPath);
    const ids = sculpted.map((entry) => entry.id).join(", ");
    process.stdout.write(
      `Added ${sculpted.length} reviewer${sculpted.length === 1 ? "" : "s"} to the local overlay ${localPath}: ${ids}\n`,
    );
    return;
  }

  // Persist the whole batch in one atomic write so a mid-batch failure never leaves a partial add.
  // Pass the picker's read-time sha (when the config already existed) so a config change during the
  // prompt window trips the concurrency guard instead of merging stale entries over it; when the
  // config did not exist, expectAbsent makes a config *created* during the window fail the same way
  // instead of silently merging our stale reserved-id state into it.
  await addReviewersToUserConfig({
    entries: sculpted,
    env: process.env,
    ...(existing !== undefined ? { expectedSha256: existing.sha256 } : { expectAbsent: true }),
    ...(options.set !== undefined ? { reviewerSet: options.set } : {}),
  });
  await warnIfProjectConfigShadows(options.cwd, configPath);
  const ids = sculpted.map((entry) => entry.id).join(", ");
  const setSuffix = options.set !== undefined ? ` (also added to reviewer set ${options.set})` : "";
  process.stdout.write(
    `Added ${sculpted.length} reviewer${sculpted.length === 1 ? "" : "s"} to ${configPath}${setSuffix}: ${ids}\n`,
  );
}

/**
 * The bare `reviewers edit` clack flow: pick which configured reviewer (when no id is named) and edit
 * transport/model/effort/enabled in the field editor, then persist via setReviewerInUserConfig (which
 * honors cleared overrides). Reached only behind the TTY gate.
 */
async function runClackEditFlow(
  idArg: string | undefined,
  options: ReviewerEditCliOptions,
): Promise<void> {
  if (!isInteractiveAvailable(process.stdin)) {
    throw invalidCli("--interactive requires an interactive terminal (TTY)");
  }
  const {
    path: configPath,
    entries,
    sha256: loadedSha256,
  } = await loadUserConfigReviewerEntries({ env: process.env });

  // A host overlay in play (an overlay file exists, or --local asked for one) upgrades the editor
  // to the layered flow: destination question, merged-view seeds for local edits, override labels.
  const overlayExists = existsSync(userLocalConfigPath(process.env));
  const layered =
    overlayExists || options.local === true
      ? await loadLayeredUserConfigView({ env: process.env })
      : undefined;

  // Validate a named target first: `edit <id>` must report that the id cannot be edited (non-zero)
  // even when the editable list is empty, matching the declarative path — not silently exit 0 via
  // the empty-list message below. The bare picker (no id) is what the empty-list case belongs to.
  // The nameable universe is the MERGED view when an overlay is active (a local-only id is
  // editable — with --local), the base file otherwise.
  const nameableEntries = layered?.entries ?? entries;
  if (idArg !== undefined && !nameableEntries.some((entry) => entry.id === idArg)) {
    // An id is absent from the editable set for exactly one of two reasons: it truly does not exist,
    // or it exists as a legacy/unknown-engine row (loadUserConfigReviewerEntries drops those,
    // listUserConfigReviewers keeps them). Distinguish the two so a present-but-uneditable reviewer
    // gets the same unknown-engine verdict the declarative editReviewerInUserConfig returns, instead
    // of being misreported as missing.
    const all = await listUserConfigReviewers({ env: process.env });
    if (all.reviewers.some((reviewer) => reviewer.id === idArg)) {
      throw invalidCli(
        `Reviewer "${idArg}" has an unknown engine and cannot be edited. Fix its engine in ${configPath} or remove it with "diffwarden reviewers remove ${idArg}".`,
      );
    }
    throw invalidCli(`No reviewer with id "${idArg}" to edit.`);
  }
  if (nameableEntries.length === 0) {
    process.stdout.write("No configured reviewers to edit.\n");
    return;
  }

  const discovery = await discoverReviewers({ cwd: options.cwd, env: process.env });
  const edited = await runClackReviewerEdit({
    entries,
    ...(idArg !== undefined ? { targetId: idArg } : {}),
    candidates: discovery.candidates,
    configPath,
    ...(layered !== undefined
      ? {
          layers: {
            basePath: layered.basePath,
            localPath: layered.localPath,
            baseEntries: layered.baseEntries,
            mergedEntries: layered.entries,
            localOverridesById: layered.reviewerOverrides,
            appendedReviewerIds: layered.appendedReviewerIds,
            // --local skips the destination question; a named local-only id can only mean local.
            ...(options.local === true ||
            (idArg !== undefined && layered.appendedReviewerIds.includes(idArg))
              ? { forcedTarget: "local" as const }
              : {}),
          },
        }
      : {}),
  });
  if (edited === undefined) {
    process.stdout.write("Aborted.\n");
    return;
  }

  if (edited.target === "local" && layered !== undefined) {
    // The editor showed the EFFECTIVE (merged) values; persist only the delta against the base
    // entry so the overlay carries exactly the per-host differences.
    const baseEntry = layered.baseEntries.find((entry) => entry.id === edited.id);
    const patch = localOverridePatch(edited.entry, baseEntry);
    const result = await replaceReviewerLocalOverride({
      id: edited.id,
      patch,
      env: process.env,
      ...(layered.localSha256 !== undefined ? { expectedSha256: layered.localSha256 } : {}),
    });
    await warnIfProjectConfigShadows(options.cwd, result.path);
    process.stdout.write(
      Object.keys(patch).length === 0 && baseEntry !== undefined
        ? `Cleared host overrides for ${edited.id} in ${result.path}\n`
        : `Updated reviewer ${edited.id} in the local overlay ${result.path}\n`,
    );
    return;
  }

  // Pass the sha read when the editor opened: if another process changed the config while the prompt
  // was open, this trips the concurrency guard ("Config changed on disk") instead of writing the
  // stale draft's fields over the newer state. The editor was seeded from that same snapshot.
  const result = await setReviewerInUserConfig({
    id: edited.id,
    entry: edited.entry,
    env: process.env,
    expectedSha256: layered?.baseSha256 ?? loadedSha256,
  });
  await warnIfProjectConfigShadows(options.cwd, result.path);
  await warnIfLocalOverlayShadows(edited.id, Object.keys(edited.entry), {
    touchesEnabled: true,
  });
  process.stdout.write(`Updated reviewer ${edited.id} in ${result.path}\n`);
}

/**
 * The overlay delta for an interactively edited reviewer: managed fields where the edited
 * (effective) entry differs from the base entry. `enabled` is explicit in both directions —
 * in the overlay, absence means "inherit base", so re-enabling must beat a base `enabled: false`.
 */
function localOverridePatch(
  edited: PublicReviewerEntry,
  baseEntry: PublicReviewerEntry | undefined,
): EditReviewerPatch {
  const editedEnabled = edited.enabled !== false;
  const baseEnabled = baseEntry === undefined || baseEntry.enabled !== false;
  return {
    ...(edited.transport !== undefined && edited.transport !== baseEntry?.transport
      ? { transport: edited.transport }
      : {}),
    ...(edited.provider !== undefined && edited.provider !== baseEntry?.provider
      ? { provider: edited.provider }
      : {}),
    ...(edited.model !== undefined && edited.model !== baseEntry?.model
      ? { model: edited.model }
      : {}),
    ...(edited.effort !== undefined && edited.effort !== baseEntry?.effort
      ? { effort: edited.effort }
      : {}),
    ...(editedEnabled !== baseEnabled ? { enabled: editedEnabled } : {}),
  };
}

/**
 * Pick a configured reviewer to remove via the clack picker; mirrors the no-id remove TTY gate.
 * The picker shows the MERGED view: local-only reviewers route to the overlay, overlaid base
 * reviewers offer a scope choice (remove everywhere vs clear host overrides only).
 */
async function resolveClackRemoveSelection(options: {
  json?: boolean;
  local?: boolean;
  cwd: string;
}): Promise<{ id: string; target: "base" | "local" } | undefined> {
  if (options.json === true || !isInteractiveAvailable(process.stdin)) {
    throw invalidCli("Specify a reviewer id to remove (interactive selection requires a TTY).");
  }
  const view = await loadLayeredUserConfigView({ env: process.env });
  if (view.summaries.length === 0) {
    process.stdout.write("No configured reviewers to remove.\n");
    return undefined;
  }
  const localOnly = new Set(view.appendedReviewerIds);
  // --local narrows the picker to reviewers that actually have overlay entries to clear.
  const summaries =
    options.local === true
      ? view.summaries.filter(
          (reviewer) =>
            localOnly.has(reviewer.id) || (view.reviewerOverrides[reviewer.id]?.length ?? 0) > 0,
        )
      : view.summaries;
  if (summaries.length === 0) {
    process.stdout.write("No reviewers with host-local overlay entries to remove.\n");
    return undefined;
  }
  return runClackReviewerRemove({
    reviewers: summaries.map((reviewer) => ({
      ...reviewer,
      origin: localOnly.has(reviewer.id)
        ? ("local" as const)
        : (view.reviewerOverrides[reviewer.id]?.length ?? 0) > 0
          ? ("overridden" as const)
          : ("base" as const),
    })),
    configPath: view.basePath,
    ...(view.localSha256 !== undefined ? { localPath: view.localPath } : {}),
    ...(options.local === true ? { forcedTarget: "local" as const } : {}),
  });
}

function hasEditFieldFlags(options: ReviewerEditCliOptions): boolean {
  return (
    options.transport !== undefined ||
    options.model !== undefined ||
    options.effort !== undefined ||
    options.provider !== undefined ||
    options.enabled === true ||
    options.disabled === true
  );
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

type DoctorConfigHealth = {
  loaded?: LoadedDiffwardenConfig;
  identity?: {
    path: string;
    sha256: string;
    local?: { path: string; sha256: string };
  };
  /** Non-fatal overlay findings: orphan overlay, base no longer standalone-valid. */
  warnings: string[];
  /** Set when config loading failed; `diagnosis` names which file is at fault and the fix. */
  fatal?: { message: string; diagnosis: string[] };
};

/**
 * Doctor's config loader: never dies on a failing merged load. On failure it inspects each layer
 * separately — is the base valid standalone, is the overlay well-formed, which overlay entries
 * are orphans — so the fleet-removed-an-overlaid-reviewer scenario reads as a diagnosis with a
 * fix instead of a raw load error. On success it still warns about an unapplied (orphan) overlay
 * and about a base that is no longer a complete standalone config.
 */
async function inspectConfigForDoctor(cwd: string): Promise<DoctorConfigHealth> {
  const basePath = userConfigPath(process.env);
  const localPath = userLocalConfigPath(process.env);
  const localExists = existsSync(localPath);
  const warnings: string[] = [];

  let loaded: LoadedDiffwardenConfig | undefined;
  try {
    loaded = await loadDiffwardenConfig({ cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      warnings,
      fatal: { message, diagnosis: await diagnoseConfigLayers(basePath, localPath) },
    };
  }

  if (localExists && loaded?.overlay === undefined) {
    // The overlay file exists but was not applied: a project config was selected, or no base
    // user config exists yet (an overlay only overlays).
    warnings.push(
      loaded === undefined || path.resolve(loaded.path) !== path.resolve(basePath)
        ? `A local overlay exists at ${localPath} but is not applied${
            loaded !== undefined
              ? ` — the project config at ${loaded.path} takes precedence`
              : ` — no base user config exists at ${basePath}. The overlay only overlays; run diffwarden init or sync your base config to activate it.`
          }`
        : `A local overlay exists at ${localPath} but was not applied`,
    );
  }

  if (loaded?.overlay !== undefined) {
    // The dotfiles contract is that the BASE stays a complete valid config on its own; enforce it
    // on the authoring host, where it is otherwise undetectable once the overlay papers over it.
    const standaloneIssue = await validateBaseStandalone(loaded.path);
    if (standaloneIssue !== undefined) {
      warnings.push(
        `Base config ${loaded.path} is not valid standalone (the overlay currently completes it); hosts without this overlay will fail to load it: ${standaloneIssue}`,
      );
    }
  }

  return {
    ...(loaded !== undefined
      ? {
          loaded,
          identity: {
            path: loaded.path,
            sha256: loaded.sha256,
            ...(loaded.overlay !== undefined
              ? { local: { path: loaded.overlay.path, sha256: loaded.overlay.sha256 } }
              : {}),
          },
        }
      : {}),
    warnings,
  };
}

/** Per-layer diagnosis for a failed config load: which file is broken and what fixes it. */
async function diagnoseConfigLayers(basePath: string, localPath: string): Promise<string[]> {
  const diagnosis: string[] = [];
  const baseIssue = existsSync(basePath) ? await validateBaseStandalone(basePath) : undefined;
  if (!existsSync(basePath)) {
    diagnosis.push(`Base config: none at ${basePath}`);
  } else {
    diagnosis.push(
      baseIssue === undefined
        ? `Base config ${basePath} is valid standalone`
        : `Base config ${basePath} is invalid standalone: ${baseIssue}`,
    );
  }

  if (!existsSync(localPath)) {
    return diagnosis;
  }
  try {
    const localRaw = JSON.parse(await readFile(localPath, "utf8")) as unknown;
    if (typeof localRaw !== "object" || localRaw === null || Array.isArray(localRaw)) {
      diagnosis.push(`Local overlay ${localPath} must be a JSON object`);
      return diagnosis;
    }
    diagnosis.push(`Local overlay ${localPath} is well-formed JSON`);
    const localReviewers = (localRaw as Record<string, unknown>).reviewers;
    if (Array.isArray(localReviewers) && existsSync(basePath) && baseIssue === undefined) {
      const baseIds = await readBaseReviewerIds(basePath);
      for (const reviewer of localReviewers) {
        if (
          typeof reviewer === "object" &&
          reviewer !== null &&
          typeof (reviewer as Record<string, unknown>).id === "string" &&
          !baseIds.has((reviewer as Record<string, unknown>).id as string) &&
          typeof (reviewer as Record<string, unknown>).engine !== "string"
        ) {
          diagnosis.push(
            `Local overlay reviewer "${(reviewer as Record<string, unknown>).id as string}" has no base entry to overlay (the base may have removed it); give it an engine or remove it from ${localPath}`,
          );
        }
      }
    }
  } catch (error) {
    diagnosis.push(
      `Local overlay ${localPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return diagnosis;
}

/** Parse + schema-validate a base config file alone; returns the issue text, or undefined when valid. */
async function validateBaseStandalone(basePath: string): Promise<string | undefined> {
  try {
    // Read + parse + schema without any overlay involvement.
    const raw = await readFile(basePath, "utf8");
    const data = JSON.parse(raw) as unknown;
    const parsed = diffwardenConfigSchema.safeParse(data);
    return parsed.success ? undefined : "schema validation failed";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function readBaseReviewerIds(basePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const raw = JSON.parse(await readFile(basePath, "utf8")) as Record<string, unknown>;
    if (Array.isArray(raw.reviewers)) {
      for (const reviewer of raw.reviewers) {
        if (
          typeof reviewer === "object" &&
          reviewer !== null &&
          typeof (reviewer as Record<string, unknown>).id === "string"
        ) {
          ids.add((reviewer as Record<string, unknown>).id as string);
        }
      }
    }
  } catch {
    // Unreadable base: no ids to compare against.
  }
  return ids;
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
  if (loaded === undefined) {
    return;
  }
  // A write to the local overlay is effective whenever the USER config is the loaded config —
  // the overlay merges into it at load time. Only a genuine project config shadows it, so never
  // flag the user base config itself as "a project config" after a local-overlay write.
  const loadedPath = path.resolve(loaded.path);
  if (
    loadedPath !== path.resolve(writtenPath) &&
    loadedPath !== path.resolve(userConfigPath(process.env))
  ) {
    process.stderr.write(
      `Note: a project config at ${loaded.path} takes precedence over ${writtenPath}; reviews run from this directory will not use reviewers added to the user config.\n`,
    );
  }
}

/**
 * After a BASE reviewer write: warn per written field the host-local overlay overrides (the base
 * write is inert on this host), and — whenever an overlay exists and the write touched `enabled` —
 * tip that enabled toggles are host-local by convention. Best-effort advisory on stderr, mirroring
 * warnIfProjectConfigShadows: it never fails the command and never touches --json stdout.
 */
async function warnIfLocalOverlayShadows(
  id: string,
  fields: string[],
  options: { touchesEnabled: boolean },
): Promise<void> {
  const localPath = userLocalConfigPath(process.env);
  if (!existsSync(localPath)) {
    return;
  }
  if (options.touchesEnabled) {
    process.stderr.write(
      `Tip: enabled toggles are host-local by convention — "--local" writes them to the un-synced overlay at ${localPath} instead of the synced base config.\n`,
    );
  }
  try {
    const raw = JSON.parse(await readFile(localPath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return;
    }
    const reviewers = (raw as Record<string, unknown>).reviewers;
    if (!Array.isArray(reviewers)) {
      return;
    }
    const entry = reviewers.find(
      (reviewer): reviewer is Record<string, unknown> =>
        typeof reviewer === "object" &&
        reviewer !== null &&
        (reviewer as Record<string, unknown>).id === id,
    );
    if (entry === undefined) {
      return;
    }
    const overriddenFields = fields.filter((field) => field !== "id" && field in entry);
    for (const field of overriddenFields) {
      process.stderr.write(
        `Note: "${field}" for reviewer "${id}" is overridden by ${localPath}; this edit does not change the effective value on this host. Re-run with --local to change it here.\n`,
      );
    }
  } catch {
    // Unreadable overlay: the load path reports it; a write advisory must not fail the command.
  }
}

/**
 * After `init` creates a base config: a pre-existing host overlay (fresh-host bootstrap order —
 * overlay first, dotfiles later) may not merge cleanly with the new base, e.g. a partial override
 * for a reviewer id the base does not define. init still succeeds, but every subsequent load
 * would fail — so say it NOW, not at the next command. Best-effort stderr advisory.
 */
async function warnIfOrphanOverlayConflicts(basePath: string): Promise<void> {
  const localPath = userLocalConfigPath(process.env);
  if (!existsSync(localPath)) {
    return;
  }
  let baseContent: string;
  let localContent: string;
  try {
    baseContent = await readFile(basePath, "utf8");
    localContent = await readFile(localPath, "utf8");
  } catch {
    // Unreadable layer: nothing to diagnose here; init's advisory must not fail the command.
    return;
  }
  try {
    validateConfigLayers(baseContent, localContent, basePath, localPath);
  } catch {
    process.stderr.write(
      `Warning: the existing local overlay at ${localPath} does not merge cleanly with the new config at ${basePath}; diffwarden will fail to load until one of them is fixed. Run diffwarden doctor for a diagnosis.\n`,
    );
  }
}

/** After a BASE reviewer-set write: warn when the local overlay defines the same set name (which replaces it wholesale on this host). */
async function warnIfLocalSetShadows(setName: string): Promise<void> {
  const localPath = userLocalConfigPath(process.env);
  if (!existsSync(localPath)) {
    return;
  }
  try {
    const raw = JSON.parse(await readFile(localPath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return;
    }
    const sets = (raw as Record<string, unknown>).reviewerSets;
    if (
      typeof sets === "object" &&
      sets !== null &&
      !Array.isArray(sets) &&
      Object.prototype.hasOwnProperty.call(sets, setName)
    ) {
      process.stderr.write(
        `Note: reviewer set "${setName}" is overridden wholesale by ${localPath}; this edit does not change its membership on this host.\n`,
      );
    }
  } catch {
    // Best-effort advisory only.
  }
}

async function runInitDiscover(options: {
  cwd: string;
  json?: boolean;
  interactive: boolean;
}): Promise<void> {
  const result = await discoverReviewers({ cwd: options.cwd, env: process.env });
  const discovered = selectDiscoveredReviewers(result.candidates);
  if (discovered.length === 0) {
    throw invalidCli(
      "No usable reviewers found on this host. Run diffwarden reviewers discover to see options, install or authenticate an engine, then retry, or run diffwarden init --json to write a static starter config without discovery.",
    );
  }

  let reviewers = discovered;
  if (options.interactive) {
    if (!isInteractiveAvailable(process.stdin)) {
      throw invalidCli("--interactive requires an interactive terminal (TTY)");
    }
    // The picker uses @clack/prompts (raw-mode), reached only behind this TTY gate so agents/--json
    // never construct it; clack renders to stderr, keeping stdout clean for the result line.
    const sculpted = await runClackReviewerSetup({
      ready: discovered,
      candidates: result.candidates,
      configPath: userConfigPath(process.env),
    });
    if (sculpted === undefined || sculpted.length === 0) {
      process.stdout.write("Aborted.\n");
      return;
    }
    reviewers = sculpted;
  }

  // --cwd scopes discovery (the host probe above); the scaffold always writes the env-located
  // user config by design (decision: always user, never project), not a cwd-relative file.
  const configPath = await createDiscoveredUserConfig({ reviewers, env: process.env });
  await warnIfOrphanOverlayConflicts(configPath);
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
  const { overlay } = loadedConfig;
  return {
    schema_version: 2,
    config: {
      path: loadedConfig.path,
      sha256: loadedConfig.sha256,
      ...(overlay !== undefined ? { local: { path: overlay.path, sha256: overlay.sha256 } } : {}),
    },
    ...(overlay !== undefined
      ? {
          localOverrides: overlay.reviewerOverrides,
          localOnlyReviewers: overlay.appendedReviewerIds,
        }
      : {}),
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
    ...(summary.config.local !== undefined ? [`Local overlay: ${summary.config.local.path}`] : []),
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
    const localOnly = new Set(summary.localOnlyReviewers ?? []);
    const overrides = summary.localOverrides ?? {};
    lines.push("| ID | Engine | Enabled | Profile | Transport | Provider | Model | Effort |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    const footnotes: string[] = [];
    for (const reviewer of summary.reviewers) {
      const marker = localOnly.has(reviewer.id)
        ? " +"
        : (overrides[reviewer.id]?.length ?? 0) > 0
          ? " *"
          : "";
      if (localOnly.has(reviewer.id)) {
        footnotes.push(`+ ${reviewer.id}: defined only in the local overlay`);
      } else if ((overrides[reviewer.id]?.length ?? 0) > 0) {
        footnotes.push(
          `* ${reviewer.id}: fields overridden by the local overlay: ${(overrides[reviewer.id] ?? []).join(", ")}`,
        );
      }
      const row = [
        `${reviewer.id}${marker}`,
        reviewer.engine,
        reviewer.enabled ? "yes" : "no",
        reviewer.profile ?? "",
        reviewer.transport,
        reviewer.provider ?? "",
        displayModelValue(reviewer.model),
        reviewer.effort ?? "",
      ]
        .map(escapeMarkdownTable)
        .join(" | ");
      lines.push(`| ${row} |`);
    }
    lines.push("");
    if (footnotes.length > 0) {
      lines.push(...footnotes, "");
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Model ids that read as plain slugs render bare; anything else (provider aliases like
 * `opus[1m]`) is wrapped in ⟨…⟩ so it reads as a literal id, not leaked terminal noise (F3).
 */
function displayModelValue(model: string | undefined): string {
  if (model === undefined) {
    return "";
  }
  return /^[a-z0-9._/:@-]+$/i.test(model) ? model : `⟨${model}⟩`;
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

  const failure = reviewFailureArtifactSchema.safeParse(parsedJson);
  if (failure.success) {
    throw invalidCli(
      `Artifact records a failed run, not a review result: ${failure.data.error.message}`,
    );
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
