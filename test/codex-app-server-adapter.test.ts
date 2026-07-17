import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexAppServerListModels,
  codexModelCatalogEntries,
  createCodexAppServerAdapter,
} from "../src/adapters/codex-app-server.js";
import {
  codexAppServerDeveloperInstructions,
  codexAppServerExecEnabled,
  codexAppServerIsolatedDisableArgs,
  codexAppServerReviewThreadParams,
  codexAppServerTurnPermissionParams,
  codexNativeReviewEffectiveWebSearchReason,
  codexNativeReviewOutput,
  codexNativeReviewStructuredFindings,
} from "../src/adapters/codex-tool-policy.js";
import { deltaCoalescerBufferCapChars } from "../src/adapters/reviewer-activity.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";
import { reviewResultStrictJsonSchema } from "../src/core/schema.js";

let root: string | undefined;
const cleanupFns: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupFns.splice(0).reverse()) {
    await cleanup();
  }
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

describe("createCodexAppServerAdapter", () => {
  it("reuses an existing shared CODEX_HOME app-server by default", async () => {
    const harness = createSocketHarness();
    await harness.start();
    const adapter = createCodexAppServerAdapter();
    const reviewer: ReviewReviewerConfig = {
      id: "codex-app-server",
      sdk: "codex",
      transport: "app-server",
      readonly: true,
      cliOptions: {
        executable: process.execPath,
      },
    };

    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const output = await adapter.run({
      ...createInput(reviewer, harness),
      runContext: prepared?.runContext,
    });

    expect(prepared?.preflight?.metadata).toMatchObject({
      appServerMode: "auto",
      codexHome: harness.authHome,
      codexHomeShared: true,
      socketPath: harness.socketPath,
    });
    expect(prepared?.preflight?.checks).toContainEqual(
      expect.objectContaining({
        name: "codex-home",
        status: "warning",
      }),
    );
    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex app-server ok",
    });
    expect(output.metadata).toMatchObject({
      appServerMode: "auto",
      codexHome: harness.authHome,
      codexHomeShared: true,
      socketPath: harness.socketPath,
      serverLifecycle: "reused",
    });
    expect(harness.readInvocation().threadStart).toMatchObject({
      cwd: harness.cwd,
      developerInstructions: codexAppServerDeveloperInstructions,
      ...codexAppServerReviewThreadParams,
    });
    expect(harness.readInvocation().threadStart).not.toHaveProperty("dynamicTools");
  });

  it("uses the isolated auth source when preflighting stdio-isolated mode", async () => {
    const harness = createHarness();
    const otherHome = path.join(root ?? harness.cwd, "shared-codex-home-without-auth");
    mkdirSync(otherHome);
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable, {
      appServerOptions: {
        mode: "stdio-isolated",
        codexHome: otherHome,
      },
    });

    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: {
        ...harness.env,
        DIFFWARDEN_CODEX_HOME: otherHome,
        DIFFWARDEN_CODEX_AUTH_HOME: harness.authHome,
      },
    });

    expect(prepared?.preflight?.metadata).toMatchObject({
      appServerMode: "stdio-isolated",
      codexHome: otherHome,
      codexHomeShared: false,
    });
  });

  it("fails attach mode when the shared socket closes before upgrade", async () => {
    const harness = createBadSocketHarness((socket) => socket.end());
    await harness.start();
    const adapter = createCodexAppServerAdapter();
    const reviewer = createSharedReviewer(process.execPath, {
      mode: "attach",
      codexHome: harness.authHome,
    });

    await expect(adapter.run(createInput(reviewer, harness))).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("socket closed before upgrade completed"),
    });
  });

  it("runs Codex app-server with isolated ephemeral state and structured output", async () => {
    const harness = createHarness();
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable, {
      model: "gpt-test",
      effort: "minimal",
    });

    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const output = await adapter.run({
      ...createInput(reviewer, harness),
      runContext: prepared?.runContext,
    });
    const invocation = harness.readInvocation();

    expect(prepared).toBeDefined();
    if (prepared === undefined) {
      throw new Error("adapter did not return prepare result");
    }

    expect(prepared.preflight?.metadata).toMatchObject({
      transport: "app-server",
      readonlyCapability: "enforced",
      executable: harness.executable,
      requestedExecutable: harness.executable,
      executableSource: "config",
      execEnabled: codexAppServerExecEnabled,
      ephemeral: true,
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      requestedEffort: "minimal",
      resolvedEffort: "low",
      effortResolutionSource: "adapter-selection",
      codexReviewMode: "structured",
      webSearchPolicy: "disabled",
      webSearchMode: "disabled",
    });
    expect(prepared.preflight?.checks).toContainEqual(
      expect.objectContaining({
        name: "exec",
        status: "warning",
      }),
    );
    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex app-server ok",
    });
    expect(output.usage).toMatchObject({
      total: {
        inputTokens: 10,
        outputTokens: 5,
      },
    });
    expect(output.metadata).toMatchObject({
      transport: "app-server",
      executable: harness.executable,
      requestedExecutable: harness.executable,
      executableSource: "config",
      execEnabled: codexAppServerExecEnabled,
      ephemeral: true,
      codexReviewMode: "structured",
      requestedModel: "gpt-test",
      resolvedEffort: "low",
      webSearchPolicy: "disabled",
      webSearchMode: "disabled",
    });
    expect(invocation.argv).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      ...codexAppServerIsolatedDisableArgs,
    ]);
    expect(invocation.env.CODEX_HOME).not.toBe(harness.authHome);
    expect(invocation.threadStart).toMatchObject({
      cwd: harness.cwd,
      developerInstructions: codexAppServerDeveloperInstructions,
      ...codexAppServerReviewThreadParams,
      model: "gpt-test",
    });
    expect(invocation.threadStart).not.toHaveProperty("dynamicTools");
    expect(invocation.threadStart.config).toEqual({ web_search: "disabled" });
    expect(invocation.turnStart).toMatchObject({
      model: "gpt-test",
      effort: "low",
      ...codexAppServerTurnPermissionParams,
    });
    expect(invocation.turnStart?.outputSchema).toEqual(reviewResultStrictJsonSchema);
    expect(invocation.turnStart?.input[0]?.text).toBe("review prompt");
    expect(existsSync(invocation.env.CODEX_HOME)).toBe(false);
  });

  it("sends provider and app-server effort values through native protocol fields", async () => {
    const harness = createHarness({
      sourceConfig: [
        'model = "user-default"',
        'sandbox_mode = "danger-full-access"',
        "[model_providers.openrouter]",
        'name = "OpenRouter"',
        'base_url = "https://openrouter.ai/api/v1"',
        'wire_api = "responses"',
        "",
        '[projects."/tmp/repo"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      effort: "off",
    });

    const output = await adapter.run(createInput(reviewer, harness));
    const invocation = harness.readInvocation();

    expect(invocation.threadStart).toMatchObject({
      model: "anthropic/claude-sonnet",
      modelProvider: "openrouter",
    });
    expect(invocation.turnStart).toMatchObject({
      model: "anthropic/claude-sonnet",
      effort: "none",
    });
    expect(output.metadata).toMatchObject({
      requestedModel: "anthropic/claude-sonnet",
      resolvedModel: "anthropic/claude-sonnet",
      requestedEffort: "off",
      resolvedEffort: "none",
      effortResolutionSource: "adapter-selection",
    });
    expect(invocation.config).toContain("[model_providers.openrouter]");
    expect(invocation.config).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(invocation.config).toContain('sandbox_mode = "read-only"');
    expect(invocation.config).not.toContain('sandbox_mode = "danger-full-access"');
    expect(invocation.config).not.toContain("[projects.");
  });

  it("maps max effort to xhigh through native protocol fields", async () => {
    const harness = createHarness();
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable, {
      model: "gpt-test",
      effort: "max",
    });

    const output = await adapter.run(createInput(reviewer, harness));
    const invocation = harness.readInvocation();

    expect(invocation.turnStart).toMatchObject({
      effort: "xhigh",
    });
    expect(output.metadata).toMatchObject({
      requestedEffort: "max",
      resolvedEffort: "xhigh",
      effortResolutionSource: "adapter-selection",
    });
  });

  it("supports Codex app-server web search overrides", async () => {
    const harness = createHarness({
      sourceConfig: [
        'web_search = "cached"',
        "",
        '[projects."/tmp/repo"]',
        'web_search = "disabled"',
        "",
      ].join("\n"),
    });
    const adapter = createCodexAppServerAdapter();
    const enabledReviewer = createReviewer(harness.executable, {
      appServerOptions: {
        mode: "stdio-isolated",
        webSearch: "enabled",
      },
    });

    const enabledOutput = await adapter.run(createInput(enabledReviewer, harness));
    expect(harness.readInvocation().threadStart.config).toEqual({ web_search: "live" });
    expect(harness.readInvocation().config).not.toContain('web_search = "cached"');
    expect(enabledOutput.metadata).toMatchObject({
      webSearchPolicy: "enabled",
      webSearchMode: "live",
    });

    const disabledReviewer = createReviewer(harness.executable, {
      appServerOptions: {
        mode: "stdio-isolated",
        webSearch: "disabled",
      },
    });

    const disabledOutput = await adapter.run(createInput(disabledReviewer, harness));
    expect(harness.readInvocation().threadStart.config).toEqual({ web_search: "disabled" });
    expect(harness.readInvocation().config).not.toContain('web_search = "cached"');
    expect(disabledOutput.metadata).toMatchObject({
      webSearchPolicy: "disabled",
      webSearchMode: "disabled",
    });

    const inheritReviewer = createReviewer(harness.executable, {
      appServerOptions: {
        mode: "stdio-isolated",
        webSearch: "inherit",
      },
    });

    const inheritOutput = await adapter.run(createInput(inheritReviewer, harness));
    expect(harness.readInvocation().threadStart).not.toHaveProperty("config");
    expect(harness.readInvocation().config).toContain('web_search = "cached"');
    expect(harness.readInvocation().config).not.toContain("[projects.");
    expect(inheritOutput.metadata).toMatchObject({
      webSearchPolicy: "inherit",
    });
    expect(inheritOutput.metadata).not.toHaveProperty("webSearchMode");
  });

  it("can run experimental Codex native review mode", async () => {
    const harness = createHarness({ nativeReview: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable, {
      effort: "high",
      appServerOptions: {
        mode: "stdio-isolated",
        reviewMode: "native",
      },
    });

    const prepared = await adapter.prepare?.({
      cwd: harness.cwd,
      reviewer,
      readonly: true,
      env: harness.env,
    });
    const output = await adapter.run({
      ...createInput(reviewer, harness),
      runContext: prepared?.runContext,
    });
    const invocation = harness.readInvocation();

    expect(prepared?.preflight?.metadata).toMatchObject({
      codexReviewMode: "native",
      nativeReviewOutput: codexNativeReviewOutput,
      nativeReviewStructuredFindings: codexNativeReviewStructuredFindings,
      requestedEffort: "high",
      resolvedEffort: "high",
      webSearchPolicy: "disabled",
      requestedWebSearchMode: "disabled",
      webSearchMode: "disabled",
      effectiveWebSearchMode: "disabled",
      effectiveWebSearchReason: codexNativeReviewEffectiveWebSearchReason,
    });
    expect(prepared?.preflight?.checks).toContainEqual(
      expect.objectContaining({
        name: "web-search",
        status: "warning",
      }),
    );
    expect(invocation.threadStart.config).toEqual({
      web_search: "disabled",
      model_reasoning_effort: "high",
    });
    expect(invocation.reviewStart).toMatchObject({
      threadId: "thread-1",
      delivery: "inline",
      target: {
        type: "custom",
        instructions: "review prompt",
      },
    });
    expect(invocation.turnStart).toBeUndefined();
    expect(output.text).toBe("native review text");
    expect(output.metadata).toMatchObject({
      captureMode: "text",
      codexReviewMode: "native",
      nativeReviewOutput: codexNativeReviewOutput,
      nativeReviewStructuredFindings: codexNativeReviewStructuredFindings,
      requestedEffort: "high",
      resolvedEffort: "high",
      webSearchPolicy: "disabled",
      requestedWebSearchMode: "disabled",
      webSearchMode: "disabled",
      effectiveWebSearchMode: "disabled",
      effectiveWebSearchReason: codexNativeReviewEffectiveWebSearchReason,
    });
  });

  it("captures completed agent messages when no delta is emitted", async () => {
    const harness = createHarness({ completedItemOnly: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    const output = await adapter.run(createInput(reviewer, harness));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex app-server ok",
    });
  });

  it("keeps foreign-thread notifications out of reply assembly in stdio-isolated mode", async () => {
    const harness = createHarness({ foreignThread: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    const output = await adapter.run(createInput(reviewer, harness));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex app-server ok",
    });
  });

  it("accepts missing-threadId notifications in stdio-isolated mode", async () => {
    const harness = createHarness({ omitThreadId: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    const output = await adapter.run(createInput(reviewer, harness));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex app-server ok",
    });
    expect(output.usage).toMatchObject({
      total: {
        inputTokens: 10,
        outputTokens: 5,
      },
    });
  });

  it.each(["auto", "attach"] as const)(
    "drops foreign, missing-threadId, and pre-threadId notifications in shared %s mode",
    async (mode) => {
      const harness = createSocketHarness({ crossThreadTraffic: true });
      await harness.start();
      const adapter = createCodexAppServerAdapter();
      const reviewer = createSharedReviewer(process.execPath, {
        mode,
        codexHome: harness.authHome,
      });

      const output = await adapter.run(createInput(reviewer, harness));

      expect(output.structured).toMatchObject({
        overall_correctness: "patch is correct",
        overall_explanation: "codex app-server ok",
      });
      // Server-initiated requests stay answered regardless of thread.
      expect(harness.readInvocation().approvalResponse).toEqual({ decision: "decline" });
    },
  );

  it("handles terminal turns returned directly from turn/start", async () => {
    const harness = createHarness({ directCompletedTurn: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    const output = await adapter.run(createInput(reviewer, harness));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex app-server ok",
    });
  });

  it("ignores retryable app-server error notifications", async () => {
    const harness = createHarness({ retryableError: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    const output = await adapter.run(createInput(reviewer, harness));

    expect(output.structured).toMatchObject({
      overall_correctness: "patch is correct",
      overall_explanation: "codex app-server ok",
    });
  });

  it("denies app-server approval requests", async () => {
    const harness = createHarness({ requestApproval: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    await adapter.run(createInput(reviewer, harness));

    expect(harness.readInvocation().approvalResponse).toEqual({ decision: "decline" });
  });

  it("handles string request ids and legacy approval decisions", async () => {
    const harness = createHarness({ legacyApproval: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    await adapter.run(createInput(reviewer, harness));

    expect(harness.readInvocation().legacyApprovalResponse).toEqual({ decision: "denied" });
  });

  it.each([
    ["item/commandExecution/requestApproval", { decision: "decline" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["applyPatchApproval", { decision: "denied" }],
    ["execCommandApproval", { decision: "denied" }],
    [
      "item/permissions/requestApproval",
      { permissions: {}, scope: "turn", strictAutoReview: true },
    ],
    ["item/tool/requestUserInput", { answers: {} }],
    [
      "item/tool/call",
      {
        success: false,
        contentItems: [{ type: "inputText", text: "Diffwarden does not expose dynamic tools." }],
      },
    ],
  ] as const)(
    "responds conservatively to app-server request %s",
    async (serverRequestMethod, response) => {
      const harness = createHarness({ serverRequestMethod });
      const adapter = createCodexAppServerAdapter();
      const reviewer = createReviewer(harness.executable);

      await adapter.run(createInput(reviewer, harness));

      expect(harness.readInvocation().serverRequestResponse).toEqual(response);
    },
  );

  it("returns JSON-RPC errors for unsupported server requests", async () => {
    const harness = createHarness({ unsupportedRequest: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    await adapter.run(createInput(reviewer, harness));

    expect(harness.readInvocation().unsupportedResponse).toMatchObject({
      error: {
        code: -32601,
        message: expect.stringContaining("Unsupported Codex app-server request"),
      },
    });
  });

  it("rejects failed app-server turns", async () => {
    const harness = createHarness({ failedTurn: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    await expect(adapter.run(createInput(reviewer, harness))).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("codex app-server turn failed: model unavailable"),
    });
  });

  it("rejects failed turns returned directly from turn/start", async () => {
    const harness = createHarness({ directFailedTurn: true });
    const adapter = createCodexAppServerAdapter();
    const reviewer = createReviewer(harness.executable);

    await expect(adapter.run(createInput(reviewer, harness))).rejects.toMatchObject({
      code: "reviewer_failed",
      message: expect.stringContaining("codex app-server turn failed: model unavailable"),
    });
  });

  it("fails preflight when Codex auth is missing", async () => {
    const harness = createHarness({ auth: false });
    const adapter = createCodexAppServerAdapter();

    await expect(
      adapter.preflight?.({
        cwd: harness.cwd,
        reviewer: createReviewer(harness.executable),
        readonly: true,
        env: harness.env,
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      message: expect.stringContaining("auth.json"),
    });
  });
});

describe("codexAppServerListModels", () => {
  it("lists models over a forced stdio-isolated connection and tears it down", async () => {
    const harness = createHarness();
    // No appServerOptions on the draft reviewer: the derived mode would be "auto" (shared
    // daemon); the fetch must force stdio-isolated instead.
    const reviewer: ReviewReviewerConfig = {
      id: "codex",
      sdk: "codex",
      readonly: true,
      cliOptions: { executable: harness.executable },
    };

    const models = await codexAppServerListModels({ reviewer, env: harness.env });

    // Both pages arrive in order. Default (cli) transport: no "off" (the CLI omits the flag,
    // which runs the model default effort — not off), no max/ultra (both delivery paths
    // collapse max→xhigh).
    expect(models).toEqual([
      {
        value: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
        default: true,
      },
      {
        value: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        supportedEffortLevels: ["low", "medium"],
      },
    ]);

    const invocation = harness.readInvocation();
    // initialize → initialized → model/list (following nextCursor), never a thread or turn.
    expect(invocation.messages?.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ]);
    // The second page was requested with the cursor the first page returned.
    expect(invocation.modelList).toEqual({ cursor: "page-2" });
    // The connection ran isolated: a temp CODEX_HOME, not the user's shared one.
    expect(invocation.env.CODEX_HOME).not.toBe(harness.authHome);
    expect(invocation.env.CODEX_HOME).toContain("diffwarden-codex-home-");
    // The temp CODEX_HOME is removed by close() — teardown ran.
    expect(existsSync(invocation.env.CODEX_HOME)).toBe(false);
  });

  it("classifies missing codex auth into one actionable sentence", async () => {
    const harness = createHarness({ auth: false });
    await expect(
      codexAppServerListModels({
        reviewer: {
          id: "codex",
          sdk: "codex",
          readonly: true,
          cliOptions: { executable: harness.executable },
        },
        env: harness.env,
      }),
    ).rejects.toThrow('codex is not authenticated — run "codex login"');
  });

  it("aborts before the handshake without leaving a connection behind", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      codexAppServerListModels({
        reviewer: {
          id: "codex",
          sdk: "codex",
          readonly: true,
          cliOptions: { executable: harness.executable },
        },
        env: harness.env,
        signal: controller.signal,
      }),
    ).rejects.toThrow("codex model catalog fetch aborted");
  });
});

describe("codexModelCatalogEntries", () => {
  const result = {
    data: [
      {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" },
          { reasoningEffort: "max", description: "Maximum" },
          { reasoningEffort: "ultra", description: "Delegating" },
        ],
      },
      { id: "gpt-5.2", model: "gpt-5.2", displayName: "GPT-5.2" },
    ],
  };

  it("extracts effort levels from the object-shaped supportedReasoningEfforts", () => {
    // A naive string filter over the objects would narrow every model to nothing.
    const entries = codexModelCatalogEntries(result, "cli");
    expect(entries[0]?.supportedEffortLevels).toEqual(["low", "high"]);
    // No advertised efforts → no narrowing metadata at all.
    expect(entries[1]).toEqual({ value: "gpt-5.2", displayName: "GPT-5.2" });
  });

  it('includes "off" only on the app-server transport, where off maps to native none', () => {
    const entries = codexModelCatalogEntries(result, "app-server");
    expect(entries[0]?.supportedEffortLevels).toEqual(["off", "low", "high"]);
    expect(codexModelCatalogEntries(result, "cli")[0]?.supportedEffortLevels).not.toContain("off");
    // A model advertising NO efforts stays un-narrowed on app-server too: an off-only entry
    // would collapse the effort menu to one row for a model whose effort surface is unknown.
    expect(entries[1]).toEqual({ value: "gpt-5.2", displayName: "GPT-5.2" });
  });

  it("uses `model` as the committed value and expects it to equal `id`", () => {
    // Live model/list fixture (2026-07-15): every entry has model === id. The adapter
    // commits `model` (the id turn/start accepts); this guards against silent divergence.
    for (const item of result.data) {
      expect(item.model).toBe(item.id);
    }
    expect(codexModelCatalogEntries(result, "cli").map((entry) => entry.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.2",
    ]);
  });
});

describe("codex app-server debug output", () => {
  const reviewJson = JSON.stringify({
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "codex app-server ok",
    overall_confidence_score: 0.91,
  });

  type Chunk = { stream: "stdout" | "stderr"; text: string };

  it("captures notification summaries, request notes, and raw stderr in stdio-isolated mode", async () => {
    const harness = createHarness({ debugSequence: true });
    const adapter = createCodexAppServerAdapter();
    const chunks: Chunk[] = [];

    const output = await adapter.run({
      ...createInput(createReviewer(harness.executable), harness),
      debugOutput: { onChunk: (stream, text) => chunks.push({ stream, text }) },
    });

    const streamedPrefix = reviewJson.slice(0, 32);
    // Two token-level deltas coalesce into one live prefix when the reasoning
    // event transitions the stream. Completion contributes only the unseen
    // authoritative suffix, so the review text is never repeated.
    expect(chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text)).toEqual([
      "[request item/commandExecution/requestApproval -> decline]\n",
      `${streamedPrefix}\n`,
      "[item:commandExecution]\n",
      `${reviewJson.slice(streamedPrefix.length)}\n`,
      "[error willRetry=true]\n",
      "[turn:completed]\n",
    ]);
    // The isolated child's stderr is teed raw, labeled as the stderr stream.
    const stderrText = chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.text)
      .join("");
    expect(stderrText).toContain("codex fixture stderr");
    // No payload leaks: request params, reasoning text, aggregated_output,
    // and the error message never render.
    const captured = JSON.stringify(chunks);
    expect(captured).not.toContain("PARAM_SENTINEL");
    expect(captured).not.toContain("REASONING_SENTINEL");
    expect(captured).not.toContain("AGGREGATED_SENTINEL");
    expect(captured).not.toContain("ERROR_SENTINEL");
    expect(output.structured).toMatchObject({ overall_explanation: "codex app-server ok" });
    expect(output.metadata).toMatchObject({ debugOutputMode: "event-summary" });
    expect(output.metadata).not.toHaveProperty("debugOutputDropped");
  });

  it("captures native review text and the turn marker in stdio-isolated native mode", async () => {
    const harness = createHarness({ nativeReview: true });
    const adapter = createCodexAppServerAdapter();
    const chunks: Chunk[] = [];

    const output = await adapter.run({
      ...createInput(
        createReviewer(harness.executable, {
          appServerOptions: { mode: "stdio-isolated", reviewMode: "native" },
        }),
        harness,
      ),
      debugOutput: { onChunk: (stream, text) => chunks.push({ stream, text }) },
    });

    // The exitedReviewMode item's review text renders verbatim (the
    // structured duplication matches the accepted claude-CLI precedent).
    expect(chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text)).toEqual([
      "native review text\n",
      "[turn:completed]\n",
    ]);
    expect(output.text).toBe("native review text");
    expect(output.metadata).toMatchObject({ debugOutputMode: "event-summary" });
  });

  it("emits at the shared delta buffer cap and does not repeat the completed text", async () => {
    const harness = createHarness({ deltaCapSequence: true });
    const adapter = createCodexAppServerAdapter();
    const chunks: Chunk[] = [];
    const explanation = "x".repeat(deltaCoalescerBufferCapChars);
    const capReviewJson = JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: explanation,
      overall_confidence_score: 0.91,
    });

    const output = await adapter.run({
      ...createInput(createReviewer(harness.executable), harness),
      debugOutput: { onChunk: (stream, text) => chunks.push({ stream, text }) },
    });

    expect(chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text)).toEqual([
      `${capReviewJson}\n`,
      "[turn:completed]\n",
    ]);
    expect(output.structured).toMatchObject({ overall_explanation: explanation });
  });

  it("keeps foreign-thread notifications out of both reply assembly and debug capture", async () => {
    const harness = createHarness({ foreignThread: true });
    const adapter = createCodexAppServerAdapter();
    const chunks: Chunk[] = [];

    const output = await adapter.run({
      ...createInput(createReviewer(harness.executable), harness),
      debugOutput: { onChunk: (stream, text) => chunks.push({ stream, text }) },
    });

    // The accepted own-thread delta flushes before the turn marker; both
    // foreign delta streams and the foreign completed item stay outside the
    // activity path because the thread guard runs first.
    expect(chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text)).toEqual([
      `${reviewJson}\n`,
      "[turn:completed]\n",
    ]);
    expect(JSON.stringify(chunks)).not.toContain("FOREIGN");
    expect(output.structured).toMatchObject({ overall_explanation: "codex app-server ok" });
  });

  it.each(["auto", "attach"] as const)(
    "withholds debug capture in shared %s mode and marks it dropped",
    async (mode) => {
      const harness = createSocketHarness({ crossThreadTraffic: true });
      await harness.start();
      const adapter = createCodexAppServerAdapter();
      const chunks: Chunk[] = [];

      const output = await adapter.run({
        ...createInput(
          createSharedReviewer(process.execPath, { mode, codexHome: harness.authHome }),
          harness,
        ),
        debugOutput: { onChunk: (stream, text) => chunks.push({ stream, text }) },
      });

      // Withheld until a live attach-mode capture proves threadId presence on
      // real notifications (2026-07-15): no sink, no stderr (a shared daemon
      // has no child stderr), only the dropped marker.
      expect(chunks).toEqual([]);
      expect(output.metadata).toMatchObject({ debugOutputDropped: "shared-server-unverified" });
      expect(output.metadata).not.toHaveProperty("debugOutputMode");
      expect(output.structured).toMatchObject({ overall_explanation: "codex app-server ok" });
    },
  );

  it("produces an identical artifact with and without debug capture (non-authoritative debug invariant)", async () => {
    const harness = createHarness();
    const adapter = createCodexAppServerAdapter();

    const baseline = await adapter.run(createInput(createReviewer(harness.executable), harness));
    const debugged = await adapter.run({
      ...createInput(createReviewer(harness.executable), harness),
      debugOutput: { onChunk: () => {} },
    });

    expect(baseline.metadata).not.toHaveProperty("debugOutputMode");
    expect(debugged.metadata).toMatchObject({ debugOutputMode: "event-summary" });
    expect(debugged).not.toHaveProperty("debug_output");
    // Debug output is non-authoritative: removing its metadata key leaves the
    // artifacts deep-equal. codexHome is excluded from the comparison because
    // stdio-isolated runs mint a fresh ephemeral CODEX_HOME per run, with or
    // without debug capture.
    const {
      debugOutputMode: _mode,
      codexHome: _debugHome,
      ...debuggedMetadata
    } = debugged.metadata ?? {};
    const { codexHome: _baselineHome, ...baselineMetadata } = baseline.metadata ?? {};
    expect({ ...debugged, metadata: debuggedMetadata }).toEqual({
      ...baseline,
      metadata: baselineMetadata,
    });
  });

  it("keeps the artifact byte-identical without the debug opt-in", async () => {
    const harness = createHarness();
    const adapter = createCodexAppServerAdapter();

    const output = await adapter.run(createInput(createReviewer(harness.executable), harness));

    // Full-artifact fixture: the flag-off run carries no debug traces at all.
    expect(output).toEqual({
      structured: {
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "codex app-server ok",
        overall_confidence_score: 0.91,
      },
      usage: { total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } },
      metadata: {
        captureMode: "native-structured",
        readonlyCapability: "enforced",
        transport: "app-server",
        execEnabled: codexAppServerExecEnabled,
        ephemeral: true,
        codexReviewMode: "structured",
        appServerMode: "stdio-isolated",
        codexHome: harness.readInvocation().env.CODEX_HOME,
        codexHomeShared: false,
        serverLifecycle: "isolated-stdio",
        executable: harness.executable,
        requestedExecutable: harness.executable,
        executableSource: "config",
        webSearchPolicy: "disabled",
        webSearchMode: "disabled",
        effectiveWebSearchMode: "disabled",
      },
    });
  });

  it("tolerates a throwing debug callback in both the sink and the stderr tee", async () => {
    const harness = createHarness({ debugSequence: true });
    const adapter = createCodexAppServerAdapter();

    const output = await adapter.run({
      ...createInput(createReviewer(harness.executable), harness),
      debugOutput: {
        onChunk: () => {
          throw new Error("recorder failed");
        },
      },
    });

    expect(output.structured).toMatchObject({ overall_explanation: "codex app-server ok" });
    expect(output.metadata).toMatchObject({ debugOutputMode: "event-summary" });
  });
});

