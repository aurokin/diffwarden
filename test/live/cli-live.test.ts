import { afterEach, describe, expect, it } from "vitest";
import { createCliAdapter } from "../../src/adapters/cli.js";
import type { ReviewReviewerConfig } from "../../src/adapters/types.js";
import { isLiveCliDisabled } from "../integration.js";
import {
  type LiveFixture,
  createLiveAdapterInput,
  createLiveFixture,
  expectFixtureReadOnly,
  expectLiveAdapterOutput,
} from "./helpers.js";

type CliEngine = Exclude<ReviewReviewerConfig["sdk"], "fake">;

const cliEngines = [
  "codex",
  "claude",
  "cursor",
  "gemini",
  "opencode",
  "pi",
  "grok",
  "antigravity",
] as const satisfies readonly CliEngine[];

let fixture: LiveFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("live CLI adapters", () => {
  for (const engine of cliEngines) {
    it.skipIf(isLiveCliDisabled(engine))(
      `runs a live ${engine} CLI review without modifying the fixture`,
      async () => {
        fixture = createLiveFixture(`diffwarden-live-${engine}-`);
        const reviewer = liveCliReviewer(engine);
        const adapter = createCliAdapter(engine);
        const preflight = await adapter.preflight?.({
          cwd: fixture.repo,
          reviewer,
          readonly: true,
          env: process.env,
        });
        const output = await adapter.run(await createLiveAdapterInput(fixture, reviewer));

        expect(preflight?.metadata?.transport).toBe("cli");
        expect(output.metadata?.transport).toBe("cli");
        expectLiveAdapterOutput(output);
        expectFixtureReadOnly(fixture.repo);
      },
      180_000,
    );
  }
});

function liveCliReviewer(engine: CliEngine): ReviewReviewerConfig {
  return {
    id: `${engine}-cli-live`,
    sdk: engine,
    transport: "cli",
    readonly: true,
    ...optionalString("provider", liveEnv(engine, "PROVIDER")),
    ...optionalString("model", liveEnv(engine, "MODEL")),
    ...optionalString("effort", liveEnv(engine, "EFFORT")),
    ...cliOptions(liveEnv(engine, "EXECUTABLE")),
  };
}

function liveEnv(engine: CliEngine, suffix: string): string | undefined {
  return process.env[`DIFFWARDEN_LIVE_${engine.toUpperCase()}_${suffix}`];
}

function optionalString<K extends "provider" | "model" | "effort">(
  key: K,
  value: string | undefined,
): Pick<ReviewReviewerConfig, K> | Record<string, never> {
  return value === undefined || value.trim() === ""
    ? {}
    : ({ [key]: value } as Pick<ReviewReviewerConfig, K>);
}

function cliOptions(executable: string | undefined): Pick<ReviewReviewerConfig, "cliOptions"> {
  return executable === undefined || executable.trim() === "" ? {} : { cliOptions: { executable } };
}
