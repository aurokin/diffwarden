import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildStructuredReviewAdapterOutput,
  buildTextAdapterOutput,
} from "../core/adapter-output.js";
import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import { reviewResultJsonSchema } from "../core/schema.js";
import {
  effortResolutionMetadata,
  modelResolutionMetadata,
  sdkOutputMetadata,
  sdkPreflightMetadata,
} from "./metadata.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const defaultClaudeModel = "sonnet";
const defaultClaudeExecutable = "claude";
const maxClaudeTurns = 3;
const execFileAsync = promisify(execFile);

type ClaudeAdapterDependencies = {
  loadSdk: () => Promise<ClaudeSdk>;
  resolveRuntime: (
    input: Pick<ReviewAdapterInput | ReviewAdapterPreflightInput, "env" | "reviewer">,
  ) => Promise<ClaudeRuntime>;
};

const defaultClaudeAdapterDependencies: ClaudeAdapterDependencies = {
  loadSdk: loadClaudeSdk,
  resolveRuntime: resolveClaudeRuntime,
};

export function createClaudeAdapter(
  dependencies: ClaudeAdapterDependencies = defaultClaudeAdapterDependencies,
): ReviewAdapter {
  return {
    name: "claude",
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      const sdk = await dependencies.loadSdk();
      const runtime = await dependencies.resolveRuntime(input);
      const model = input.reviewer.model ?? defaultClaudeModel;
      const modelPreflight = await preflightClaudeModel({
        query: sdk.query,
        input,
        runtime,
        model,
      });

      return {
        checks: [
          {
            name: "auth",
            status: "passed",
            detail:
              runtime.authMode === "api-key"
                ? "ANTHROPIC_API_KEY is present."
                : claudeCodeAuthDetail(runtime),
          },
          {
            name: "sdk",
            status: "passed",
            detail: "@anthropic-ai/claude-agent-sdk loaded successfully.",
          },
          {
            name: "model",
            status: "passed",
            detail: `Claude model is available: ${modelPreflight.model.value}.`,
          },
          {
            name: "readonly",
            status: "passed",
            detail: "Claude built-in tools are disabled for this adapter path.",
          },
        ],
        metadata: sdkPreflightMetadata("claude", {
          model: modelPreflight.model.value,
          ...claudeModelResolutionMetadata(input.reviewer, modelPreflight.model.value),
          ...(modelPreflight.model.displayName !== undefined
            ? { modelDisplayName: modelPreflight.model.displayName }
            : {}),
          ...(modelPreflight.model.supportsEffort !== undefined
            ? { supportsEffort: modelPreflight.model.supportsEffort }
            : {}),
          ...(modelPreflight.model.supportedEffortLevels !== undefined
            ? { supportedEffortLevels: modelPreflight.model.supportedEffortLevels }
            : {}),
          ...claudeEffortMetadata(input.reviewer.effort),
          authMode: runtime.authMode,
          authPreference: runtime.authPreference,
          authMethod: runtime.authMethod,
          apiProvider: runtime.apiProvider,
          subscriptionType: runtime.subscriptionType,
          tokenSource: runtime.tokenSource,
          apiKeySource: runtime.apiKeySource,
          executable: runtime.executable,
        }),
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const { query } = await dependencies.loadSdk();
      const runtime = await dependencies.resolveRuntime(input);

      try {
        const structuredResult = await runClaudeQuery({
          query,
          input,
          runtime,
          outputFormat: true,
        });

        if (structuredResult.subtype === "success") {
          const structuredOutput = buildStructuredReviewAdapterOutput(
            structuredResult.structured_output,
            {
              metadata: claudeOutputMetadata({
                input,
                result: structuredResult,
                runtime,
                captureMode: "native-structured",
              }),
            },
          );
          if (structuredOutput !== undefined) {
            return buildClaudeOutput({
              input,
              result: structuredResult,
              runtime,
              captureMode: "native-structured",
              structured: structuredOutput.structured,
            });
          }

          const textResult = await runClaudeQuery({
            query,
            input,
            runtime,
            outputFormat: false,
          });
          return buildClaudeTextOutput({
            input,
            result: textResult,
            runtime,
            fallbackReason: "invalid_structured_output",
            previousResult: structuredResult,
          });
        }

        if (structuredResult.subtype === "error_max_structured_output_retries") {
          const textResult = await runClaudeQuery({
            query,
            input,
            runtime,
            outputFormat: false,
          });
          return buildClaudeTextOutput({
            input,
            result: textResult,
            runtime,
            fallbackReason: structuredResult.subtype,
            previousResult: structuredResult,
          });
        }

        throw reviewerFailed(
          `Claude reviewer failed: ${formatClaudeResultError(structuredResult)}`,
        );
      } catch (error) {
        if (error instanceof DiffwardenError) {
          throw error;
        }

        const detail = error instanceof Error ? error.message : String(error);
        throw reviewerFailed(`Claude reviewer failed: ${detail}`);
      }
    },
  };
}