type Harness = {
  cwd: string;
  authHome: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  invocationPath: string;
  socketPath?: string;
  readInvocation(): FakeInvocation;
};

type FakeInvocation = {
  argv: string[];
  env: {
    CODEX_HOME: string;
  };
  modelList?: unknown;
  messages?: Array<{ method?: string }>;
  threadStart: {
    cwd: string;
    approvalPolicy: string;
    sandbox: string;
    ephemeral: boolean;
    experimentalRawEvents: boolean;
    persistExtendedHistory: boolean;
    developerInstructions: string;
    model?: string;
    config?: unknown;
    dynamicTools?: unknown;
  };
  config: string;
  turnStart:
    | {
        approvalPolicy: string;
        model?: string;
        effort?: string;
        sandboxPolicy: unknown;
        outputSchema: unknown;
        input: Array<{ text: string }>;
      }
    | undefined;
  reviewStart?: {
    threadId: string;
    delivery?: string;
    target: unknown;
  };
  approvalResponse?: unknown;
  legacyApprovalResponse?: unknown;
  serverRequestResponse?: unknown;
  unsupportedResponse?: unknown;
};

function createSocketHarness(
  options: { crossThreadTraffic?: boolean } = {},
): Harness & { socketPath: string; start(): Promise<void> } {
  root = mkdtempSync(path.join("/tmp", "dw-cas-"));
  const cwd = path.join(root, "repo");
  const authHome = path.join(root, "codex-home");
  const controlDir = path.join(authHome, "app-server-control");
  const socketPath = path.join(controlDir, "app-server-control.sock");
  const invocationPath = path.join(root, "invocation.json");
  mkdirSync(cwd);
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(path.join(authHome, "auth.json"), "{}\n");
  const executable = process.execPath;
  let server: Server | undefined;
  const invocation = createEmptyInvocation({
    argv: [],
    codexHome: authHome,
    config: "",
  });

  return {
    cwd,
    authHome,
    executable,
    invocationPath,
    socketPath,
    env: {
      PATH: path.dirname(process.execPath),
      CODEX_HOME: authHome,
    },
    async start() {
      server = createFakeWebSocketAppServer(socketPath, invocation, invocationPath, options);
      cleanupFns.push(
        () =>
          new Promise<void>((resolve) => {
            server?.close(() => resolve());
          }),
      );
      await once(server, "listening");
    },
    readInvocation() {
      return JSON.parse(readFileSync(invocationPath, "utf8")) as FakeInvocation;
    },
  };
}

