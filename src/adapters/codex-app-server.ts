import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { type Socket, createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { buildTextAdapterOutput, normalizeJsonLikeAdapterOutput } from "../core/adapter-output.js";
import { missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
import { reviewResultStrictJsonSchema } from "../core/schema.js";
import type { ReviewTargetResolved } from "../core/schema.js";
import { version } from "../version.js";
import { cliExecutable } from "./cli-helpers.js";
import { resolveExecutable, trimForMetadata } from "./cli-process.js";
import {
  type CodexAppServerReviewMode,
  type CodexWebSearchMode,
  type CodexWebSearchPolicy,
  codexAppServerReviewMode,
  codexAppServerWebSearchPolicy,
  codexWebSearchMetadata,
  codexWebSearchMode,
} from "./codex-options.js";
import {
  type ResolutionSource,
  effortResolutionMetadata,
  modelResolutionMetadata,
} from "./metadata.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerConfig,
} from "./types.js";

type JsonRpcMessage = Record<string, unknown>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexAppServerRunContext = {
  kind: "codex-app-server";
  requestedExecutable: string;
  resolvedExecutable: string;
  mode: CodexAppServerMode;
  codexHome?: string;
  path?: string;
};

type CodexAppServerMode = "auto" | "attach" | "launch" | "stdio-isolated";

type CodexAppServerOptions = {
  mode: CodexAppServerMode;
  codexHome: string;
  socketPath: string;
  sharedCodexHome: boolean;
  effort?: string;
  webSearchPolicy: CodexWebSearchPolicy;
  webSearchMode?: CodexWebSearchMode;
  reviewMode: CodexAppServerReviewMode;
};

type SpawnedAppServer = {
  child: ChildProcessWithoutNullStreams;
  codexHome: string;
  executable: string;
};

type AppServerConnectionMetadata = {
  executable: string;
  appServerMode: CodexAppServerMode;
  codexHome: string;
  codexHomeShared: boolean;
  serverLifecycle: "isolated-stdio" | "reused" | "launched";
  socketPath?: string;
};

type AppServerConnection = {
  metadata: AppServerConnectionMetadata;
  stderr(): string;
  write(message: JsonRpcMessage): void;
  close(): Promise<void>;
};

const appServerKillGraceMs = 1_000;
const appServerConnectRetryMs = 100;
const appServerLaunchTimeoutMs = 5_000;
const appServerHandshakeTimeoutMs = 2_000;

export function createCodexAppServerAdapter(): ReviewAdapter {
  return {
    name: "codex:app-server",
    async preflight(input) {
      return prepareCodexAppServerAdapter(input).then((prepared) => prepared.preflight);
    },
    async prepare(input) {
      return prepareCodexAppServerAdapter(input);
    },
    async run(input) {
      const runContext = codexAppServerRunContext(input.runContext);
      const options = codexAppServerOptions(input.reviewer, input.env);
      const executable =
        runContext !== undefined &&
        runContext.requestedExecutable === codexAppServerExecutable(input.reviewer) &&
        runContext.mode === options.mode &&
        runContext.codexHome === options.codexHome &&
        runContext.path === pathContext(input.env).path
          ? runContext.resolvedExecutable
          : await resolveExecutable(codexAppServerExecutable(input.reviewer), input.env);
      const session = new CodexAppServerSession(input, executable, options);
      return await session.run();
    },
  };
}

async function prepareCodexAppServerAdapter(
  input: ReviewAdapterPreflightInput,
): Promise<{ preflight: ReviewAdapterPreflightResult; runContext: CodexAppServerRunContext }> {
  const executable = codexAppServerExecutable(input.reviewer);
  const resolvedExecutable = await resolveExecutable(executable, input.env);
  const options = codexAppServerOptions(input.reviewer, input.env);
  await assertCodexAuthAvailable(authHomeForMode(options, input.env));

  const metadata: ReviewAdapterPreflightResult["metadata"] = {
    readonlyCapability: "enforced",
    transport: "app-server",
    executable: resolvedExecutable,
    execEnabled: true,
    ephemeral: true,
    appServerMode: options.mode,
    codexHome: options.codexHome,
    codexHomeShared: options.sharedCodexHome,
    ...codexAppServerReviewModeMetadata(options),
    ...codexAppServerWebSearchMetadata(options),
    ...(options.mode === "stdio-isolated" ? {} : { socketPath: options.socketPath }),
    ...codexAppServerSelectionMetadata(input.reviewer),
  };

  return {
    preflight: {
      checks: [
        {
          name: "executable",
          status: "passed",
          detail: `Using ${resolvedExecutable}.`,
        },
        {
          name: "auth",
          status: "passed",
          detail:
            options.mode === "stdio-isolated"
              ? "Codex auth.json is available for isolated app-server runs."
              : `Codex auth.json is available in shared CODEX_HOME: ${options.codexHome}.`,
        },
        {
          name: "readonly",
          status: "passed",
          detail:
            options.mode === "stdio-isolated"
              ? "Codex app-server runs with ephemeral read-only threads, approval policy never, and temporary CODEX_HOME isolation."
              : "Codex app-server runs with ephemeral read-only threads, approval policy never, and shared CODEX_HOME app-server state.",
        },
        {
          name: "codex-home",
          status: options.sharedCodexHome ? "warning" : "passed",
          detail:
            options.mode === "stdio-isolated"
              ? "Diffwarden will create and remove a temporary CODEX_HOME for this review."
              : `Diffwarden will use shared CODEX_HOME ${options.codexHome}; existing Codex config, auth, plugins, apps, and daemon state may apply.`,
        },
        {
          name: "exec",
          status: "warning",
          detail:
            "Codex app-server command execution remains enabled for this experimental transport; approval escalations are denied.",
        },
        {
          name: "web-search",
          status:
            options.reviewMode === "native" || options.webSearchPolicy === "inherit"
              ? "warning"
              : "passed",
          detail: codexAppServerWebSearchDetail(options),
        },
        {
          name: "review-mode",
          status: options.reviewMode === "native" ? "warning" : "passed",
          detail:
            options.reviewMode === "native"
              ? "Diffwarden will use experimental Codex native review/start mode; this returns rendered review text, not structured findings."
              : "Diffwarden will use schema-constrained turn/start mode.",
        },
        {
          name: "model",
          status: input.reviewer.model === undefined ? "skipped" : "passed",
          detail:
            input.reviewer.model === undefined
              ? "No model override was requested."
              : `Passing model override to Codex app-server: ${input.reviewer.model}.`,
        },
        {
          name: "effort",
          status: input.reviewer.effort === undefined ? "skipped" : "passed",
          detail:
            input.reviewer.effort === undefined
              ? "No effort override was requested."
              : `Passing effort override to Codex app-server: ${codexAppServerEffort(input.reviewer.effort)}.`,
        },
      ],
      metadata,
    },
    runContext: {
      kind: "codex-app-server",
      requestedExecutable: executable,
      resolvedExecutable,
      mode: options.mode,
      codexHome: options.codexHome,
      ...pathContext(input.env),
    },
  };
}

class CodexAppServerSession {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly completedTurns = new Set<string>();
  private nextId = 1;
  private connection: AppServerConnection | undefined;
  private reply = "";
  private currentAgentMessageId = "";
  private currentAgentMessageText = "";
  private turnCompletion:
    | { turnId: string; resolve: () => void; reject: (error: Error) => void }
    | undefined;
  private usage: unknown;

  constructor(
    private readonly input: ReviewAdapterInput,
    private readonly executable: string,
    private readonly options: CodexAppServerOptions,
  ) {}

  async run(): Promise<ReviewAdapterOutput> {
    throwIfAborted(this.input.signal, "codex app-server reviewer aborted before start");
    const connection = await openCodexAppServerConnection({
      executable: this.executable,
      env: this.input.env,
      options: this.options,
      onMessage: (message) => this.onMessage(message),
      onFailure: (error) => {
        this.rejectAll(error);
        this.turnCompletion?.reject(error);
      },
    });
    this.connection = connection;
    const removeAbortListener = bindAbortSignal(this.input.signal, () => {
      const error = reviewerFailed("codex app-server reviewer aborted");
      this.rejectAll(error);
      this.turnCompletion?.reject(error);
      void this.close();
    });

    try {
      throwIfAborted(this.input.signal, "codex app-server reviewer aborted");
      await this.call("initialize", {
        clientInfo: {
          name: "diffwarden",
          title: "Diffwarden",
          version,
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.notify("initialized");
      const threadResponse = await this.call("thread/start", {
        cwd: this.input.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ...codexAppServerThreadConfig(this.options),
        developerInstructions: codexDeveloperInstructions(),
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ...codexAppServerThreadModelOptions(this.input.reviewer),
      });
      const threadId = stringAtPath(threadResponse, ["thread", "id"]);
      if (threadId === undefined) {
        throw reviewerFailed("codex app-server did not return a thread id");
      }

      if (this.options.reviewMode === "native") {
        return await this.runNativeReview(connection, threadId);
      }
      return await this.runStructuredReview(connection, threadId);
    } finally {
      removeAbortListener();
      await this.close();
    }
  }

  private async runStructuredReview(
    connection: AppServerConnection,
    threadId: string,
  ): Promise<ReviewAdapterOutput> {
    const turnWait = this.waitForTurn();
    void turnWait.catch(() => undefined);
    const turnResponse = await this.call("turn/start", {
      threadId,
      input: [{ type: "text", text: this.input.prompt, text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: false,
      },
      outputSchema: reviewResultStrictJsonSchema,
      ...codexAppServerTurnModelOptions(this.input.reviewer),
      ...(this.input.reviewer.effort !== undefined
        ? { effort: codexAppServerEffort(this.input.reviewer.effort) }
        : {}),
    });
    const turnId = stringAtPath(turnResponse, ["turn", "id"]);
    if (turnId !== undefined && this.turnCompletion !== undefined) {
      this.turnCompletion.turnId = turnId;
      if (this.completedTurns.has(turnId)) {
        this.turnCompletion.resolve();
      }
    }
    this.onTurn(turnResponse);
    await turnWait;

    const output = normalizeJsonLikeAdapterOutput(this.reply, {
      captureMode: "native-structured",
      readonlyCapability: "enforced",
      transport: "app-server",
      execEnabled: true,
      ephemeral: true,
      ...codexAppServerReviewModeMetadata(this.options),
      ...connection.metadata,
      stderr: trimForMetadata(connection.stderr()),
      ...codexAppServerWebSearchMetadata(this.options),
      ...codexAppServerSelectionMetadata(this.input.reviewer),
    });
    return {
      ...output,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }

  private async runNativeReview(
    connection: AppServerConnection,
    threadId: string,
  ): Promise<ReviewAdapterOutput> {
    const turnWait = this.waitForTurn();
    void turnWait.catch(() => undefined);
    const reviewResponse = await this.call("review/start", {
      threadId,
      target: codexNativeReviewTarget(this.input.target, this.input.prompt),
      delivery: "inline",
    });
    const turnId = stringAtPath(reviewResponse, ["turn", "id"]);
    if (turnId !== undefined && this.turnCompletion !== undefined) {
      this.turnCompletion.turnId = turnId;
      if (this.completedTurns.has(turnId)) {
        this.turnCompletion.resolve();
      }
    }
    this.onTurn(reviewResponse);
    await turnWait;

    return buildTextAdapterOutput({
      text: this.reply.trim(),
      usage: this.usage,
      metadata: {
        captureMode: "text",
        readonlyCapability: "enforced",
        transport: "app-server",
        execEnabled: true,
        ephemeral: true,
        ...codexAppServerReviewModeMetadata(this.options),
        ...connection.metadata,
        stderr: trimForMetadata(connection.stderr()),
        ...codexAppServerWebSearchMetadata(this.options),
        ...codexAppServerSelectionMetadata(this.input.reviewer),
      },
    });
  }

  private call(method: string, params: unknown): Promise<unknown> {
    if (this.connection === undefined) {
      throw reviewerFailed("codex app-server is not running");
    }

    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.writeClientMessage({ id, method, params });
    return promise;
  }

  private notify(method: string, params?: unknown): void {
    this.writeClientMessage(params === undefined ? { method } : { method, params });
  }

  private respond(id: unknown, result: unknown): void {
    this.writeClientMessage({ id, result });
  }

  private respondError(id: unknown, code: number, message: string): void {
    this.writeClientMessage({
      id,
      error: {
        code,
        message,
      },
    });
  }

  private writeClientMessage(message: JsonRpcMessage): void {
    const connection = this.connection;
    if (connection === undefined) {
      this.onStdinFailure(new Error("codex app-server connection is not writable"));
      return;
    }

    try {
      connection.write(message);
    } catch (error) {
      this.onStdinFailure(error);
    }
  }

  private onStdinFailure(error: unknown): void {
    const classified = reviewerFailed(`codex app-server stdin failed: ${formatError(error)}`);
    this.rejectAll(classified);
    this.turnCompletion?.reject(classified);
  }

  private onMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);
      if ("error" in message && message.error !== undefined) {
        pending.reject(
          reviewerFailed(`codex app-server request failed: ${formatError(message.error)}`),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (isServerRequest(message)) {
      this.onServerRequest(message);
      return;
    }

    const method = typeof message.method === "string" ? message.method : "";
    if (method === "item/agentMessage/delta") {
      const params = isRecord(message.params) ? message.params : {};
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = typeof params.itemId === "string" ? params.itemId : "agent-message";
      if (itemId !== this.currentAgentMessageId) {
        this.currentAgentMessageId = itemId;
        this.currentAgentMessageText = "";
      }
      this.currentAgentMessageText += delta;
      this.reply = this.currentAgentMessageText || this.reply;
      return;
    }

    if (method === "item/completed") {
      const item =
        isRecord(message.params) && isRecord(message.params.item) ? message.params.item : {};
      this.captureThreadItem(item);
      return;
    }

    if (method === "turn/completed") {
      this.onTurn(message.params);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      this.usage = isRecord(message.params) ? message.params.tokenUsage : undefined;
      return;
    }

    if (method === "error") {
      if (booleanAtPath(message.params, ["willRetry"]) === true) {
        return;
      }
      const error = reviewerFailed(`codex app-server error: ${formatError(message.params)}`);
      this.turnCompletion?.reject(error);
    }
  }

  private onServerRequest(message: JsonRpcMessage): void {
    const method = typeof message.method === "string" ? message.method : "";
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.respond(message.id, { decision: "decline" });
        return;
      case "applyPatchApproval":
      case "execCommandApproval":
        this.respond(message.id, { decision: "denied" });
        return;
      case "item/permissions/requestApproval":
        this.respond(message.id, {
          permissions: {},
          scope: "turn",
          strictAutoReview: true,
        });
        return;
      case "item/tool/requestUserInput":
        this.respond(message.id, { answers: {} });
        return;
      case "item/tool/call":
        this.respond(message.id, {
          success: false,
          contentItems: [{ type: "inputText", text: "Diffwarden does not expose dynamic tools." }],
        });
        return;
      default:
        this.respondError(message.id, -32601, `Unsupported Codex app-server request: ${method}`);
    }
  }

  private onTurn(value: unknown): void {
    const turn = isRecord(value) && isRecord(value.turn) ? value.turn : {};
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      if (isRecord(item)) {
        this.captureThreadItem(item);
      }
    }

    const status = typeof turn.status === "string" ? turn.status : undefined;
    if (status === undefined || status === "inProgress") {
      return;
    }
    if (status !== "completed") {
      const error = reviewerFailed(formatTurnFailure(turn, status));
      this.turnCompletion?.reject(error);
      this.turnCompletion = undefined;
      return;
    }
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    if (turnId !== undefined) {
      this.completedTurns.add(turnId);
    }
    if (this.turnCompletion !== undefined) {
      if (!this.turnCompletion.turnId || this.turnCompletion.turnId === turnId) {
        this.turnCompletion.resolve();
        this.turnCompletion = undefined;
      }
    }
  }

  private captureThreadItem(item: Record<string, unknown>): void {
    if (item.type === "agentMessage" && typeof item.text === "string") {
      this.currentAgentMessageId = typeof item.id === "string" ? item.id : "agent-message";
      this.currentAgentMessageText = item.text;
      this.reply = item.text;
      return;
    }
    if (item.type === "exitedReviewMode" && typeof item.review === "string") {
      this.reply = item.review;
    }
  }

  private waitForTurn(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.turnCompletion = { turnId: "", resolve, reject };
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.close();
  }
}

async function openCodexAppServerConnection(options: {
  executable: string;
  env: NodeJS.ProcessEnv | undefined;
  options: CodexAppServerOptions;
  onMessage: (message: JsonRpcMessage) => void;
  onFailure: (error: Error) => void;
}): Promise<AppServerConnection> {
  if (options.options.mode === "stdio-isolated") {
    return await openStdioIsolatedConnection(options);
  }
  return await openSharedSocketConnection(options);
}

async function openStdioIsolatedConnection(options: {
  executable: string;
  env: NodeJS.ProcessEnv | undefined;
  options: CodexAppServerOptions;
  onMessage: (message: JsonRpcMessage) => void;
  onFailure: (error: Error) => void;
}): Promise<AppServerConnection> {
  const spawned = await spawnCodexAppServer({
    executable: options.executable,
    env: options.env,
    options: options.options,
  });
  let stderr = "";
  const stdout = createInterface({ input: spawned.child.stdout });
  stdout.on("line", (line) => {
    const message = parseJsonRpcLine(line);
    if (message !== undefined) {
      options.onMessage(message);
    }
  });
  spawned.child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  spawned.child.stdin.on("error", (error) => {
    options.onFailure(reviewerFailed(`codex app-server stdin failed: ${formatError(error)}`));
  });
  spawned.child.on("error", (error) => {
    options.onFailure(classifyAppServerStartError(options.executable, error));
  });
  spawned.child.on("close", (code, signal) => {
    options.onFailure(
      reviewerFailed(
        `codex app-server exited before review completed: ${code ?? `signal ${signal ?? "none"}`}`,
      ),
    );
  });

  return {
    metadata: {
      executable: spawned.executable,
      appServerMode: "stdio-isolated",
      codexHome: spawned.codexHome,
      codexHomeShared: false,
      serverLifecycle: "isolated-stdio",
    },
    stderr: () => stderr,
    write(message) {
      if (spawned.child.stdin.destroyed || !spawned.child.stdin.writable) {
        throw reviewerFailed("codex app-server stdin is not writable");
      }
      spawned.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          options.onFailure(reviewerFailed(`codex app-server stdin failed: ${error.message}`));
        }
      });
    },
    async close() {
      stdout.close();
      await closeSpawnedIsolatedAppServer(spawned);
    },
  };
}

async function openSharedSocketConnection(options: {
  executable: string;
  env: NodeJS.ProcessEnv | undefined;
  options: CodexAppServerOptions;
  onMessage: (message: JsonRpcMessage) => void;
  onFailure: (error: Error) => void;
}): Promise<AppServerConnection> {
  const existing = await tryConnectCodexSocket(options.options.socketPath, options);
  if (existing !== undefined) {
    return existing;
  }
  if (options.options.mode === "attach") {
    throw missingRequirement(
      `Codex app-server is not running at ${options.options.socketPath}; start it or use appServerOptions.mode "auto"`,
    );
  }

  const launched = launchSharedCodexAppServer({
    executable: options.executable,
    env: options.env,
    codexHome: options.options.codexHome,
  });
  try {
    return await waitForSharedSocketConnection(options, launched);
  } catch (error) {
    launched.child.kill("SIGTERM");
    throw error;
  }
}

async function waitForSharedSocketConnection(
  options: {
    executable: string;
    options: CodexAppServerOptions;
    onMessage: (message: JsonRpcMessage) => void;
    onFailure: (error: Error) => void;
  },
  launched: { child: ChildProcess; startedAt: number },
): Promise<AppServerConnection> {
  let startError: Error | undefined;
  launched.child.once("error", (error) => {
    startError = classifyAppServerStartError(options.executable, error);
  });

  const deadline = Date.now() + appServerLaunchTimeoutMs;
  while (Date.now() < deadline) {
    if (startError !== undefined) {
      throw startError;
    }
    const connected = await tryConnectCodexSocket(options.options.socketPath, options);
    if (connected !== undefined) {
      connected.metadata.serverLifecycle = "launched";
      return connected;
    }
    await sleep(appServerConnectRetryMs);
  }

  throw reviewerFailed(
    `timed out waiting for codex app-server socket: ${options.options.socketPath}`,
  );
}

async function tryConnectCodexSocket(
  socketPath: string,
  options: {
    executable: string;
    options: CodexAppServerOptions;
    onMessage: (message: JsonRpcMessage) => void;
    onFailure: (error: Error) => void;
  },
): Promise<AppServerConnection | undefined> {
  try {
    const socket = await CodexUnixSocketJsonRpc.connect(socketPath, options.onMessage, (error) => {
      options.onFailure(reviewerFailed(`codex app-server socket failed: ${formatError(error)}`));
    });
    return {
      metadata: {
        executable: options.executable,
        appServerMode: options.options.mode,
        codexHome: options.options.codexHome,
        codexHomeShared: options.options.sharedCodexHome,
        socketPath,
        serverLifecycle: "reused",
      },
      stderr: () => "",
      write(message) {
        socket.write(message);
      },
      close() {
        return socket.close();
      },
    };
  } catch (error) {
    if (
      isNodeErrorWithCode(error, "ENOENT") ||
      isNodeErrorWithCode(error, "ECONNREFUSED") ||
      isNodeErrorWithCode(error, "ENOTSOCK")
    ) {
      return undefined;
    }
    throw error;
  }
}

function launchSharedCodexAppServer(options: {
  executable: string;
  env: NodeJS.ProcessEnv | undefined;
  codexHome: string;
}): { child: ChildProcess; startedAt: number } {
  const env = {
    ...(options.env ?? process.env),
    CODEX_HOME: options.codexHome,
  };
  const child = spawn(options.executable, ["app-server", "--listen", "unix://"], {
    cwd: options.codexHome,
    detached: process.platform !== "win32",
    env,
    stdio: "ignore",
  });
  child.unref();
  return { child, startedAt: Date.now() };
}

async function closeSpawnedIsolatedAppServer(spawned: SpawnedAppServer): Promise<void> {
  let exited = spawned.child.exitCode !== null || spawned.child.signalCode !== null;
  const exit = exited
    ? Promise.resolve()
    : once(spawned.child, "exit")
        .then(() => {
          exited = true;
        })
        .catch(() => {
          exited = true;
        });
  if (!spawned.child.killed) {
    killChildProcessGroup(spawned.child, "SIGTERM");
  }
  await Promise.race([exit, sleep(appServerKillGraceMs)]);
  if (!exited) {
    killChildProcessGroup(spawned.child, "SIGKILL");
    await Promise.race([exit, sleep(appServerKillGraceMs)]);
  }
  await rm(spawned.codexHome, { force: true, recursive: true });
}

function killChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }
  child.kill(signal);
}