export const claudeAdapter = createClaudeAdapter();

type RunClaudeQueryInput = {
  query: ClaudeSdk["query"];
  input: ReviewAdapterInput;
  runtime: ClaudeRuntime;
  outputFormat: boolean;
};

type ClaudeSdk = {
  query(params: {
    prompt: string | AsyncIterable<unknown>;
    options?: ClaudeQueryOptions;
  }): ClaudeQuery;
};

type ClaudeQuery = AsyncIterable<ClaudeSdkMessage> & {
  supportedModels?: () => Promise<ClaudeModelInfo[]>;
  close?: () => void;
};

type ClaudeModelInfo = {
  value: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

type ClaudeQueryOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  tools?: string[];
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  settingSources?: Array<"user" | "project" | "local">;
  persistSession?: boolean;
  maxTurns?: number;
  thinking?: { type: "disabled" | "adaptive" } | { type: "enabled"; budgetTokens: number };
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  pathToClaudeCodeExecutable?: string;
  abortController?: AbortController;
  outputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  };
};

async function preflightClaudeModel(options: {
  query: ClaudeSdk["query"];
  input: ReviewAdapterPreflightInput;
  runtime: ClaudeRuntime;
  model: string;
}): Promise<{ model: ClaudeModelInfo }> {
  const abortBridge = createAbortBridge(options.input.signal);
  const query = options.query({
    prompt: emptyClaudeStreamingInput(),
    options: buildClaudeModelPreflightOptions(
      options.input,
      options.runtime,
      abortBridge.controller,
    ),
  });

  try {
    if (query.supportedModels === undefined) {
      throw missingRequirement("Claude SDK query does not expose supportedModels()");
    }

    const models = await query.supportedModels();
    const model = models.find((candidate) => candidate.value === options.model);
    if (model === undefined) {
      throw new DiffwardenError(
        "invalid_model",
        `Claude model is not available: ${options.model}`,
        2,
      );
    }

    assertClaudeEffortSupported(model, options.input.reviewer.effort);

    return { model };
  } catch (error) {
    if (error instanceof DiffwardenError) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    if (isClaudeAuthenticationErrorDetail(detail)) {
      throw missingAuth(`Claude model preflight authentication failed: ${detail}`);
    }
    throw reviewerFailed(`Claude model preflight failed: ${detail}`);
  } finally {
    abortBridge.dispose();
    query.close?.();
  }
}

function buildClaudeModelPreflightOptions(
  input: ReviewAdapterPreflightInput,
  runtime: ClaudeRuntime,
  abortController: AbortController | undefined,
): ClaudeQueryOptions {
  const queryOptions: ClaudeQueryOptions = {
    cwd: input.cwd,
    tools: [],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    maxTurns: 1,
  };

  if (abortController !== undefined) {
    queryOptions.abortController = abortController;
  }

  const env = claudeQueryEnv(input.env, runtime);
  if (env !== undefined) {
    queryOptions.env = env;
  }

  if (runtime.executable !== undefined) {
    queryOptions.pathToClaudeCodeExecutable = runtime.executable;
  }

  return queryOptions;
}

async function* emptyClaudeStreamingInput(): AsyncIterable<unknown> {}

function assertClaudeEffortSupported(
  model: ClaudeModelInfo,
  requestedEffort: string | undefined,
): void {
  if (requestedEffort === undefined || requestedEffort === "off") {
    return;
  }

  if (model.supportsEffort !== true) {
    throw new DiffwardenError(
      "invalid_effort",
      `Claude model does not support effort controls: ${model.value}`,
      2,
    );
  }

  const nativeEffort = claudeNativeEffort(requestedEffort);
  if (
    model.supportedEffortLevels !== undefined &&
    !model.supportedEffortLevels.includes(nativeEffort)
  ) {
    throw new DiffwardenError(
      "invalid_effort",
      `Claude model ${model.value} does not support effort: ${nativeEffort}`,
      2,
    );
  }
}