function createBadSocketHarness(
  onConnection: (socket: Socket) => void,
): Harness & { socketPath: string; start(): Promise<void> } {
  root = mkdtempSync(path.join("/tmp", "dw-cas-bad-"));
  const cwd = path.join(root, "repo");
  const authHome = path.join(root, "codex-home");
  const controlDir = path.join(authHome, "app-server-control");
  const socketPath = path.join(controlDir, "app-server-control.sock");
  const invocationPath = path.join(root, "invocation.json");
  mkdirSync(cwd);
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(path.join(authHome, "auth.json"), "{}\n");
  let server: Server | undefined;
  const sockets = new Set<Socket>();

  return {
    cwd,
    authHome,
    executable: process.execPath,
    invocationPath,
    socketPath,
    env: {
      PATH: path.dirname(process.execPath),
      CODEX_HOME: authHome,
    },
    async start() {
      server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        onConnection(socket);
      });
      server.listen(socketPath);
      cleanupFns.push(async () => {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          server?.close(() => resolve());
        });
      });
      await once(server, "listening");
    },
    readInvocation() {
      return JSON.parse(readFileSync(invocationPath, "utf8")) as FakeInvocation;
    },
  };
}

function createHarness(
  options: {
    auth?: boolean;
    completedItemOnly?: boolean;
    deltaCapSequence?: boolean;
    debugSequence?: boolean;
    foreignThread?: boolean;
    omitThreadId?: boolean;
    requestApproval?: boolean;
    legacyApproval?: boolean;
    retryableError?: boolean;
    sourceConfig?: string;
    unsupportedRequest?: boolean;
    serverRequestMethod?: string;
    failedTurn?: boolean;
    directCompletedTurn?: boolean;
    directFailedTurn?: boolean;
    nativeReview?: boolean;
  } = {},
): Harness {
  root = mkdtempSync(path.join(tmpdir(), "diffwarden-codex-app-server-"));
  const cwd = path.join(root, "repo");
  const authHome = path.join(root, "codex-home");
  const invocationPath = path.join(root, "invocation.json");
  mkdirSync(cwd);
  mkdirSync(authHome);
  if (options.auth !== false) {
    writeFileSync(path.join(authHome, "auth.json"), "{}\n");
  }
  if (options.sourceConfig !== undefined) {
    writeFileSync(path.join(authHome, "config.toml"), options.sourceConfig);
  }
  const executable = path.join(root, "codex");
  writeFileSync(executable, fakeAppServerScript(), "utf8");
  chmodSync(executable, 0o755);

  return {
    cwd,
    authHome,
    executable,
    invocationPath,
    env: {
      PATH: path.dirname(process.execPath),
      CODEX_HOME: authHome,
      DIFFWARDEN_FAKE_APP_SERVER_INVOCATION: invocationPath,
      ...(options.completedItemOnly ? { DIFFWARDEN_FAKE_APP_SERVER_COMPLETED_ITEM_ONLY: "1" } : {}),
      ...(options.deltaCapSequence ? { DIFFWARDEN_FAKE_APP_SERVER_DELTA_CAP_SEQUENCE: "1" } : {}),
      ...(options.debugSequence ? { DIFFWARDEN_FAKE_APP_SERVER_DEBUG_SEQUENCE: "1" } : {}),
      ...(options.foreignThread ? { DIFFWARDEN_FAKE_APP_SERVER_FOREIGN_THREAD: "1" } : {}),
      ...(options.omitThreadId ? { DIFFWARDEN_FAKE_APP_SERVER_OMIT_THREAD_ID: "1" } : {}),
      ...(options.requestApproval ? { DIFFWARDEN_FAKE_APP_SERVER_APPROVAL: "1" } : {}),
      ...(options.legacyApproval ? { DIFFWARDEN_FAKE_APP_SERVER_LEGACY_APPROVAL: "1" } : {}),
      ...(options.retryableError ? { DIFFWARDEN_FAKE_APP_SERVER_RETRYABLE_ERROR: "1" } : {}),
      ...(options.unsupportedRequest ? { DIFFWARDEN_FAKE_APP_SERVER_UNSUPPORTED: "1" } : {}),
      ...(options.serverRequestMethod !== undefined
        ? { DIFFWARDEN_FAKE_APP_SERVER_REQUEST_METHOD: options.serverRequestMethod }
        : {}),
      ...(options.failedTurn ? { DIFFWARDEN_FAKE_APP_SERVER_FAILED_TURN: "1" } : {}),
      ...(options.nativeReview ? { DIFFWARDEN_FAKE_APP_SERVER_NATIVE_REVIEW: "1" } : {}),
      ...(options.directCompletedTurn
        ? { DIFFWARDEN_FAKE_APP_SERVER_DIRECT_COMPLETED_TURN: "1" }
        : {}),
      ...(options.directFailedTurn ? { DIFFWARDEN_FAKE_APP_SERVER_DIRECT_FAILED_TURN: "1" } : {}),
    },
    readInvocation() {
      return JSON.parse(readFileSync(invocationPath, "utf8")) as FakeInvocation;
    },
  };
}