class CodexUnixSocketJsonRpc {
  private buffer = Buffer.alloc(0);
  private readonly fragments: Buffer[] = [];
  private closed = false;
  private intentionalClose = false;

  private constructor(
    private readonly socket: Socket,
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly onFailure: (error: Error) => void,
  ) {}

  static async connect(
    socketPath: string,
    onMessage: (message: JsonRpcMessage) => void,
    onFailure: (error: Error) => void,
  ): Promise<CodexUnixSocketJsonRpc> {
    const socket = createConnection(socketPath);
    const client = new CodexUnixSocketJsonRpc(socket, onMessage, onFailure);
    await client.handshake();
    socket.on("data", (chunk) => client.onData(chunk));
    socket.on("error", (error) => {
      if (!client.closed) {
        onFailure(error);
      }
    });
    socket.on("close", () => {
      if (!client.intentionalClose) {
        onFailure(reviewerFailed("codex app-server socket closed"));
      }
      client.closed = true;
    });
    return client;
  }

  write(message: JsonRpcMessage): void {
    if (this.closed || this.socket.destroyed || !this.socket.writable) {
      throw reviewerFailed("codex app-server socket is not writable");
    }
    this.socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(message), "utf8"), true));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.intentionalClose = true;
    this.closed = true;
    try {
      if (!this.socket.destroyed && this.socket.writable) {
        this.socket.write(encodeWebSocketFrame(Buffer.alloc(0), true, 0x8));
      }
    } catch {
      // Closing is best-effort.
    }
    this.socket.end();
    await Promise.race([once(this.socket, "close"), sleep(appServerKillGraceMs)]);
    this.socket.destroy();
  }

  private async handshake(): Promise<void> {
    const key = randomBytes(16).toString("base64");
    const request = [
      "GET /rpc HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          reviewerFailed(
            `timed out waiting for codex app-server socket upgrade: ${this.socket.remoteAddress ?? "unix socket"}`,
          ),
        );
      }, appServerHandshakeTimeoutMs);
      const onConnect = () => {
        this.socket.write(request);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(reviewerFailed("codex app-server socket closed before upgrade completed"));
      };
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = this.buffer.subarray(0, headerEnd).toString("utf8");
        this.buffer = this.buffer.subarray(headerEnd + 4);
        cleanup();
        if (!/^HTTP\/1\.1 101\b/i.test(header)) {
          reject(reviewerFailed(`codex app-server socket upgrade failed: ${firstLine(header)}`));
          return;
        }
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("connect", onConnect);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
        this.socket.off("end", onClose);
        this.socket.off("data", onData);
      };
      this.socket.on("connect", onConnect);
      this.socket.on("error", onError);
      this.socket.on("close", onClose);
      this.socket.on("end", onClose);
      this.socket.on("data", onData);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.consumeFrames();
    } catch (error) {
      this.onFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consumeFrames(): void {
    while (true) {
      const frame = decodeWebSocketFrame(this.buffer);
      if (frame === undefined) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 0x8) {
        this.closed = true;
        this.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeWebSocketFrame(frame.payload, true, 0xa));
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        this.fragments.push(frame.payload);
        if (!frame.fin) {
          continue;
        }
        const payload = Buffer.concat(this.fragments).toString("utf8");
        this.fragments.length = 0;
        const parsed = parseJsonRpcPayload(payload);
        if (parsed !== undefined) {
          this.onMessage(parsed);
        }
      }
    }
  }
}

