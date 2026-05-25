import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { normalizeJsonLikeAdapterOutput } from "../core/adapter-output.js";
import { missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
import { reviewResultStrictJsonSchema } from "../core/schema.js";
import { version } from "../version.js";
import { cliExecutable } from "./cli-helpers.js";
import { resolveExecutable, trimForMetadata } from "./cli-process.js";
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
  path?: string;
};

type SpawnedAppServer = {
  child: ChildProcessWithoutNullStreams;
  codexHome: string;
  executable: string;
};

const appServerKillGraceMs = 1_000;

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
      const executable =
        runContext !== undefined &&
        runContext.requestedExecutable === codexAppServerExecutable(input.reviewer) &&
        runContext.path === pathContext(input.env).path
          ? runContext.resolvedExecutable
          : await resolveExecutable(codexAppServerExecutable(input.reviewer), input.env);
      const session = new CodexAppServerSession(input, executable);
      return await session.run();
    },
  };
}

async function prepareCodexAppServerAdapter(
  input: ReviewAdapterPreflightInput,
): Promise<{ preflight: ReviewAdapterPreflightResult; runContext: CodexAppServerRunContext }> {
  const executable = codexAppServerExecutable(input.reviewer);
  const resolvedExecutable = await resolveExecutable(executable, input.env);
  await assertCodexAuthAvailable(input.env);

  const metadata: ReviewAdapterPreflightResult["metadata"] = {
    readonlyCapability: "enforced",
    transport: "app-server",
    executable: resolvedExecutable,
    execEnabled: true,
    ephemeral: true,
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
          detail: "Codex auth.json is available for isolated app-server runs.",
        },
        {
          name: "readonly",
          status: "passed",
          detail:
            "Codex app-server runs with ephemeral read-only threads, approval policy never, and temporary CODEX_HOME isolation.",
        },
        {
          name: "exec",
          status: "warning",
          detail:
            "Codex app-server command execution remains enabled for this experimental transport; approval escalations are denied.",
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
      ...pathContext(input.env),
    },
  };
}

class CodexAppServerSession {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly completedTurns = new Set<string>();
  private nextId = 1;
  private spawned: SpawnedAppServer | undefined;
  private reply = "";
  private currentAgentMessageId = "";
  private currentAgentMessageText = "";
  private turnCompletion:
    | { turnId: string; resolve: () => void; reject: (error: Error) => void }
    | undefined;
  private usage: unknown;
  private stderr = "";

  constructor(
    private readonly input: ReviewAdapterInput,
    private readonly executable: string,
  ) {}