function createEmptyInvocation(options: {
  argv: string[];
  codexHome: string;
  config: string;
}): FakeInvocation & { messages: unknown[] } {
  return {
    argv: options.argv,
    env: { CODEX_HOME: options.codexHome },
    config: options.config,
    messages: [],
    threadStart: undefined as unknown as FakeInvocation["threadStart"],
    turnStart: undefined as unknown as FakeInvocation["turnStart"],
  };
}

function createFakeWebSocketAppServer(
  socketPath: string,
  invocation: FakeInvocation & { messages: unknown[] },
  invocationPath: string,
  options: { crossThreadTraffic?: boolean } = {},
): Server {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const fragments: Buffer[] = [];

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        socket.write(fakeWebSocketUpgradeResponse(header));
        upgraded = true;
      }
      while (true) {
        const frame = readFakeFrame(buffer);
        if (frame === undefined) {
          return;
        }
        buffer = buffer.subarray(frame.bytes);
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 0x1 && frame.opcode !== 0x0) {
          continue;
        }
        fragments.push(frame.payload);
        if (!frame.fin) {
          continue;
        }
        const payload = Buffer.concat(fragments).toString("utf8");
        fragments.length = 0;
        handleFakeAppServerMessage(
          JSON.parse(payload),
          invocation,
          invocationPath,
          socket,
          options,
        );
      }
    });
  });
  server.listen(socketPath);
  return server;
}