function encodeWebSocketFrame(payload: Buffer, mask: boolean, opcode = 0x1): Buffer {
  const length = payload.length;
  const lengthBytes =
    length < 126
      ? Buffer.from([length])
      : length <= 0xffff
        ? Buffer.from([126, (length >> 8) & 0xff, length & 0xff])
        : websocketUInt64(length);
  const maskKey = mask ? randomBytes(4) : Buffer.alloc(0);
  const header = Buffer.concat([
    Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | (lengthBytes[0] ?? 0)]),
    lengthBytes.subarray(1),
    maskKey,
  ]);
  if (!mask) {
    return Buffer.concat([header, payload]);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++) {
    masked[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
  }
  return Buffer.concat([header, masked]);
}

function websocketUInt64(length: number): Buffer {
  const buffer = Buffer.alloc(9);
  buffer[0] = 127;
  buffer.writeBigUInt64BE(BigInt(length), 1);
  return buffer;
}

function decodeWebSocketFrame(
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
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return undefined;
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw reviewerFailed("codex app-server websocket frame is too large");
    }
    length = Number(bigLength);
    offset += 8;
  }
  const masked = (second & 0x80) !== 0;
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
  if (masked) {
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

async function spawnCodexAppServer(options: {
  executable: string;
  env: NodeJS.ProcessEnv | undefined;
  options: CodexAppServerOptions;
}): Promise<SpawnedAppServer> {
  const codexHome = await createIsolatedCodexHome(options.env, options.options);
  const env = {
    ...(options.env ?? process.env),
    CODEX_HOME: codexHome,
  };
  const args = [
    "app-server",
    "--listen",
    "stdio://",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "computer_use",
    "--disable",
    "browser_use",
    "--disable",
    "in_app_browser",
    "--disable",
    "image_generation",
    "--disable",
    "multi_agent",
  ];
  try {
    const child = spawn(options.executable, args, {
      cwd: path.join(codexHome, "workspace"),
      detached: process.platform !== "win32",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { child, codexHome, executable: options.executable };
  } catch (error) {
    await rm(codexHome, { force: true, recursive: true });
    throw error;
  }
}

async function createIsolatedCodexHome(
  env: NodeJS.ProcessEnv | undefined,
  options: CodexAppServerOptions,
): Promise<string> {
  const sourceHome = codexAuthHome(env);
  const authPath = path.join(sourceHome, "auth.json");
  try {
    await access(authPath, constants.R_OK);
  } catch {
    throw missingAuth(`Codex auth.json not found or not readable: ${authPath}`);
  }

  const codexHome = await mkdtemp(path.join(tmpdir(), "diffwarden-codex-home-"));
  try {
    await mkdir(path.join(codexHome, "workspace"));
    const targetAuthPath = path.join(codexHome, "auth.json");
    try {
      await symlink(authPath, targetAuthPath);
    } catch {
      await copyFile(authPath, targetAuthPath);
    }
    await writeFile(
      path.join(codexHome, "config.toml"),
      await isolatedCodexConfig(sourceHome, options),
      "utf8",
    );
    return codexHome;
  } catch (error) {
    await rm(codexHome, { force: true, recursive: true });
    throw error;
  }
}

async function isolatedCodexConfig(
  sourceHome: string,
  options: CodexAppServerOptions,
): Promise<string> {
  const sourceConfig = await readSourceConfig(sourceHome);
  const providerConfig = sourceConfig === undefined ? "" : extractModelProviderConfig(sourceConfig);
  const webSearchConfig =
    options.webSearchPolicy === "inherit" && sourceConfig !== undefined
      ? extractTopLevelConfigAssignment(sourceConfig, "web_search")
      : "";
  return [
    webSearchConfig,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    providerConfig,
    "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

async function readSourceConfig(sourceHome: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(sourceHome, "config.toml"), "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function extractModelProviderConfig(config: string): string {
  const lines = config.split(/\r?\n/);
  const selected: string[] = [];
  let inModelProviderTable = false;

  for (const line of lines) {
    const header = tomlTableHeader(line);
    if (header !== undefined) {
      inModelProviderTable = header === "model_providers" || header.startsWith("model_providers.");
    }
    if (inModelProviderTable) {
      selected.push(line);
    }
  }

  return selected.join("\n").trim();
}

function extractTopLevelConfigAssignment(config: string, key: string): string {
  for (const line of config.split(/\r?\n/)) {
    if (tomlTableHeader(line) !== undefined) {
      return "";
    }
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
      return line.trim();
    }
  }
  return "";
}

function codexAppServerOptions(
  reviewer: ReviewReviewerConfig,
  env: NodeJS.ProcessEnv | undefined,
): CodexAppServerOptions {
  const mode = codexAppServerMode(reviewer);
  const codexHome = resolveCodexHome(reviewer, env);
  const webSearchPolicy = codexAppServerWebSearchPolicy(reviewer);
  const webSearchMode = codexWebSearchMode(webSearchPolicy);
  return {
    mode,
    codexHome,
    socketPath: path.join(codexHome, "app-server-control", "app-server-control.sock"),
    sharedCodexHome: mode !== "stdio-isolated",
    ...(reviewer.effort !== undefined ? { effort: codexAppServerEffort(reviewer.effort) } : {}),
    webSearchPolicy,
    ...(webSearchMode !== undefined ? { webSearchMode } : {}),
    reviewMode: codexAppServerReviewMode(reviewer),
  };
}

function codexAppServerMode(reviewer: ReviewReviewerConfig): CodexAppServerMode {
  const value = reviewer.appServerOptions?.mode;
  if (value === undefined) {
    return "auto";
  }
  if (value === "auto" || value === "attach" || value === "launch" || value === "stdio-isolated") {
    return value;
  }
  throw reviewerFailed(`Invalid Codex appServerOptions.mode: ${String(value)}`);
}

function codexAppServerThreadConfig(
  options: CodexAppServerOptions,
): { config: Record<string, string> } | Record<string, never> {
  const config: Record<string, string> = {};
  if (options.reviewMode === "native") {
    config.web_search = "disabled";
    if (options.effort !== undefined) {
      config.model_reasoning_effort = options.effort;
    }
    return { config };
  }
  if (options.webSearchMode !== undefined) {
    config.web_search = options.webSearchMode;
  }
  return Object.keys(config).length === 0 ? {} : { config };
}

function codexAppServerWebSearchMetadata(options: CodexAppServerOptions): Record<string, string> {
  if (options.reviewMode !== "native") {
    const requested = codexWebSearchMode(options.webSearchPolicy);
    return {
      ...codexWebSearchMetadata(options.webSearchPolicy),
      ...(requested !== undefined ? { effectiveWebSearchMode: requested } : {}),
    };
  }

  const requested = codexWebSearchMode(options.webSearchPolicy);
  return {
    webSearchPolicy: options.webSearchPolicy,
    ...(requested !== undefined ? { requestedWebSearchMode: requested } : {}),
    webSearchMode: "disabled",
    effectiveWebSearchMode: "disabled",
    effectiveWebSearchReason: "codex-native-review-disables-web-search",
  };
}

function codexAppServerWebSearchDetail(options: CodexAppServerOptions): string {
  if (options.reviewMode === "native") {
    return "Codex native review/start disables web search inside the review task; Diffwarden will report effective webSearchMode disabled.";
  }
  if (options.webSearchPolicy === "inherit") {
    return "Diffwarden will not override Codex web_search for this app-server review.";
  }
  return `Diffwarden will set Codex web_search to ${options.webSearchMode}.`;
}

function codexAppServerReviewModeMetadata(
  options: CodexAppServerOptions,
): Record<string, string | boolean> {
  if (options.reviewMode === "native") {
    return {
      codexReviewMode: "native",
      nativeReviewOutput: "rendered-text",
      nativeReviewStructuredFindings: false,
    };
  }
  return {
    codexReviewMode: "structured",
  };
}

function codexNativeReviewTarget(
  target: ReviewTargetResolved,
  prompt: string,
): Record<string, unknown> {
  switch (target.kind) {
    case "uncommitted":
      return { type: "uncommittedChanges" };
    case "base":
      if (target.base_ref === undefined) {
        throw reviewerFailed("Codex native review requires target.base_ref for base targets");
      }
      return { type: "baseBranch", branch: target.base_ref };
    case "commit":
      if (target.commit_sha === undefined) {
        throw reviewerFailed("Codex native review requires target.commit_sha for commit targets");
      }
      return { type: "commit", sha: target.commit_sha };
    case "custom":
      return { type: "custom", instructions: prompt };
    case "pr":
      throw reviewerFailed("Codex native review does not support pr targets");
    default: {
      const exhaustive: never = target.kind;
      throw reviewerFailed(`Unsupported Codex native review target: ${String(exhaustive)}`);
    }
  }
}

function resolveCodexHome(
  reviewer: ReviewReviewerConfig,
  env: NodeJS.ProcessEnv | undefined,
): string {
  const effectiveEnv = env ?? process.env;
  const configured = optionalStringOption(reviewer.appServerOptions, "codexHome");
  return absoluteHomePath(
    configured ||
      effectiveEnv.DIFFWARDEN_CODEX_HOME?.trim() ||
      effectiveEnv.DIFFWARDEN_CODEX_AUTH_HOME?.trim() ||
      effectiveEnv.CODEX_HOME?.trim() ||
      path.join(effectiveEnv.HOME?.trim() || homedir(), ".codex"),
  );
}

function absoluteHomePath(value: string): string {
  const expanded =
    value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  return path.resolve(expanded);
}

function authHomeForMode(
  options: CodexAppServerOptions,
  env: NodeJS.ProcessEnv | undefined,
): string {
  return options.mode === "stdio-isolated" ? codexAuthHome(env) : options.codexHome;
}

function codexAuthHome(env: NodeJS.ProcessEnv | undefined): string {
  const effectiveEnv = env ?? process.env;
  return (
    effectiveEnv.DIFFWARDEN_CODEX_AUTH_HOME?.trim() ||
    effectiveEnv.CODEX_HOME?.trim() ||
    path.join(effectiveEnv.HOME?.trim() || homedir(), ".codex")
  );
}

async function assertCodexAuthAvailable(codexHome: string): Promise<void> {
  const authPath = path.join(codexHome, "auth.json");
  try {
    await access(authPath, constants.R_OK);
  } catch {
    throw missingAuth(`Codex auth.json not found or not readable: ${authPath}`);
  }
}

function codexDeveloperInstructions(): string {
  return [
    "You are running inside Diffwarden as a read-only code reviewer.",
    "Inspect the requested repository state and return only the requested review result.",
    "Do not modify files. Do not ask for permission to modify files.",
    "Command execution is currently enabled for this experimental app-server transport, but approval escalations are denied and the sandbox is read-only.",
  ].join("\n");
}

function codexAppServerExecutable(reviewer: ReviewReviewerConfig): string {
  return cliExecutable(reviewer, "codex");
}

function codexAppServerThreadModelOptions(reviewer: ReviewReviewerConfig): {
  model?: string;
  modelProvider?: string;
} {
  return {
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(reviewer.provider !== undefined ? { modelProvider: reviewer.provider } : {}),
  };
}

function codexAppServerTurnModelOptions(reviewer: ReviewReviewerConfig): { model?: string } {
  return reviewer.model === undefined ? {} : { model: reviewer.model };
}

function codexAppServerSelectionMetadata(
  reviewer: ReviewReviewerConfig,
): Record<string, string | boolean> {
  const model = reviewer.model;
  const effort = reviewer.effort === undefined ? undefined : codexAppServerEffort(reviewer.effort);
  return {
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(model !== undefined
      ? modelResolutionMetadata({
          requested: model,
          resolved: model,
          source: "requested",
        })
      : {}),
    ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
    ...(reviewer.effort !== undefined
      ? effortResolutionMetadata({
          requested: reviewer.effort,
          ...(effort !== undefined ? { resolved: effort } : {}),
          source: codexAppServerEffortSource(reviewer.effort),
        })
      : {}),
  };
}

function codexAppServerEffort(effort: string): string {
  if (effort === "off") {
    return "none";
  }
  return effort;
}

function codexAppServerEffortSource(effort: string): ResolutionSource {
  return effort === "off" ? "adapter-selection" : "requested";
}

function codexAppServerRunContext(value: unknown): CodexAppServerRunContext | undefined {
  if (
    !isRecord(value) ||
    value.kind !== "codex-app-server" ||
    typeof value.requestedExecutable !== "string" ||
    typeof value.resolvedExecutable !== "string" ||
    !isCodexAppServerMode(value.mode)
  ) {
    return undefined;
  }
  return value as CodexAppServerRunContext;
}

function pathContext(env: NodeJS.ProcessEnv | undefined): { path?: string } {
  const value = (env ?? process.env).PATH;
  return value === undefined ? {} : { path: value };
}

function optionalStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isCodexAppServerMode(value: unknown): value is CodexAppServerMode {
  return value === "auto" || value === "attach" || value === "launch" || value === "stdio-isolated";
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw reviewerFailed(message);
  }
}

function bindAbortSignal(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (signal === undefined) {
    return () => {};
  }
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonRpcLine(line: string): JsonRpcMessage | undefined {
  const rawLine = line.trim();
  if (!rawLine) {
    return undefined;
  }
  return parseJsonRpcPayload(rawLine);
}

function parseJsonRpcPayload(payload: string): JsonRpcMessage | undefined {
  try {
    const value = JSON.parse(payload);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function classifyAppServerStartError(executable: string, error: unknown): Error {
  if (isNodeErrorWithCode(error, "ENOENT")) {
    return missingRequirement(`CLI executable not found: ${executable}`);
  }
  return reviewerFailed(`${executable} app-server failed to start: ${formatError(error)}`);
}

function isJsonRpcResponse(
  message: JsonRpcMessage,
): message is JsonRpcMessage & { id: string | number } {
  return (
    (typeof message.id === "number" || typeof message.id === "string") && !("method" in message)
  );
}

function isServerRequest(message: JsonRpcMessage): boolean {
  return (
    (typeof message.id === "number" || typeof message.id === "string") &&
    typeof message.method === "string"
  );
}

function stringAtPath(value: unknown, keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function booleanAtPath(value: unknown, keys: string[]): boolean | undefined {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "boolean" ? current : undefined;
}

function tomlTableHeader(line: string): string | undefined {
  const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
  return match?.[1]?.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function formatTurnFailure(params: unknown, status: string): string {
  const message = stringAtPath(params, ["error", "message"]);
  return message !== undefined
    ? `codex app-server turn ${status}: ${message}`
    : `codex app-server turn ${status}`;
}