type ClaudeRuntime =
  | {
      authMode: "api-key";
      authPreference: ClaudeAuthPreference;
      executable?: undefined;
      env?: undefined;
      authMethod?: undefined;
      apiProvider?: undefined;
      subscriptionType?: undefined;
      tokenSource?: undefined;
      apiKeySource?: undefined;
    }
  | {
      authMode: "claude-code";
      authPreference: ClaudeAuthPreference;
      executable: string;
      env: NodeJS.ProcessEnv;
      authMethod?: string;
      apiProvider?: string;
      subscriptionType?: string;
      tokenSource?: string;
      apiKeySource?: string;
    };

type ClaudeAuthPreference = "auto" | "api-key" | "claude-code";

type ClaudeAuthStatus = {
  loggedIn?: unknown;
  authMethod?: unknown;
  apiProvider?: unknown;
  email?: unknown;
  orgId?: unknown;
  orgName?: unknown;
  subscriptionType?: unknown;
  tokenSource?: unknown;
  apiKeySource?: unknown;
};

type ClaudeSdkMessage =
  | {
      type: "assistant";
      error?: string;
    }
  | ClaudeResultMessage
  | {
      type: string;
      [key: string]: unknown;
    };

type ClaudeResultMessage = {
  type: "result";
  subtype: string;
  result?: string;
  structured_output?: unknown;
  duration_ms?: number;
  total_cost_usd?: number;
  session_id?: string;
  errors?: string[];
};

async function runClaudeQuery(options: RunClaudeQueryInput): Promise<ClaudeResultMessage> {
  let result: ClaudeResultMessage | undefined;
  const abortBridge = createAbortBridge(options.input.signal);
  const queryOptions = buildClaudeQueryOptions(options, abortBridge.controller);

  try {
    for await (const message of options.query({
      prompt: options.input.prompt,
      options: queryOptions,
    })) {
      if (message.type === "assistant" && message.error === "authentication_failed") {
        throw missingAuth("Claude reviewer authentication failed");
      }

      if (isClaudeResultMessage(message)) {
        result = message;
      }
    }
  } finally {
    abortBridge.dispose();
  }

  if (!result) {
    throw reviewerFailed("Claude reviewer did not return a result");
  }

  return result;
}

function buildClaudeQueryOptions(
  options: RunClaudeQueryInput,
  abortController: AbortController | undefined,
): ClaudeQueryOptions {
  const queryOptions: ClaudeQueryOptions = {
    cwd: options.input.cwd,
    model: options.input.reviewer.model ?? defaultClaudeModel,
    tools: [],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    maxTurns: maxClaudeTurns,
    ...claudeQueryEffortOptions(options.input.reviewer.effort),
  };

  if (abortController !== undefined) {
    queryOptions.abortController = abortController;
  }

  if (options.outputFormat) {
    queryOptions.outputFormat = {
      type: "json_schema",
      schema: reviewResultJsonSchema,
    };
  }

  const env = claudeQueryEnv(options.input.env, options.runtime);
  if (env !== undefined) {
    queryOptions.env = env;
  }

  if (options.runtime.executable !== undefined) {
    queryOptions.pathToClaudeCodeExecutable = options.runtime.executable;
  }

  return queryOptions;
}

function createAbortBridge(signal: AbortSignal | undefined): {
  controller: AbortController | undefined;
  dispose: () => void;
} {
  if (signal === undefined) {
    return { controller: undefined, dispose: () => {} };
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);

  if (signal.aborted) {
    abort();
    return { controller, dispose: () => {} };
  }

  signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener("abort", abort),
  };
}

function buildClaudeTextOutput(options: {
  input: ReviewAdapterInput;
  result: ClaudeResultMessage;
  runtime: ClaudeRuntime;
  fallbackReason: string;
  previousResult?: ClaudeResultMessage;
}): ReviewAdapterOutput {
  if (options.result.subtype !== "success") {
    throw reviewerFailed(`Claude reviewer failed: ${formatClaudeResultError(options.result)}`);
  }

  const outputOptions: Parameters<typeof buildClaudeOutput>[0] = {
    input: options.input,
    result: options.result,
    runtime: options.runtime,
    captureMode: "text",
    text: options.result.result ?? "",
    fallbackReason: options.fallbackReason,
  };

  if (options.previousResult !== undefined) {
    outputOptions.previousResult = options.previousResult;
  }

  return buildTextAdapterOutput({
    text: outputOptions.text,
    metadata: claudeOutputMetadata(outputOptions),
  });
}