function handleFakeAppServerMessage(
  message: Record<string, unknown>,
  invocation: FakeInvocation & { messages: unknown[] },
  invocationPath: string,
  socket: Socket,
  options: { crossThreadTraffic?: boolean } = {},
): void {
  invocation.messages.push(message);
  if (message.method === undefined && message.id === 999) {
    invocation.approvalResponse = message.result;
    finishFakeSocketInvocation(invocation, invocationPath, socket, options);
    return;
  }
  if (message.method === "initialize") {
    fakeSocketSend(socket, { id: message.id, result: { serverInfo: { name: "fake-codex" } } });
    return;
  }
  if (message.method === "thread/start") {
    invocation.threadStart = message.params as FakeInvocation["threadStart"];
    if (options.crossThreadTraffic) {
      // Arrives before the client learns its threadId from the thread/start
      // response: shared modes must drop it even though the threadId matches.
      fakeSocketSend(socket, {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "PRE-THREAD POISON ",
        },
      });
    }
    fakeSocketSend(socket, { id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "turn/start") {
    invocation.turnStart = message.params as FakeInvocation["turnStart"];
    fakeSocketSend(socket, { id: message.id, result: { turn: { id: "turn-1" } } });
    if (options.crossThreadTraffic) {
      fakeSocketSend(socket, {
        id: 999,
        method: "item/commandExecution/requestApproval",
        params: {},
      });
      return;
    }
    finishFakeSocketInvocation(invocation, invocationPath, socket, options);
  }
}

function finishFakeSocketInvocation(
  invocation: FakeInvocation & { messages: unknown[] },
  invocationPath: string,
  socket: Socket,
  options: { crossThreadTraffic?: boolean } = {},
): void {
  const review = {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "codex app-server ok",
    overall_confidence_score: 0.91,
  };
  if (options.crossThreadTraffic) {
    fakeSocketSend(socket, {
      method: "item/agentMessage/delta",
      params: {
        turnId: "turn-1",
        itemId: "message-1",
        delta: "NO-THREAD POISON ",
      },
    });
    fakeSocketSend(socket, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-2",
        turnId: "turn-9",
        itemId: "message-1",
        delta: "FOREIGN POISON ",
      },
    });
  }
  fakeSocketSend(socket, {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: JSON.stringify(review),
    },
  });
  if (options.crossThreadTraffic) {
    fakeSocketSend(socket, {
      method: "item/completed",
      params: {
        threadId: "thread-2",
        turnId: "turn-9",
        item: { type: "agentMessage", id: "message-9", text: "FOREIGN COMPLETED" },
      },
    });
  }
  writeFileSync(invocationPath, JSON.stringify(invocation, null, 2));
  fakeSocketSend(socket, {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    },
  });
}

