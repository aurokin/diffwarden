import { describe, expect, it } from "vitest";
import { getReviewerCapability, reviewerSdkValues } from "../src/adapters/capabilities.js";
import {
  type DiscoveryProbes,
  type ReviewerDiscoveryCandidate,
  classifyPresentCandidate,
  discoverReviewers,
  renderReviewerDiscoveryText,
} from "../src/core/discovery.js";
import type { ReviewerPreflightReport } from "../src/core/runner.js";

const HOME = "/home/test";

function fakeProbes(present: {
  execs?: string[];
  pkgs?: string[];
  files?: string[];
}): DiscoveryProbes {
  const execs = new Set(present.execs ?? []);
  const pkgs = new Set(present.pkgs ?? []);
  const files = new Set(present.files ?? []);
  return {
    resolveExecutable: async (name) => (execs.has(name) ? `/usr/bin/${name}` : undefined),
    resolvePackage: (pkg) => pkgs.has(pkg),
    fileReadable: async (filePath) => files.has(filePath),
  };
}

function candidate(
  result: { candidates: ReviewerDiscoveryCandidate[] },
  engine: string,
  transport: string,
): ReviewerDiscoveryCandidate | undefined {
  return result.candidates.find((c) => c.engine === engine && c.transport === transport);
}

function expectedCandidateCount(): number {
  return reviewerSdkValues
    .filter((sdk) => sdk !== "fake")
    .reduce((total, sdk) => {
      const transports = getReviewerCapability(sdk).transports;
      return total + Object.values(transports).filter((t) => t?.supported === true).length;
    }, 0);
}

describe("classifyPresentCandidate", () => {
  it("treats an engine with no auth surface as ready", () => {
    expect(
      classifyPresentCandidate(undefined, { envPresent: false, credentialFilePresent: false }),
    ).toMatchObject({ status: "available", authState: "not_required" });
  });

  it("verifies via a present env var", () => {
    expect(
      classifyPresentCandidate(
        { envVars: ["CURSOR_API_KEY"] },
        { envPresent: true, credentialFilePresent: false },
      ),
    ).toMatchObject({ status: "available", authState: "verified" });
  });

  it("verifies via a readable credential file", () => {
    expect(
      classifyPresentCandidate(
        { credentialFile: { homeSubdir: ".codex", file: "auth.json" } },
        { envPresent: false, credentialFilePresent: true },
      ),
    ).toMatchObject({ status: "available", authState: "verified" });
  });

  it("flags requires_env for an optional env var that is absent", () => {
    expect(
      classifyPresentCandidate(
        { envVars: ["FACTORY_API_KEY"], envVarsOptional: true, loginDelegated: true },
        { envPresent: false, credentialFilePresent: false },
      ),
    ).toMatchObject({ status: "requires_env", authState: "unverified" });
  });

  it("reports login-delegated engines as present but unverified", () => {
    expect(
      classifyPresentCandidate(
        { envVars: ["CURSOR_API_KEY"], loginDelegated: true },
        { envPresent: false, credentialFilePresent: false },
      ),
    ).toMatchObject({ status: "available", authState: "unverified" });
  });

  it("ignores delegated login when it does not apply to the transport", () => {
    expect(
      classifyPresentCandidate(
        { envVars: ["CURSOR_API_KEY"], loginDelegated: true },
        { envPresent: false, credentialFilePresent: false },
        false,
      ),
    ).toMatchObject({ status: "missing_auth", authState: "missing" });
  });

  it("reports missing_auth when a required signal is absent with no delegated fallback", () => {
    expect(
      classifyPresentCandidate(
        { envVars: ["SOME_KEY"] },
        { envPresent: false, credentialFilePresent: false },
      ),
    ).toMatchObject({ status: "missing_auth", authState: "missing" });
    expect(
      classifyPresentCandidate(
        { credentialFile: { baseEnvVar: "CODEX_HOME", homeSubdir: ".codex", file: "auth.json" } },
        { envPresent: false, credentialFilePresent: false },
      ),
    ).toMatchObject({ status: "missing_auth", authState: "missing" });
  });
});

