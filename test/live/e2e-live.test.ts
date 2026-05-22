import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enabledIntegrationItems, isIntegrationDisabled } from "../integration.js";
import {
  type LiveFixture,
  createLiveFixture,
  expectFixtureReadOnly,
  expectLiveArtifact,
  runBuiltDiffwarden,
} from "./helpers.js";

let fixture: LiveFixture | undefined;
let configHome: string | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  if (configHome !== undefined) {
    rmSync(configHome, { force: true, recursive: true });
    configHome = undefined;
  }
});

describe("live diffwarden CLI e2e", () => {
  it("passes live reviewer overrides into generated config", () => {
    const parsed = JSON.parse(
      liveE2eConfigJson(["droid"], {
        DIFFWARDEN_LIVE_DROID_PROVIDER: "factory",
        DIFFWARDEN_LIVE_DROID_MODEL: "claude-opus-4-7",
        DIFFWARDEN_LIVE_DROID_EFFORT: "high",
        DIFFWARDEN_LIVE_DROID_EXECUTABLE: "/opt/droid",
      }),
    );

    expect(parsed.reviewers).toEqual([
      {
        id: "live-droid",
        sdk: "droid",
        transport: "cli",
        provider: "factory",
        model: "claude-opus-4-7",
        effort: "high",
        cliOptions: {
          executable: "/opt/droid",
        },
      },
    ]);
  });

  it.skipIf(isIntegrationDisabled("e2e") || liveE2eReviewers().length === 0)(
    "runs selected live reviewers through the built binary",
    async () => {
      const reviewers = liveE2eReviewers();
      const reviewerSpecs = reviewers.map(liveReviewerId);
      fixture = createLiveFixture("diffwarden-live-e2e-");
      configHome = createLiveConfigHome(reviewers);
      const result = await runBuiltDiffwarden(
        fixture.repo,
        [
          "--target",
          "uncommitted",
          "--cwd",
          fixture.repo,
          "--format",
          "json",
          "--strict",
          ...reviewerSpecs.flatMap((reviewer) => ["--reviewer", reviewer]),
        ],
        {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
        },
      );
      const artifact = JSON.parse(result.stdout);

      expect(result.stderr).toBe("");
      expectLiveArtifact(artifact);
      expect(artifact.reviewers).toHaveLength(reviewers.length);
      expect(artifact.reviewers.every(isSuccessfulReviewer)).toBe(true);
      expectFixtureReadOnly(fixture.repo);
    },
    240_000,
  );
});

function liveE2eReviewers(): string[] {
  const requested = (process.env.DIFFWARDEN_LIVE_E2E_REVIEWERS ?? "")
    .split(",")
    .map((reviewer) => reviewer.trim())
    .filter((reviewer) => reviewer.length > 0);
  return enabledIntegrationItems(requested);
}

function liveE2eConfigJson(reviewers: string[], env: NodeJS.ProcessEnv = process.env): string {
  const configReviewers = reviewers.map((reviewer) => {
    const executable = liveEnv(reviewer, "EXECUTABLE", env);
    return {
      id: liveReviewerId(reviewer),
      sdk: reviewer,
      transport: "cli",
      ...optionalString("provider", liveEnv(reviewer, "PROVIDER", env)),
      ...optionalString("model", liveEnv(reviewer, "MODEL", env)),
      ...optionalString("effort", liveEnv(reviewer, "EFFORT", env)),
      ...(executable === undefined
        ? {}
        : {
            cliOptions: {
              executable,
            },
          }),
    };
  });
  return `${JSON.stringify({ reviewers: configReviewers }, null, 2)}\n`;
}

function createLiveConfigHome(reviewers: string[]): string {
  const home = mkdtempSync(path.join(tmpdir(), "diffwarden-live-config-"));
  const configDirectory = path.join(home, "diffwarden");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(path.join(configDirectory, "diffwarden.config.json"), liveE2eConfigJson(reviewers));
  return home;
}

function liveEnv(
  reviewer: string,
  suffix: "PROVIDER" | "MODEL" | "EFFORT" | "EXECUTABLE",
  env: NodeJS.ProcessEnv,
): string | undefined {
  return env[`DIFFWARDEN_LIVE_${reviewer.toUpperCase()}_${suffix}`];
}

function liveReviewerId(reviewer: string): string {
  return `live-${reviewer}`;
}

function optionalString<K extends "provider" | "model" | "effort">(
  key: K,
  value: string | undefined,
): Pick<{ provider: string; model: string; effort: string }, K> | Record<string, never> {
  return value === undefined || value.trim() === ""
    ? {}
    : ({ [key]: value } as Pick<{ provider: string; model: string; effort: string }, K>);
}

function isSuccessfulReviewer(reviewer: { status?: string }): boolean {
  return reviewer.status !== "failed";
}