function fakeWebSocketUpgradeResponse(header: string): string {
  const key =
    /^Sec-WebSocket-Key:\s*(.+)$/im.exec(header)?.[1]?.trim() ?? "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n");
}

function fakeSocketSend(socket: Socket, message: unknown): void {
  socket.write(fakeFrame(Buffer.from(JSON.stringify(message), "utf8")));
}

function fakeFrame(payload: Buffer): Buffer {
  const length = payload.length;
  const lengthBytes =
    length < 126 ? Buffer.from([length]) : Buffer.from([126, (length >> 8) & 0xff, length & 0xff]);
  return Buffer.concat([
    Buffer.from([0x81, lengthBytes[0] ?? 0]),
    lengthBytes.subarray(1),
    payload,
  ]);
}

function readFakeFrame(
  buffer: Buffer,
): { fin: boolean; opcode: number; payload: Buffer; bytes: number } | undefined {
  if (buffer.length < 2) {
    return undefined;
  }
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < offset + 2) {
      return undefined;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  }
  const maskKey = (second & 0x80) !== 0 ? buffer.subarray(offset, offset + 4) : undefined;
  if (maskKey !== undefined) {
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return undefined;
  }
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey !== undefined) {
    for (let index = 0; index < payload.length; index++) {
      payload[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
    }
  }
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload,
    bytes: offset + length,
  };
}

