import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ReviewerSdk,
  type ReviewerTransport,
  getTransportCapability,
  reviewerCapabilities,
  reviewerSdkValues,
} from "../src/adapters/capabilities.js";
import { claudeCliReviewPolicyCliFlags } from "../src/adapters/claude-tool-policy.js";
import { createCliAdapter } from "../src/adapters/cli.js";
import { copilotCliReviewPolicyCliFlags } from "../src/adapters/copilot-tool-policy.js";
import {
  droidCliReviewAllowedTools,
  droidCliReviewPolicyCliFlags,
} from "../src/adapters/droid-tool-policy.js";
import { geminiCliReviewPolicyCliFlags } from "../src/adapters/gemini-tool-policy.js";
import { grokCliReviewPolicyCliFlags } from "../src/adapters/grok-tool-policy.js";
import type { ReviewReviewerConfig } from "../src/adapters/types.js";
import { resolveReviewerConfig } from "../src/core/reviewer.js";

type CliEngine = Exclude<ReviewerSdk, "fake">;
type ConfigurableReviewerSdk = Exclude<ReviewerSdk, "fake">;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
  roots.length = 0;
});

describe("adapter capability contract", () => {
  it("has a capability entry for every declared reviewer sdk", () => {
    for (const sdk of reviewerSdkValues) {
      expect(reviewerCapabilities[sdk]).toMatchObject({ sdk });
    }
  });

  it("uses supported default transports and models during reviewer resolution", () => {
    for (const sdk of reviewerSdkValues) {
      const capability = reviewerCapabilities[sdk];
      const resolved = resolveReviewerConfig({ spec: sdk });

      expect(resolved.sdk).toBe(sdk);
      expect(resolved.transport).toBe(capability.defaultTransport);
      expect(resolved.model).toBe(capability.defaultModel);

      if (capability.defaultTransport !== undefined) {
        expect(capability.transports[capability.defaultTransport]?.supported).toBe(true);
      }
    }
  });

  it("rejects unsupported model and effort overrides from capability metadata", () => {
    for (const sdk of reviewerSdkValues) {
      if (sdk === "fake") {
        continue;
      }
      for (const [transport, capability] of Object.entries(reviewerCapabilities[sdk].transports)) {
        if (!capability.supported) {
          continue;
        }

        const config = configuredReviewer(sdk, transport as ReviewerTransport);
        const spec = config.reviewers[0]?.id;
        if (spec === undefined) {
          throw new Error(`missing reviewer fixture for ${sdk}:${transport}`);
        }

        if (transport !== "cli") {
          continue;
        }

        if (!capability.supportsModel) {
          expect(() => resolveReviewerConfig({ spec, model: "test-model", config })).toThrow(
            `${sdk} CLI transport does not support per-run model overrides`,
          );
        }

        if (!capability.supportsEffort) {
          expect(() => resolveReviewerConfig({ spec, effort: "high", config })).toThrow(
            `${sdk} CLI transport does not support per-run effort overrides`,
          );
        }
      }
    }
  });

  it("reports CLI preflight read-only metadata from capability metadata", async () => {
    for (const engine of cliEngines()) {
      const capability = getTransportCapability(engine, "cli");
      if (capability === undefined || capability.defaultExecutable === undefined) {
        throw new Error(`missing CLI capability for ${engine}`);
      }

      const harness = createCliHarness(capability.defaultExecutable);
      const adapter = createCliAdapter(engine);
      const reviewer: ReviewReviewerConfig = {
        id: engine,
        sdk: engine,
        transport: "cli",
        readonly: true,
      };

      const preflight = await adapter.preflight?.({
        cwd: harness.cwd,
        reviewer,
        readonly: true,
        env: harness.env,
      });

      expect(preflight?.metadata).toMatchObject({
        readonlyCapability: capability.readonlyCapability,
        transport: "cli",
        executable: harness.executable,
      });
      expect(preflight?.checks.find((check) => check.name === "readonly")).toMatchObject({
        status: capability.readonlyCapability === "prompt-only" ? "warning" : "passed",
      });
    }
  });

  it("documents every supported adapter path in the feature matrix", () => {
    const featureMatrix = readFileSync(path.join(process.cwd(), "docs/features.md"), "utf8");

    for (const sdk of reviewerSdkValues) {
      if (sdk === "fake") {
        expect(featureMatrix).toContain("| `fake` |");
        continue;
      }

      for (const [transport, capability] of Object.entries(reviewerCapabilities[sdk].transports)) {
        if (!capability.supported) {
          continue;
        }
        expect(featureMatrix).toContain(`| \`${sdk}\` ${transport.toUpperCase()} |`);
      }
    }
  });
});

function configuredReviewer(sdk: ConfigurableReviewerSdk, transport: ReviewerTransport) {
  return {
    reviewers: [
      {
        id: `${sdk}-${transport}`,
        sdk,
        transport,
      },
    ],
  };
}

function cliEngines(): CliEngine[] {
  return reviewerSdkValues.filter((sdk): sdk is CliEngine => sdk !== "fake");
}

function createCliHarness(defaultExecutable: string) {
  const root = mkdtempSync(path.join(tmpdir(), "diffwarden-adapter-contract-"));
  roots.push(root);
  const cwd = path.join(root, "repo");
  const bin = path.join(root, "bin");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, defaultExecutable);
  writeFileSync(executable, fakeCliContractScript(), "utf8");
  chmodSync(executable, 0o755);

  return {
    cwd,
    executable,
    env: {
      PATH: bin,
    },
  };
}

function fakeCliContractScript(): string {
  return `#!/bin/sh
executable="\${0##*/}"
for arg in "$@"; do
  if [ "$executable" = "droid" ] && [ "$arg" = "--list-tools" ]; then
    printf '%s' ${JSON.stringify(
      JSON.stringify([...droidCliReviewAllowedTools].map((id) => ({ id, currentlyAllowed: true }))),
    )}
    exit 0
  fi
  if [ "$executable" = "agy" ] && [ "$arg" = "--version" ]; then
    printf '%s' '1.0.6'
    exit 0
  fi
  if [ "$arg" != "--help" ]; then
    continue
  fi
  if [ "$executable" = "claude" ]; then
    printf '%s' '${claudeCliReviewPolicyCliFlags.join(" ")}'
  elif [ "$executable" = "droid" ]; then
    printf '%s' '${droidCliReviewPolicyCliFlags.join(" ")}'
  elif [ "$executable" = "copilot" ]; then
    printf '%s' '${copilotCliReviewPolicyCliFlags.join(" ")}'
  elif [ "$executable" = "gemini" ]; then
    printf '%s' '${geminiCliReviewPolicyCliFlags.join(" ")}'
  elif [ "$executable" = "grok" ]; then
    printf '%s' '${grokCliReviewPolicyCliFlags.join(" ")}'
  fi
  break
done
exit 0
`;
}