describe("discoverReviewers (shallow)", () => {
  it("enumerates every non-fake engine transport and excludes fake", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({}),
    });

    expect(result.schema_version).toBe(1);
    expect(result.deep).toBe(false);
    expect(result.candidates.length).toBe(expectedCandidateCount());
    expect(result.candidates.some((c) => c.engine === "fake")).toBe(false);
  });

  it("marks everything missing when nothing is installed", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({}),
    });

    expect(result.candidates.every((c) => c.status === "missing_executable")).toBe(true);
    expect(result.summary.available).toEqual([]);
    expect(result.summary.missing.length).toBe(result.candidates.length);
    expect(result.candidates.every((c) => c.recommended === undefined)).toBe(true);
  });

  it("classifies codex available when the executable and auth.json are present", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ execs: ["codex"], files: [`${HOME}/.codex/auth.json`] }),
    });

    const codexCli = candidate(result, "codex", "cli");
    expect(codexCli).toMatchObject({ status: "available", authState: "verified" });
    expect(codexCli?.recommended).toEqual({ id: "codex", engine: "codex" });
    expect(result.summary.available).toContain("codex:cli");
  });

  it("honors CODEX_HOME when resolving the codex credential file", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: { CODEX_HOME: "/custom/codex" },
      homeDir: HOME,
      probes: fakeProbes({ execs: ["codex"], files: ["/custom/codex/auth.json"] }),
    });

    expect(candidate(result, "codex", "cli")).toMatchObject({
      status: "available",
      authState: "verified",
    });
  });

  it("classifies codex missing_auth when auth.json is absent", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ execs: ["codex"] }),
    });

    const codexCli = candidate(result, "codex", "cli");
    expect(codexCli?.status).toBe("missing_auth");
    expect(codexCli?.recommended).toBeUndefined();
    expect(result.summary.needsAttention).toContain("codex:cli");
  });

  it("verifies opencode when its auth.json is present, else delegated-unverified", async () => {
    const verified = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({
        execs: ["opencode"],
        files: [`${HOME}/.local/share/opencode/auth.json`],
      }),
    });
    expect(candidate(verified, "opencode", "cli")).toMatchObject({
      status: "available",
      authState: "verified",
    });

    const unverified = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ execs: ["opencode"] }),
    });
    expect(candidate(unverified, "opencode", "cli")).toMatchObject({
      status: "available",
      authState: "unverified",
    });
  });

  it("classifies droid requires_env without FACTORY_API_KEY and available with it", async () => {
    const without = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ execs: ["droid"] }),
    });
    expect(candidate(without, "droid", "cli")).toMatchObject({
      status: "requires_env",
      authState: "unverified",
    });

    const withKey = await discoverReviewers({
      cwd: "/repo",
      env: { FACTORY_API_KEY: "secret" },
      homeDir: HOME,
      probes: fakeProbes({ execs: ["droid"] }),
    });
    expect(candidate(withKey, "droid", "cli")).toMatchObject({
      status: "available",
      authState: "verified",
    });
  });

  it("reports a login-delegated cli engine as available-unverified without credentials", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ execs: ["cursor-agent"] }),
    });

    const cursorCli = candidate(result, "cursor", "cli");
    expect(cursorCli).toMatchObject({ status: "available", authState: "unverified" });
    expect(cursorCli?.recommended).toEqual({
      id: "cursor-cli",
      engine: "cursor",
      transport: "cli",
      model: "composer-2.5",
    });
  });

  it("treats the Cursor SDK as missing_auth without the key but the CLI as delegated", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ pkgs: ["@cursor/sdk"], execs: ["cursor-agent"] }),
    });

    // SDK needs CURSOR_API_KEY: no delegated fallback, so it must not look ready to scaffold.
    expect(candidate(result, "cursor", "sdk")).toMatchObject({ status: "missing_auth" });
    expect(candidate(result, "cursor", "sdk")?.recommended).toBeUndefined();
    // CLI keeps its delegated login.
    expect(candidate(result, "cursor", "cli")).toMatchObject({
      status: "available",
      authState: "unverified",
    });
  });

  it("recommends a minimal entry for the primary (sdk) transport", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: { CURSOR_API_KEY: "secret" },
      homeDir: HOME,
      probes: fakeProbes({ pkgs: ["@cursor/sdk"] }),
    });

    const cursorSdk = candidate(result, "cursor", "sdk");
    expect(cursorSdk).toMatchObject({ status: "available", authState: "verified" });
    expect(cursorSdk?.recommended).toEqual({
      id: "cursor",
      engine: "cursor",
      model: "composer-2.5",
    });
  });

  it("reports probed auth signals (env var names and credential paths, no values)", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: { CODEX_HOME: "/custom/codex", CURSOR_API_KEY: "secret" },
      homeDir: HOME,
      probes: fakeProbes({ execs: ["codex", "cursor-agent"], files: ["/custom/codex/auth.json"] }),
    });

    // Credential-file engine: path is the canonical ~ location plus the base env var hint.
    expect(candidate(result, "codex", "cli")?.authSignals).toEqual({
      credentialFile: { path: "~/.codex/auth.json", baseEnvVar: "CODEX_HOME" },
    });
    // Env-var engine: names only.
    expect(candidate(result, "cursor", "cli")?.authSignals?.envVars).toContain("CURSOR_API_KEY");
    // Secret values never appear anywhere in the serialized result.
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("never emits nested option bags in candidates", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: { CURSOR_API_KEY: "secret" },
      homeDir: HOME,
      probes: fakeProbes({ execs: ["cursor-agent"], pkgs: ["@cursor/sdk"] }),
    });

    for (const c of result.candidates) {
      expect(c).not.toHaveProperty("cliOptions");
      expect(c).not.toHaveProperty("sdkOptions");
      expect(c).not.toHaveProperty("providerOptions");
    }
  });

  it("orders candidates verified-first, then engine A→Z, then transport", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      // codex/gemini/opencode/antigravity have readable credential files (verified); grok is
      // present but login-delegated with no positive signal (available, but unverified).
      probes: fakeProbes({
        execs: ["codex", "gemini", "opencode", "grok", "agy"],
        files: [
          `${HOME}/.codex/auth.json`,
          `${HOME}/.gemini/oauth_creds.json`,
          `${HOME}/.local/share/opencode/auth.json`,
        ],
      }),
    });

    const available = result.candidates
      .filter((c) => c.status === "available")
      .map((c) => `${c.engine}:${c.transport}`);

    // Verified engines first (alphabetical, codex cli before app-server), then the unverified grok.
    expect(available).toEqual([
      "antigravity:cli",
      "codex:cli",
      "codex:app-server",
      "gemini:cli",
      "opencode:cli",
      "grok:cli",
    ]);
    // The JSON summary derives from the same sorted candidates.
    expect(result.summary.available).toEqual(available);
  });
});