  async run(): Promise<ReviewAdapterOutput> {
    throwIfAborted(this.input.signal, "codex app-server reviewer aborted before start");
    const spawned = await spawnCodexAppServer({
      executable: this.executable,
      env: this.input.env,
    });
    this.spawned = spawned;
    const removeAbortListener = bindAbortSignal(this.input.signal, () => {
      const error = reviewerFailed("codex app-server reviewer aborted");
      this.rejectAll(error);
      this.turnCompletion?.reject(error);
      this.kill("SIGTERM");
      setTimeout(() => this.kill("SIGKILL"), appServerKillGraceMs);
    });

    const stdout = createInterface({ input: spawned.child.stdout });
    stdout.on("line", (line) => this.onLine(line));
    spawned.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    spawned.child.stdin.on("error", (error) => {
      this.onStdinFailure(error);
    });
    spawned.child.on("error", (error) => {
      const classified = classifyAppServerStartError(this.executable, error);
      this.rejectAll(classified);
      this.turnCompletion?.reject(classified);
    });
    spawned.child.on("close", (code, signal) => {
      const error = reviewerFailed(
        `codex app-server exited before review completed: ${code ?? `signal ${signal ?? "none"}`}`,
      );
      this.rejectAll(error);
      this.turnCompletion?.reject(error);
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
        config: {
          web_search: "disabled",
        },
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
        executable: spawned.executable,
        execEnabled: true,
        ephemeral: true,
        stderr: trimForMetadata(this.stderr),
        ...codexAppServerSelectionMetadata(this.input.reviewer),
      });
      return {
        ...output,
        ...(this.usage !== undefined ? { usage: this.usage } : {}),
      };
    } finally {
      removeAbortListener();
      stdout.close();
      await this.close();
    }
  }

  private call(method: string, params: unknown): Promise<unknown> {
    const child = this.spawned?.child;
    if (child === undefined) {
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
    const child = this.spawned?.child;
    if (child === undefined || child.stdin.destroyed || !child.stdin.writable) {
      this.onStdinFailure(new Error("stdin is not writable"));
      return;
    }

    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.onStdinFailure(error);
        }
      });
    } catch (error) {
      this.onStdinFailure(error);
    }
  }

  private onStdinFailure(error: unknown): void {
    const classified = reviewerFailed(`codex app-server stdin failed: ${formatError(error)}`);
    this.rejectAll(classified);
    this.turnCompletion?.reject(classified);
  }

  private onLine(line: string): void {
    const rawLine = line.trim();
    if (!rawLine) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(rawLine) as JsonRpcMessage;
    } catch {
      return;
    }
    this.onMessage(message);
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
      this.captureAgentMessageItem(item);
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
        this.captureAgentMessageItem(item);
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

  private captureAgentMessageItem(item: Record<string, unknown>): void {
    if (item.type === "agentMessage" && typeof item.text === "string") {
      this.currentAgentMessageId = typeof item.id === "string" ? item.id : "agent-message";
      this.currentAgentMessageText = item.text;
      this.reply = item.text;
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

  private kill(signal: NodeJS.Signals, child = this.spawned?.child): void {
    if (child === undefined) {
      return;
    }
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

  private async close(): Promise<void> {
    const spawned = this.spawned;
    this.spawned = undefined;
    if (spawned === undefined) {
      return;
    }
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
      this.kill("SIGTERM", spawned.child);
    }
    await Promise.race([exit, sleep(appServerKillGraceMs)]);
    if (!exited) {
      this.kill("SIGKILL", spawned.child);
      await Promise.race([exit, sleep(appServerKillGraceMs)]);
    }
    await rm(spawned.codexHome, { force: true, recursive: true });
  }
}

async function spawnCodexAppServer(options: {
  executable: string;
  env: NodeJS.ProcessEnv | undefined;
}): Promise<SpawnedAppServer> {
  const codexHome = await createIsolatedCodexHome(options.env);
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

async function createIsolatedCodexHome(env: NodeJS.ProcessEnv | undefined): Promise<string> {
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
      await isolatedCodexConfig(sourceHome),
      "utf8",
    );
    return codexHome;
  } catch (error) {
    await rm(codexHome, { force: true, recursive: true });
    throw error;
  }
}

async function isolatedCodexConfig(sourceHome: string): Promise<string> {
  const providerConfig = await readSourceModelProviderConfig(sourceHome);
  return [
    providerConfig,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    `web_search = "disabled"`,
    "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

async function readSourceModelProviderConfig(sourceHome: string): Promise<string> {
  try {
    return extractModelProviderConfig(await readFile(path.join(sourceHome, "config.toml"), "utf8"));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "";
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

function codexAuthHome(env: NodeJS.ProcessEnv | undefined): string {
  const effectiveEnv = env ?? process.env;
  return (
    effectiveEnv.DIFFWARDEN_CODEX_AUTH_HOME?.trim() ||
    effectiveEnv.CODEX_HOME?.trim() ||
    path.join(effectiveEnv.HOME?.trim() || homedir(), ".codex")
  );
}

async function assertCodexAuthAvailable(env: NodeJS.ProcessEnv | undefined): Promise<void> {
  const authPath = path.join(codexAuthHome(env), "auth.json");
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
    typeof value.resolvedExecutable !== "string"
  ) {
    return undefined;
  }
  return value as CodexAppServerRunContext;
}

function pathContext(env: NodeJS.ProcessEnv | undefined): { path?: string } {
  const value = (env ?? process.env).PATH;
  return value === undefined ? {} : { path: value };
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

function formatTurnFailure(params: unknown, status: string): string {
  const message = stringAtPath(params, ["error", "message"]);
  return message !== undefined
    ? `codex app-server turn ${status}: ${message}`
    : `codex app-server turn ${status}`;
}
