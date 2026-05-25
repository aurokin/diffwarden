import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import type { ReviewAdapterInput, ReviewReviewerConfig } from "../src/adapters/types.js";

let root: string | undefined;

afterEach(() => {
  if (root) {
    rmSync(root, { force: true, recursive: true });
    root = undefined;
  }
});

describe("createCodexAppServerAdapter", () => {
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
      execEnabled: true,
      ephemeral: true,
      requestedModel: "gpt-test",
      resolvedModel: "gpt-test",
      requestedEffort: "minimal",
      resolvedEffort: "minimal",
      effortResolutionSource: "requested",
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
      execEnabled: true,
      ephemeral: true,
      requestedModel: "gpt-test",
      resolvedEffort: "minimal",
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
    expect(invocation.turnStart.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(invocation.turnStart.input[0]?.text).toBe("review prompt");
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
  turnStart: {
    approvalPolicy: string;
    model?: string;
    effort?: string;
    sandboxPolicy: unknown;
    outputSchema: unknown;
    input: Array<{ text: string }>;
  };
  approvalResponse?: unknown;
  legacyApprovalResponse?: unknown;
  unsupportedResponse?: unknown;
};

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
    ...options,
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
  }
});

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