describe("discoverReviewers (deep)", () => {
  function reportWith(reviewer: {
    engine: string;
    transport: "native" | "cli" | "app-server";
    status: "passed" | "failed";
    code?: string;
    message?: string;
  }): ReviewerPreflightReport {
    return {
      schema_version: 2,
      cwd: "/repo",
      timing_ms: 0,
      reviewers: [
        {
          id: reviewer.engine,
          engine: reviewer.engine as ReviewerPreflightReport["reviewers"][number]["engine"],
          status: reviewer.status,
          transport: reviewer.transport,
          timing_ms: 0,
          ...(reviewer.code !== undefined
            ? { error: { code: reviewer.code, message: reviewer.message ?? "" } }
            : {}),
        },
      ],
    };
  }

  it("overrides a shallow verdict with a failed preflight (missing_auth)", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      deep: true,
      probes: fakeProbes({ execs: ["codex"], files: [`${HOME}/.codex/auth.json`] }),
      deepPreflight: async () =>
        reportWith({ engine: "codex", transport: "cli", status: "failed", code: "missing_auth" }),
    });

    expect(result.deep).toBe(true);
    const codexCli = candidate(result, "codex", "cli");
    expect(codexCli?.status).toBe("missing_auth");
    expect(codexCli?.recommended).toBeUndefined();
  });

  it("maps a reviewer_environment_failed preflight to unsupported_host", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: { CURSOR_API_KEY: "secret" },
      homeDir: HOME,
      deep: true,
      probes: fakeProbes({ execs: ["cursor-agent"] }),
      deepPreflight: async () =>
        reportWith({
          engine: "cursor",
          transport: "cli",
          status: "failed",
          code: "reviewer_environment_failed",
          message: "sandboxing is not supported",
        }),
    });

    expect(candidate(result, "cursor", "cli")?.status).toBe("unsupported_host");
  });

  it("keeps shallow missing_auth even when an auth-blind CLI preflight passes", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      deep: true,
      // codex on PATH but no ~/.codex/auth.json => shallow missing_auth.
      probes: fakeProbes({ execs: ["codex"] }),
      // Codex CLI preflight only checks the executable, so it "passes" without verifying auth.
      deepPreflight: async () =>
        reportWith({ engine: "codex", transport: "cli", status: "passed" }),
    });

    const codexCli = candidate(result, "codex", "cli");
    expect(codexCli?.status).toBe("missing_auth");
    expect(codexCli?.recommended).toBeUndefined();
  });

  it("preflights each present transport, not one collapsed entry per engine", async () => {
    const seenTargets: { engine: string; transport: string }[] = [];
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      deep: true,
      // codex exposes both cli and app-server; both are present here.
      probes: fakeProbes({ execs: ["codex"], files: [`${HOME}/.codex/auth.json`] }),
      deepPreflight: async (targets) => {
        seenTargets.push(...targets);
        return {
          schema_version: 2,
          cwd: "/repo",
          timing_ms: 0,
          reviewers: [
            { id: "codex-cli", engine: "codex", status: "passed", transport: "cli", timing_ms: 0 },
            {
              id: "codex-app-server",
              engine: "codex",
              status: "failed",
              transport: "app-server",
              timing_ms: 0,
              error: { code: "reviewer_environment_failed", message: "no socket" },
            },
          ],
        };
      },
    });

    // The non-default transport is offered to deep preflight, not collapsed away.
    expect(seenTargets).toContainEqual({ engine: "codex", transport: "cli" });
    expect(seenTargets).toContainEqual({ engine: "codex", transport: "app-server" });
    // Each transport gets its own verdict.
    expect(candidate(result, "codex", "cli")?.status).toBe("available");
    expect(candidate(result, "codex", "app-server")?.status).toBe("unsupported_host");
  });

  it("confirms availability and keeps verified auth when a verified candidate passes", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: { CURSOR_API_KEY: "secret" },
      homeDir: HOME,
      deep: true,
      probes: fakeProbes({ execs: ["cursor-agent"] }),
      deepPreflight: async () =>
        reportWith({ engine: "cursor", transport: "cli", status: "passed" }),
    });

    const cursorCli = candidate(result, "cursor", "cli");
    expect(cursorCli).toMatchObject({ status: "available", authState: "verified" });
    expect(cursorCli?.recommended).toBeDefined();
  });

  it("does not fabricate verified auth when a pass did not check delegated login", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      deep: true,
      // opencode declares only loginDelegated, so shallow is available/unverified and the
      // CLI preflight skips auth: a pass must keep authState unverified, not claim verified.
      probes: fakeProbes({ execs: ["opencode"] }),
      deepPreflight: async () =>
        reportWith({ engine: "opencode", transport: "cli", status: "passed" }),
    });

    const opencodeCli = candidate(result, "opencode", "cli");
    expect(opencodeCli?.status).toBe("available");
    expect(opencodeCli?.authState).toBe("unverified");
  });
});

describe("renderReviewerDiscoveryText", () => {
  it("renders grouped status rows without ANSI when color is disabled", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ execs: ["codex"], files: [`${HOME}/.codex/auth.json`] }),
    });

    const text = renderReviewerDiscoveryText(result, { color: false });
    expect(text).toContain("Diffwarden reviewer discovery");
    expect(text).toContain("Ready to use");
    expect(text).toContain("Needs attention");
    expect(text).toContain("Not installed");
    expect(text).toContain("codex");
    expect(text).toContain("--deep");
    // Plain text only: no ANSI escape sequences when color is disabled.
    expect(text).not.toContain(String.fromCharCode(27));
  });

  it("emits ANSI presentation when color is enabled", async () => {
    const result = await discoverReviewers({
      cwd: "/repo",
      env: {},
      homeDir: HOME,
      probes: fakeProbes({ execs: ["codex"], files: [`${HOME}/.codex/auth.json`] }),
    });

    expect(renderReviewerDiscoveryText(result, { color: true })).toContain(String.fromCharCode(27));
  });
});