function claudeOutputMetadata(options: {
  input: ReviewAdapterInput;
  result: ClaudeResultMessage;
  runtime: ClaudeRuntime;
  captureMode: "native-structured" | "text";
  fallbackReason?: string;
  previousResult?: ClaudeResultMessage;
}): NonNullable<ReviewAdapterOutput["metadata"]> {
  const model = options.input.reviewer.model ?? defaultClaudeModel;
  const metadata = sdkOutputMetadata("claude", {
    captureMode: options.captureMode,
    sessionId: options.result.session_id,
    model,
    ...claudeModelResolutionMetadata(options.input.reviewer, model),
    ...claudeEffortMetadata(options.input.reviewer.effort),
    durationMs: sumKnownNumbers(options.previousResult?.duration_ms, options.result.duration_ms),
    totalCostUsd: sumKnownNumbers(
      options.previousResult?.total_cost_usd,
      options.result.total_cost_usd,
    ),
    authMode: options.runtime.authMode,
    authPreference: options.runtime.authPreference,
    authMethod: options.runtime.authMethod,
    apiProvider: options.runtime.apiProvider,
    subscriptionType: options.runtime.subscriptionType,
    tokenSource: options.runtime.tokenSource,
    apiKeySource: options.runtime.apiKeySource,
    executable: options.runtime.executable,
  });

  if (options.fallbackReason !== undefined) {
    return {
      ...metadata,
      fallbackReason: options.fallbackReason,
    };
  }

  return metadata;
}

function claudeModelResolutionMetadata(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  resolvedModel: string,
): Record<string, string> {
  return modelResolutionMetadata({
    requested: reviewer.model,
    resolved: resolvedModel,
    source: reviewer.model === undefined ? "adapter-default" : "requested",
  });
}

function buildClaudeOutput(options: {
  input: ReviewAdapterInput;
  result: ClaudeResultMessage;
  runtime: ClaudeRuntime;
  captureMode: "native-structured" | "text";
  structured?: unknown;
  text?: string;
  fallbackReason?: string;
  previousResult?: ClaudeResultMessage;
}): ReviewAdapterOutput {
  const metadata = claudeOutputMetadata(options);

  if (options.structured !== undefined) {
    return (
      buildStructuredReviewAdapterOutput(options.structured, {
        metadata,
      }) ?? { structured: options.structured, metadata }
    );
  }

  return buildTextAdapterOutput({
    text: options.text,
    metadata,
  });
}

function claudeQueryEffortOptions(effort: string | undefined): Partial<ClaudeQueryOptions> {
  if (effort === undefined) {
    return {};
  }

  if (effort === "off") {
    return {
      thinking: { type: "disabled" },
    };
  }

  return {
    effort: claudeNativeEffort(effort),
  };
}

function claudeEffortMetadata(effort: string | undefined): Record<string, string> {
  if (effort === undefined) {
    return {};
  }

  return {
    effort: effort === "off" ? "off" : claudeNativeEffort(effort),
    ...effortResolutionMetadata({
      requested: effort,
      resolved: effort === "off" ? "off" : claudeNativeEffort(effort),
      source: effort === "off" ? "adapter-selection" : "requested",
    }),
  };
}

function claudeNativeEffort(effort: string): "low" | "medium" | "high" | "max" {
  if (effort === "minimal" || effort === "low") {
    return "low";
  }

  if (effort === "medium") {
    return "medium";
  }

  if (effort === "xhigh") {
    return "max";
  }

  return "high";
}