function createReviewer(
  executable: string,
  options: Partial<ReviewReviewerConfig> = {},
): ReviewReviewerConfig {
  return {
    id: "codex-app-server",
    sdk: "codex",
    transport: "app-server",
    readonly: true,
    cliOptions: {
      executable,
    },
    appServerOptions: {
      mode: "stdio-isolated",
    },
    ...options,
  };
}

function createSharedReviewer(
  executable: string,
  appServerOptions: Record<string, unknown>,
): ReviewReviewerConfig {
  return {
    id: "codex-app-server",
    sdk: "codex",
    transport: "app-server",
    readonly: true,
    cliOptions: {
      executable,
    },
    appServerOptions,
  };
}

function createInput(reviewer: ReviewReviewerConfig, harness: Harness): ReviewAdapterInput {
  return {
    cwd: harness.cwd,
    reviewer,
    target: {
      kind: "custom",
      repo_root: harness.cwd,
      instructions: "review",
      diff_command: "custom",
      changed_files: [],
    },
    diff: "",
    changedFiles: [],
    prompt: "review prompt",
    readonly: true,
    env: harness.env,
  };
}

function fakeAppServerScript(): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const invocationPath = process.env.DIFFWARDEN_FAKE_APP_SERVER_INVOCATION;
const invocation = {
  argv: process.argv.slice(2),
  env: { CODEX_HOME: process.env.CODEX_HOME },
  config: fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"),
  messages: []
};

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function writeInvocation() {
  fs.writeFileSync(invocationPath, JSON.stringify(invocation, null, 2));
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  invocation.messages.push(message);
  if (message.id === 999 && !message.method) {
    invocation.approvalResponse = message.result;
    if (process.env.DIFFWARDEN_FAKE_APP_SERVER_DEBUG_SEQUENCE) {
      finishDebugSequence();
    } else {
      finish();
    }
    return;
  }
  if (message.id === "legacy-approval" && !message.method) {
    invocation.legacyApprovalResponse = message.result;
    finish();
    return;
  }
  if (message.id === "unsupported-request" && !message.method) {
    invocation.unsupportedResponse = message;
    finish();
    return;
  }
  if (message.id === "server-request" && !message.method) {
    invocation.serverRequestResponse = message.result;
    finish();
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { serverInfo: { name: "fake-codex" } } });
    return;
  }
  if (message.method === "model/list") {
    invocation.modelList = message.params;
    writeInvocation();
    // Two pages: the fetch must follow nextCursor or the picker silently truncates.
    if (message.params && message.params.cursor === "page-2") {
      send({
        id: message.id,
        result: {
          data: [
            {
              id: "gpt-5.6-luna",
              model: "gpt-5.6-luna",
              displayName: "GPT-5.6-Luna",
              isDefault: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Fast" },
                { reasoningEffort: "medium", description: "Balanced" }
              ]
            }
          ],
          nextCursor: null
        }
      });
      return;
    }
    send({
      id: message.id,
      result: {
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: "Latest frontier agentic coding model.",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Deep" },
              { reasoningEffort: "xhigh", description: "Extra" },
              { reasoningEffort: "max", description: "Maximum" },
              { reasoningEffort: "ultra", description: "Delegating" }
            ]
          }
        ],
        nextCursor: "page-2"
      }
    });
    return;
  }
  if (message.method === "thread/start") {
    invocation.threadStart = message.params;
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "turn/start") {
    invocation.turnStart = message.params;
    if (
      process.env.DIFFWARDEN_FAKE_APP_SERVER_DIRECT_COMPLETED_TURN ||
      process.env.DIFFWARDEN_FAKE_APP_SERVER_DIRECT_FAILED_TURN
    ) {
      writeInvocation();
      const review = {
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "codex app-server ok",
        overall_confidence_score: 0.91
      };
      const failed = Boolean(process.env.DIFFWARDEN_FAKE_APP_SERVER_DIRECT_FAILED_TURN);
      send({
        id: message.id,
        result: {
          turn: {
            id: "turn-1",
            items: failed
              ? []
              : [
                  {
                    type: "agentMessage",
                    id: "message-1",
                    text: JSON.stringify(review),
                    phase: null,
                    memoryCitation: null
                  }
                ],
            itemsView: { type: "full" },
            status: failed ? "failed" : "completed",
            error: failed ? { message: "model unavailable" } : null,
            startedAt: null,
            completedAt: null,
            durationMs: null
          }
        }
      });
      return;
    }
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    if (process.env.DIFFWARDEN_FAKE_APP_SERVER_DELTA_CAP_SEQUENCE) {
      finishDeltaCapSequence();
    } else if (process.env.DIFFWARDEN_FAKE_APP_SERVER_DEBUG_SEQUENCE) {
      process.stderr.write("codex fixture stderr\\n");
      send({
        id: 999,
        method: "item/commandExecution/requestApproval",
        params: { command: "PARAM_SENTINEL rm -rf /" }
      });
    } else if (process.env.DIFFWARDEN_FAKE_APP_SERVER_APPROVAL) {
      send({
        id: 999,
        method: "item/commandExecution/requestApproval",
        params: {}
      });
    } else if (process.env.DIFFWARDEN_FAKE_APP_SERVER_LEGACY_APPROVAL) {
      send({
        id: "legacy-approval",
        method: "execCommandApproval",
        params: {}
      });
    } else if (process.env.DIFFWARDEN_FAKE_APP_SERVER_UNSUPPORTED) {
      send({
        id: "unsupported-request",
        method: "account/chatgptAuthTokens/refresh",
        params: {}
      });
    } else if (process.env.DIFFWARDEN_FAKE_APP_SERVER_REQUEST_METHOD) {
      send({
        id: "server-request",
        method: process.env.DIFFWARDEN_FAKE_APP_SERVER_REQUEST_METHOD,
        params: {}
      });
    } else {
      finish();
    }
    return;
  }
  if (message.method === "review/start") {
    invocation.reviewStart = message.params;
    send({ id: message.id, result: { turn: { id: "turn-1" }, reviewThreadId: "thread-1" } });
    finishNativeReview();
  }
});

