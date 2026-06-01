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
import { createCodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";

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
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
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
      execEnabled: true,
      ephemeral: true,
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      requestedEffort: "minimal",
      resolvedEffort: "minimal",
      effortResolutionSource: "requested",
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
      execEnabled: true,
      ephemeral: true,
      codexReviewMode: "structured",
      requestedModel: "gpt-test",
      resolvedEffort: "minimal",
      webSearchPolicy: "disabled",
      webSearchMode: "disabled",
    });
    expect(invocation.argv).toContain("app-server");
    expect(invocation.argv).not.toContain("shell_tool");
    expect(invocation.env.CODEX_HOME).not.toBe(harness.authHome);
    expect(invocation.threadStart).toMatchObject({
      cwd: harness.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      persistExtendedHistory: false,
      model: "gpt-test",
    });
    expect(invocation.threadStart.config).toEqual({ web_search: "disabled" });
    expect(invocation.turnStart).toMatchObject({
      approvalPolicy: "never",
      model: "gpt-test",
      effort: "minimal",
      sandboxPolicy: {
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: false,
      },
    });
    expect(invocation.turnStart?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
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
      nativeReviewOutput: "rendered-text",
      nativeReviewStructuredFindings: false,
      requestedEffort: "high",
      resolvedEffort: "high",
      webSearchPolicy: "disabled",
      requestedWebSearchMode: "disabled",
      webSearchMode: "disabled",
      effectiveWebSearchMode: "disabled",
      effectiveWebSearchReason: "codex-native-review-disables-web-search",
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
      nativeReviewOutput: "rendered-text",
      nativeReviewStructuredFindings: false,
      requestedEffort: "high",
      resolvedEffort: "high",
      webSearchPolicy: "disabled",
      requestedWebSearchMode: "disabled",
      webSearchMode: "disabled",
      effectiveWebSearchMode: "disabled",
      effectiveWebSearchReason: "codex-native-review-disables-web-search",
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
  threadStart: {
    cwd: string;
    approvalPolicy: string;
    sandbox: string;
    ephemeral: boolean;
    persistExtendedHistory: boolean;
    model?: string;
    config?: unknown;
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
  unsupportedResponse?: unknown;
};

function createSocketHarness(): Harness & { socketPath: string; start(): Promise<void> } {
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
      server = createFakeWebSocketAppServer(socketPath, invocation, invocationPath);
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
    requestApproval?: boolean;
    legacyApproval?: boolean;
    retryableError?: boolean;
    sourceConfig?: string;
    unsupportedRequest?: boolean;
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
      ...(options.requestApproval ? { DIFFWARDEN_FAKE_APP_SERVER_APPROVAL: "1" } : {}),
      ...(options.legacyApproval ? { DIFFWARDEN_FAKE_APP_SERVER_LEGACY_APPROVAL: "1" } : {}),
      ...(options.retryableError ? { DIFFWARDEN_FAKE_APP_SERVER_RETRYABLE_ERROR: "1" } : {}),
      ...(options.unsupportedRequest ? { DIFFWARDEN_FAKE_APP_SERVER_UNSUPPORTED: "1" } : {}),
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
        handleFakeAppServerMessage(JSON.parse(payload), invocation, invocationPath, socket);
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
): void {
  invocation.messages.push(message);
  if (message.method === "initialize") {
    fakeSocketSend(socket, { id: message.id, result: { serverInfo: { name: "fake-codex" } } });
    return;
  }
  if (message.method === "thread/start") {
    invocation.threadStart = message.params as FakeInvocation["threadStart"];
    fakeSocketSend(socket, { id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "turn/start") {
    invocation.turnStart = message.params as FakeInvocation["turnStart"];
    fakeSocketSend(socket, { id: message.id, result: { turn: { id: "turn-1" } } });
    finishFakeSocketInvocation(invocation, invocationPath, socket);
  }
}

function finishFakeSocketInvocation(
  invocation: FakeInvocation & { messages: unknown[] },
  invocationPath: string,
  socket: Socket,
): void {
  const review = {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "codex app-server ok",
    overall_confidence_score: 0.91,
  };
  fakeSocketSend(socket, {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: JSON.stringify(review),
    },
  });
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
    finish();
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
  if (message.method === "initialize") {
    send({ id: message.id, result: { serverInfo: { name: "fake-codex" } } });
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
    if (process.env.DIFFWARDEN_FAKE_APP_SERVER_APPROVAL) {
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
        threadId: "thread-1",
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
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: JSON.stringify(review)
      }
    });
  }
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
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
        threadId: "thread-1",
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
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    }
  });
}
`;
}
