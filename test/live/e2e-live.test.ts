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

function liveE2eConfigJson(reviewers: string[]): string {
  const configReviewers = reviewers.map((reviewer) => {
    const executable = liveExecutable(reviewer);
    return {
      id: liveReviewerId(reviewer),
      sdk: reviewer,
      transport: "cli",
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

function liveExecutable(reviewer: string): string | undefined {
  return process.env[`DIFFWARDEN_LIVE_${reviewer.toUpperCase()}_EXECUTABLE`];
}

function liveReviewerId(reviewer: string): string {
  return `live-${reviewer}`;
}

function isSuccessfulReviewer(reviewer: { status?: string }): boolean {
  return reviewer.status !== "failed";
}