function finishDebugSequence() {
  const review = {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "codex app-server ok",
    overall_confidence_score: 0.91
  };
  const streamedPrefix = JSON.stringify(review).slice(0, 32);
  // Two token-level deltas must render as one coalesced block, never one line
  // per fragment. The following reasoning event provides the transition.
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: streamedPrefix.slice(0, 11)
    }
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: streamedPrefix.slice(11)
    }
  });
  // Reasoning-flavored method: dropped by the universal reasoning drop.
  send({
    method: "item/reasoning/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "reasoning-1", delta: "REASONING_SENTINEL" }
  });
  // Non-message item: marker only; aggregated_output must never render.
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "cmd-1",
        type: "commandExecution",
        command: "rg diff",
        aggregated_output: "AGGREGATED_SENTINEL"
      }
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", text: JSON.stringify(review) }
    }
  });
  send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: { message: "ERROR_SENTINEL temporary failure" }
    }
  });
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } }
    }
  });
  writeInvocation();
  send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });
}

function finishDeltaCapSequence() {
  const review = {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "x".repeat(${deltaCoalescerBufferCapChars}),
    overall_confidence_score: 0.91
  };
  const text = JSON.stringify(review);
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: text
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", text }
    }
  });
  writeInvocation();
  send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });
}

function finishNativeReview() {
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: Date.now(),
      item: {
        type: "exitedReviewMode",
        id: "review-1",
        review: "native review text"
      }
    }
  });
  writeInvocation();
  send({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    }
  });
}

function finish() {
  const review = {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "codex app-server ok",
    overall_confidence_score: 0.91
  };
  const threadFields = process.env.DIFFWARDEN_FAKE_APP_SERVER_OMIT_THREAD_ID
    ? {}
    : { threadId: "thread-1" };
  if (process.env.DIFFWARDEN_FAKE_APP_SERVER_FOREIGN_THREAD) {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-2",
        turnId: "turn-9",
        itemId: "message-1",
        delta: "FOREIGN POISON "
      }
    });
  }
  if (process.env.DIFFWARDEN_FAKE_APP_SERVER_RETRYABLE_ERROR) {
    send({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: true,
        error: { message: "temporary stream failure" }
      }
    });
  }
  if (process.env.DIFFWARDEN_FAKE_APP_SERVER_COMPLETED_ITEM_ONLY) {
    send({
      method: "item/completed",
      params: {
        ...threadFields,
        turnId: "turn-1",
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: "message-1",
          text: JSON.stringify(review),
          phase: null,
          memoryCitation: null
        }
      }
    });
  } else {
    send({
      method: "item/agentMessage/delta",
      params: {
        ...threadFields,
        turnId: "turn-1",
        itemId: "message-1",
        delta: JSON.stringify(review)
      }
    });
  }
  if (process.env.DIFFWARDEN_FAKE_APP_SERVER_FOREIGN_THREAD) {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-2",
        turnId: "turn-9",
        itemId: "message-9",
        delta: "FOREIGN CLOBBER"
      }
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-2",
        turnId: "turn-9",
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: "message-9",
          text: "FOREIGN COMPLETED",
          phase: null,
          memoryCitation: null
        }
      }
    });
  }
  send({
    method: "thread/tokenUsage/updated",
    params: {
      ...threadFields,
      turnId: "turn-1",
      tokenUsage: {
        total: {
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 2
        }
      }
    }
  });
  writeInvocation();
  if (process.env.DIFFWARDEN_FAKE_APP_SERVER_FAILED_TURN) {
    send({
      method: "turn/completed",
      params: {
        ...threadFields,
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "model unavailable" }
        }
      }
    });
    return;
  }
  send({
    method: "turn/completed",
    params: {
      ...threadFields,
      turn: { id: "turn-1", status: "completed" }
    }
  });
}
`;
}