async function loadClaudeSdk(): Promise<ClaudeSdk> {
  try {
    return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeSdk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Failed to load @anthropic-ai/claude-agent-sdk: ${detail}`);
  }
}

export async function resolveClaudeRuntime(
  input: Pick<ReviewAdapterInput | ReviewAdapterPreflightInput, "env" | "reviewer">,
  executable = defaultClaudeExecutable,
): Promise<ClaudeRuntime> {
  const env = input.env;
  const effectiveEnv = env ?? process.env;
  const authPreference = claudeAuthPreference(input.reviewer);
  const apiKey = effectiveEnv.ANTHROPIC_API_KEY?.trim();

  if (authPreference === "api-key") {
    if (!apiKey) {
      throw missingAuth("Missing Claude API key: set ANTHROPIC_API_KEY");
    }
    return {
      authMode: "api-key",
      authPreference,
    };
  }

  const claudeCodeEnv = withoutAnthropicApiCredentials(env);
  const claudeCodeStatus = await getClaudeCodeAuthStatus(claudeCodeEnv, executable);

  if (isLoggedInClaudeStatus(claudeCodeStatus)) {
    return {
      authMode: "claude-code",
      authPreference,
      executable,
      env: claudeCodeEnv,
      ...claudeCodeStatusMetadata(claudeCodeStatus),
    };
  }

  if (authPreference === "claude-code") {
    throw missingAuth(
      'Missing Claude Code auth: install Claude Code and log in, or set sdkOptions.authMode to "api-key"',
    );
  }

  if (apiKey) {
    return {
      authMode: "api-key",
      authPreference,
    };
  }

  throw missingAuth(
    "Missing Claude auth: set ANTHROPIC_API_KEY or install and authenticate Claude Code",
  );
}

async function getClaudeCodeAuthStatus(
  env: NodeJS.ProcessEnv | undefined,
  executable: string,
): Promise<ClaudeAuthStatus | undefined> {
  try {
    const options: { env?: NodeJS.ProcessEnv; timeout: number } = {
      timeout: 5_000,
    };

    if (env !== undefined) {
      options.env = env;
    }

    const { stdout } = await execFileAsync(executable, ["auth", "status", "--json"], options);
    return parseClaudeAuthStatus(stdout);
  } catch {
    return undefined;
  }
}

function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | undefined {
  try {
    return JSON.parse(stdout) as ClaudeAuthStatus;
  } catch {
    return undefined;
  }
}

function isLoggedInClaudeStatus(status: ClaudeAuthStatus | undefined): status is ClaudeAuthStatus {
  return status?.loggedIn === true;
}

function withoutAnthropicApiCredentials(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env ?? process.env).filter(
      ([key]) => key !== "ANTHROPIC_API_KEY" && key !== "ANTHROPIC_AUTH_TOKEN",
    ),
  );
}

function claudeQueryEnv(
  inputEnv: NodeJS.ProcessEnv | undefined,
  runtime: ClaudeRuntime,
): NodeJS.ProcessEnv | undefined {
  if (runtime.authMode === "claude-code") {
    return runtime.env;
  }

  return inputEnv;
}

export function claudeCliEnv(runtime: ClaudeRuntime): NodeJS.ProcessEnv | undefined {
  if (runtime.authMode === "api-key") {
    return undefined;
  }

  return runtime.env;
}

function claudeAuthPreference(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): ClaudeAuthPreference {
  const value = reviewer.sdkOptions?.authMode;
  if (value === undefined || value === "auto") {
    return "auto";
  }

  if (value === "api-key" || value === "claude-code") {
    return value;
  }

  throw new DiffwardenError(
    "invalid_config",
    `Claude sdkOptions.authMode must be one of auto, api-key, or claude-code: ${String(value)}`,
    2,
  );
}

function claudeCodeStatusMetadata(status: ClaudeAuthStatus): {
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
} {
  return {
    ...(typeof status.authMethod === "string" ? { authMethod: status.authMethod } : {}),
    ...(typeof status.apiProvider === "string" ? { apiProvider: status.apiProvider } : {}),
    ...(typeof status.subscriptionType === "string"
      ? { subscriptionType: status.subscriptionType }
      : {}),
    ...(typeof status.tokenSource === "string" ? { tokenSource: status.tokenSource } : {}),
    ...(typeof status.apiKeySource === "string" ? { apiKeySource: status.apiKeySource } : {}),
  };
}

function claudeCodeAuthDetail(
  runtime: Extract<ClaudeRuntime, { authMode: "claude-code" }>,
): string {
  const subscription =
    runtime.subscriptionType === undefined ? "" : ` (${runtime.subscriptionType} subscription)`;
  return `Claude Code executable reports authenticated local auth${subscription}.`;
}

function isClaudeResultMessage(message: ClaudeSdkMessage): message is ClaudeResultMessage {
  return message.type === "result" && "subtype" in message && typeof message.subtype === "string";
}

function formatClaudeResultError(result: ClaudeResultMessage): string {
  if (result.errors?.length) {
    return result.errors.join("; ");
  }

  return result.subtype;
}

function isClaudeAuthenticationErrorDetail(detail: string): boolean {
  return /auth|api key|unauthorized|forbidden/i.test(detail);
}

function sumKnownNumbers(...values: Array<number | undefined>): number | undefined {
  const knownValues = values.filter((value): value is number => value !== undefined);
  if (!knownValues.length) {
    return undefined;
  }

  return knownValues.reduce((sum, value) => sum + value, 0);
}
