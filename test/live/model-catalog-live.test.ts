import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/adapters/claude.js";
import { codexAppServerListModels } from "../../src/adapters/codex-app-server.js";
import { copilotAdapter } from "../../src/adapters/copilot.js";
import { cursorAdapter } from "../../src/adapters/cursor.js";
import { droidAdapter } from "../../src/adapters/droid.js";
import { opencodeListModels } from "../../src/adapters/opencode.js";
import { piAdapter } from "../../src/adapters/pi.js";
import type {
  ListModelsInput,
  ModelCatalogEntry,
  ReviewReviewerConfig,
} from "../../src/adapters/types.js";
import { isIntegrationDisabled } from "../integration.js";

// Mirrors the config effort enum (src/core/config.ts) — the vocabulary catalog narrowing
// must stay inside.
const effortChoices = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Opt-in live catalog fetches: one per engine listing surface, asserting an authenticated
 * machine gets a non-empty catalog whose effort narrowing stays inside diffwarden's effort
 * vocabulary. Catalog listing spends no model budget, but it runs real engine
 * processes/logins, so it stays behind the same INTEGRATION_TEST_ON opt-in as other live
 * tests. Disable individual engines with INTEGRATION_DISABLE=<engine,...>.
 */

type LiveCatalog = {
  engine: string;
  /** Extra skip on top of the integration opt-in (e.g. an env-keyed auth surface). */
  skip?: boolean;
  list: (input: ListModelsInput) => Promise<ModelCatalogEntry[]>;
  reviewer: ReviewReviewerConfig;
};

// Copilot's fail-closed asserts reject a bundled runtime living inside the reviewed
// workspace, which is exactly where it lives when this repo IS the diffwarden checkout —
// so catalog fetches run from a neutral temp cwd, like a consumer install would.
let neutralCwd: string | undefined;

function catalogCwd(): string {
  neutralCwd ??= mkdtempSync(path.join(tmpdir(), "diffwarden-live-catalog-"));
  return neutralCwd;
}

afterEach(() => {
  if (neutralCwd !== undefined) {
    rmSync(neutralCwd, { force: true, recursive: true });
    neutralCwd = undefined;
  }
});

function reviewer(extra: Partial<ReviewReviewerConfig> & { sdk: ReviewReviewerConfig["sdk"] }) {
  return { id: `${extra.sdk}-catalog`, readonly: true, ...extra } as ReviewReviewerConfig;
}

function requireLister<T>(lister: T | undefined): T {
  expect(lister).toBeDefined();
  return lister as T;
}

const catalogs: LiveCatalog[] = [
  {
    engine: "claude",
    list: (input) => requireLister(claudeAdapter.listModels).call(claudeAdapter, input),
    reviewer: reviewer({ sdk: "claude" }),
  },
  {
    engine: "cursor",
    skip: !process.env.CURSOR_API_KEY,
    list: (input) => requireLister(cursorAdapter.listModels).call(cursorAdapter, input),
    reviewer: reviewer({ sdk: "cursor" }),
  },
  {
    engine: "cursor",
    list: (input) => requireLister(cursorAdapter.listModels).call(cursorAdapter, input),
    reviewer: reviewer({ sdk: "cursor", transport: "cli", id: "cursor-cli-catalog" }),
  },
  {
    engine: "codex",
    list: codexAppServerListModels,
    reviewer: reviewer({ sdk: "codex" }),
  },
  {
    engine: "opencode",
    list: opencodeListModels,
    reviewer: reviewer({ sdk: "opencode" }),
  },
  {
    engine: "pi",
    list: (input) => requireLister(piAdapter.listModels).call(piAdapter, input),
    reviewer: reviewer({ sdk: "pi" }),
  },
  {
    engine: "copilot",
    list: (input) => requireLister(copilotAdapter.listModels).call(copilotAdapter, input),
    reviewer: reviewer({ sdk: "copilot" }),
  },
  {
    engine: "droid",
    list: (input) => requireLister(droidAdapter.listModels).call(droidAdapter, input),
    reviewer: reviewer({ sdk: "droid" }),
  },
];

describe("live model catalogs", () => {
  for (const catalog of catalogs) {
    const transport = catalog.reviewer.transport ?? "default";
    it.skipIf(isIntegrationDisabled(catalog.engine) || catalog.skip === true)(
      `lists a non-empty live ${catalog.engine} catalog (${transport} transport)`,
      async () => {
        const models = await catalog.list({
          cwd: catalogCwd(),
          reviewer: catalog.reviewer,
          env: process.env,
        });

        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
          expect(model.value).toBeTruthy();
          for (const level of model.supportedEffortLevels ?? []) {
            // Narrowed levels must stay inside diffwarden's deliverable effort vocabulary.
            expect(effortChoices).toContain(level);
          }
        }
      },
      60_000,
    );
  }
});
