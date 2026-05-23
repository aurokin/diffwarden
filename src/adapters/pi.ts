import {
  buildStructuredReviewAdapterOutput,
  unwrapStructuredReview,
} from "../core/adapter-output.js";
import {
  DiffwardenError,
  invalidConfig,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import { type ReviewResult, reviewResultJsonSchema } from "../core/schema.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const piPackageName = "@earendil-works/pi-coding-agent";
const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type PiThinkingLevel = (typeof piThinkingLevels)[number];

type PiAdapterDependencies = {
  loadSdk: () => Promise<PiSdk>;
};

const defaultPiAdapterDependencies: PiAdapterDependencies = {
  loadSdk: loadPiSdk,
};

export function createPiAdapter(
  dependencies: PiAdapterDependencies = defaultPiAdapterDependencies,
): ReviewAdapter {
  return {
    name: "pi",
    async preflight(input: ReviewAdapterPreflightInput): Promise<ReviewAdapterPreflightResult> {
      const sdk = await dependencies.loadSdk();
      const { availableModels } = createPiRuntimeContext(sdk, input.env, input.reviewer);

      if (!availableModels.length) {
        throw missingAuth("No authenticated Pi models are available for the Pi reviewer");
      }
      const selectedModel = selectPiModel(
        availableModels,
        input.reviewer.model,
        input.reviewer.provider,
      );
      const effort = resolvePiEffort(selectedModel, input.reviewer.effort);

      const metadata: ReviewAdapterPreflightResult["metadata"] = {
        readonlyCapability: "tool-restricted",
        preferredCaptureMode: "tool-call",
        availableModelCount: availableModels.length,
        model: formatPiModel(selectedModel),
        ...piProviderMetadata(input.reviewer),
        ...piEffortMetadata(effort),
      };

      return {
        checks: [
          {
            name: "sdk",
            status: "passed",
            detail: `${piPackageName} loaded successfully.`,
          },
          {
            name: "auth",
            status: "passed",
            detail: `${availableModels.length} Pi model(s) are available from environment-backed auth.`,
          },
          {
            name: "model",
            status: "passed",
            detail:
              input.reviewer.model === undefined
                ? `Using first available Pi model: ${formatPiModel(selectedModel)}.`
                : `Using requested Pi model: ${formatPiModel(selectedModel)}.`,
          },
          {
            name: "readonly",
            status: "passed",
            detail: "Pi scaffold will use the read, grep, find, and ls tools for execution.",
          },
        ],
        metadata,
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const sdk = await dependencies.loadSdk();
      const { authStorage, modelRegistry, availableModels } = createPiRuntimeContext(
        sdk,
        input.env,
        input.reviewer,
      );

      if (!availableModels.length) {
        throw missingAuth("No authenticated Pi models are available for the Pi reviewer");
      }

      let capturedReview: unknown;
      let capturedReviewError: string | undefined;
      const reviewOutputTool = createReviewOutputTool(
        (review) => {
          capturedReview = review;
        },
        (message) => {
          capturedReviewError = message;
        },
      );
      const selectedModel = selectPiModel(
        availableModels,
        input.reviewer.model,
        input.reviewer.provider,
      );
      const effort = resolvePiEffort(selectedModel, input.reviewer.effort);

      try {
        const sessionManager = sdk.SessionManager.inMemory(input.cwd);
        const scopedModels = filterPiModelsByProvider(availableModels, input.reviewer.provider);
        const { session } = await sdk.createAgentSession({
          cwd: input.cwd,
          model: selectedModel,
          ...piSessionEffortOptions(effort),
          scopedModels: scopedModels.map((model) => ({
            model,
            ...piSessionEffortOptions(resolvePiEffort(model, input.reviewer.effort)),
          })),
          tools: ["read", "grep", "find", "ls", "review_output"],
          customTools: [reviewOutputTool],
          resourceLoader: createExtensionFreeResourceLoader(),
          sessionManager,
          authStorage,
          modelRegistry,
        });

        const removeAbortListener = bindAbortSignal(input.signal, () => session.abort());
        try {
          throwIfAborted(input.signal, "Pi reviewer aborted before prompting");
          await session.prompt(input.prompt);
        } finally {
          removeAbortListener();
          session.dispose();
        }
      } catch (error) {
        if (error instanceof DiffwardenError) {
          throw error;
        }

        const detail = error instanceof Error ? error.message : String(error);
        throw reviewerFailed(`Pi reviewer failed: ${detail}`);
      }

      if (capturedReviewError !== undefined) {
        throw reviewerFailed(capturedReviewError);
      }

      if (capturedReview === undefined) {
        throw reviewerFailed("Pi reviewer did not call the review_output tool");
      }

      const metadata: ReviewAdapterOutput["metadata"] = {
        captureMode: "tool-call",
        readonlyCapability: "tool-restricted",
        availableModelCount: availableModels.length,
        ...piProviderMetadata(input.reviewer),
        ...piEffortMetadata(effort),
      };

      const output = buildStructuredReviewAdapterOutput(capturedReview, {
        metadata,
      });
      if (output === undefined) {
        throw reviewerFailed("Pi reviewer returned invalid review_output arguments");
      }

      return output;
    },
  };
}

export const piAdapter = createPiAdapter();

type PiSdk = {
  AuthStorage: {
    inMemory(data?: Record<string, unknown>): PiAuthStorage;
  };
  ModelRegistry: {
    inMemory(authStorage: PiAuthStorage): PiModelRegistry;
  };
  SessionManager: {
    inMemory(cwd?: string): PiSessionManager;
  };
  createAgentSession(options: PiCreateAgentSessionOptions): Promise<PiCreateAgentSessionResult>;
};

type PiAuthStorage = {
  setRuntimeApiKey?(provider: string, apiKey: string): void;
};
type PiSessionManager = unknown;
type PiResourceLoader = unknown;

type PiModelRegistry = {
  getAvailable(): PiModel[];
  getProviderAuthStatus?(provider: string): PiAuthStatus;
  registerProvider?(providerName: string, config: PiProviderConfig): void;
};

type PiProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
};

type PiModel = {
  provider?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
};

type PiAuthStatus = {
  source?: string;
  label?: string;
};

type PiCreateAgentSessionOptions = {
  cwd: string;
  model: PiModel;
  thinkingLevel?: PiThinkingLevel;
  scopedModels: Array<{ model: PiModel; thinkingLevel?: PiThinkingLevel }>;
  tools: string[];
  customTools: PiToolDefinition[];
  resourceLoader: PiResourceLoader;
  sessionManager: PiSessionManager;
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
};

type PiCreateAgentSessionResult = {
  session: PiSession;
};

type PiSession = {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
};

type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: ReviewResult;
    terminate: true;
  }>;
};

async function loadPiSdk(): Promise<PiSdk> {
  try {
    return (await import(piPackageName)) as unknown as PiSdk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Failed to load ${piPackageName}: ${detail}`);
  }
}

function createPiRuntimeContext(
  sdk: PiSdk,
  env: NodeJS.ProcessEnv | undefined,
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): {
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
  availableModels: PiModel[];
} {
  try {
    return withProcessEnvSync(env, () => {
      const authStorage = sdk.AuthStorage.inMemory();
      const providerOptions = normalizePiProviderOptions(reviewer);
      const providerApiKey = materializeConfiguredProviderAuth(
        authStorage,
        reviewer,
        env,
        providerOptions,
      );
      const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
      materializeConfiguredProviderRegistration(
        modelRegistry,
        reviewer,
        env,
        providerOptions,
        providerApiKey,
      );
      const availableModels = modelRegistry.getAvailable();
      materializeScopedEnvAuth(authStorage, modelRegistry, availableModels, env);
      return {
        authStorage,
        modelRegistry,
        availableModels,
      };
    });
  } catch (error) {
    if (error instanceof DiffwardenError) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw reviewerFailed(`Pi reviewer setup failed: ${detail}`);
  }
}

function materializeConfiguredProviderAuth(
  authStorage: PiAuthStorage,
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  env: NodeJS.ProcessEnv | undefined,
  providerOptions: NormalizedPiProviderOptions,
): string | undefined {
  if (providerOptions.apiKeyEnv === undefined) {
    return undefined;
  }

  if (authStorage.setRuntimeApiKey === undefined) {
    throw missingRequirement(
      `Pi AuthStorage cannot set runtime API keys for provider ${reviewer.provider}`,
    );
  }

  const apiKey = env?.[providerOptions.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw missingAuth(`Missing ${providerOptions.apiKeyEnv} for Pi provider ${reviewer.provider}`);
  }

  authStorage.setRuntimeApiKey(providerOptions.provider, apiKey);
  return apiKey;
}

function materializeConfiguredProviderRegistration(
  modelRegistry: PiModelRegistry,
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  env: NodeJS.ProcessEnv | undefined,
  providerOptions: NormalizedPiProviderOptions,
  providerApiKey: string | undefined,
): void {
  if (providerOptions.baseUrlEnv === undefined) {
    return;
  }

  if (modelRegistry.registerProvider === undefined) {
    throw missingRequirement(
      `Pi ModelRegistry cannot register provider ${reviewer.provider} from providerOptions.baseUrlEnv`,
    );
  }

  const baseUrl = env?.[providerOptions.baseUrlEnv]?.trim();
  if (!baseUrl) {
    throw missingRequirement(
      `Missing ${providerOptions.baseUrlEnv} for Pi provider ${reviewer.provider}`,
    );
  }

  modelRegistry.registerProvider(providerOptions.provider, {
    baseUrl,
    ...(providerApiKey !== undefined ? { apiKey: providerApiKey } : {}),
  });
}

type NormalizedPiProviderOptions = {
  provider: string;
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  providerProfile?: string;
};

function normalizePiProviderOptions(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): NormalizedPiProviderOptions {
  const apiKeyEnv = optionalStringOption(reviewer.providerOptions, "apiKeyEnv");
  const baseUrlEnv = optionalStringOption(reviewer.providerOptions, "baseUrlEnv");
  const providerProfile = optionalStringOption(reviewer.sdkOptions, "providerProfile");

  if (
    (apiKeyEnv !== undefined || baseUrlEnv !== undefined || providerProfile !== undefined) &&
    reviewer.provider === undefined
  ) {
    throw invalidConfig("Pi provider options require reviewer.provider");
  }

  if (
    reviewer.provider !== undefined &&
    providerProfile !== undefined &&
    providerProfile !== reviewer.provider
  ) {
    throw invalidConfig(
      `Pi providerProfile must match reviewer.provider for ${reviewer.id}: ${providerProfile}`,
    );
  }

  return {
    provider: reviewer.provider ?? "",
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(baseUrlEnv !== undefined ? { baseUrlEnv } : {}),
    ...(providerProfile !== undefined ? { providerProfile } : {}),
  };
}

function optionalStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = options?.[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw invalidConfig(`Pi option ${key} must be a non-empty string`);
  }

  return value.trim();
}

function selectPiModel(
  availableModels: PiModel[],
  requestedModel: string | undefined,
  requestedProvider: string | undefined,
): PiModel {
  const candidateModels = filterPiModelsByProvider(availableModels, requestedProvider);

  if (requestedProvider !== undefined && candidateModels.length === 0) {
    throw missingAuth(
      `No authenticated Pi models are available for provider: ${requestedProvider}`,
    );
  }

  if (requestedModel === undefined) {
    const selectedModel = candidateModels[0];
    if (selectedModel === undefined) {
      throw missingAuth("No authenticated Pi models are available for the Pi reviewer");
    }
    return selectedModel;
  }

  const selectedModel = candidateModels.find((model) => {
    if (model.id === requestedModel) {
      return true;
    }

    return (
      typeof model.provider === "string" &&
      typeof model.id === "string" &&
      `${model.provider}/${model.id}` === requestedModel
    );
  });

  if (selectedModel === undefined) {
    throw new DiffwardenError(
      "invalid_model",
      `Requested Pi model is not available: ${requestedModel}`,
      2,
    );
  }

  return selectedModel;
}

function filterPiModelsByProvider(
  availableModels: PiModel[],
  requestedProvider: string | undefined,
): PiModel[] {
  return requestedProvider === undefined
    ? availableModels
    : availableModels.filter((model) => model.provider === requestedProvider);
}

function formatPiModel(model: PiModel): string {
  if (typeof model.provider === "string" && typeof model.id === "string") {
    return `${model.provider}/${model.id}`;
  }

  if (typeof model.id === "string") {
    return model.id;
  }

  return "unknown";
}

function piProviderMetadata(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): Record<string, string> {
  const providerOptions = normalizePiProviderOptions(reviewer);

  return {
    ...(reviewer.provider !== undefined ? { provider: reviewer.provider } : {}),
    ...(providerOptions.providerProfile !== undefined
      ? { providerProfile: providerOptions.providerProfile }
      : {}),
    ...(providerOptions.apiKeyEnv !== undefined ? { apiKeyEnv: providerOptions.apiKeyEnv } : {}),
    ...(providerOptions.baseUrlEnv !== undefined ? { baseUrlEnv: providerOptions.baseUrlEnv } : {}),
  };
}

function resolvePiEffort(
  model: PiModel,
  requestedEffort: string | undefined,
): { requested?: PiThinkingLevel; effective?: PiThinkingLevel; supported?: PiThinkingLevel[] } {
  if (!isPiThinkingLevel(requestedEffort)) {
    return {};
  }

  const supported = supportedPiThinkingLevels(model);
  return {
    requested: requestedEffort,
    effective: clampPiThinkingLevel(supported, requestedEffort),
    supported,
  };
}

function piSessionEffortOptions(effort: {
  effective?: PiThinkingLevel;
}): Pick<PiCreateAgentSessionOptions, "thinkingLevel"> {
  return effort.effective === undefined ? {} : { thinkingLevel: effort.effective };
}

function piEffortMetadata(effort: {
  requested?: PiThinkingLevel;
  effective?: PiThinkingLevel;
  supported?: PiThinkingLevel[];
}): Record<string, string | string[]> {
  if (effort.requested === undefined) {
    return {};
  }

  return {
    effort: effort.effective ?? effort.requested,
    requestedEffort: effort.requested,
    ...(effort.effective !== undefined ? { effectiveEffort: effort.effective } : {}),
    ...(effort.supported !== undefined ? { supportedEfforts: effort.supported } : {}),
  };
}

function supportedPiThinkingLevels(model: PiModel): PiThinkingLevel[] {
  if (!model.reasoning) {
    return ["off"];
  }

  return piThinkingLevels.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh") {
      return mapped !== undefined;
    }
    return true;
  });
}

function clampPiThinkingLevel(
  supportedLevels: PiThinkingLevel[],
  requestedLevel: PiThinkingLevel,
): PiThinkingLevel {
  if (supportedLevels.includes(requestedLevel)) {
    return requestedLevel;
  }

  const requestedIndex = piThinkingLevels.indexOf(requestedLevel);
  for (let index = requestedIndex; index < piThinkingLevels.length; index += 1) {
    const candidate = piThinkingLevels[index];
    if (candidate !== undefined && supportedLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = piThinkingLevels[index];
    if (candidate !== undefined && supportedLevels.includes(candidate)) {
      return candidate;
    }
  }

  return supportedLevels[0] ?? "off";
}

function isPiThinkingLevel(value: string | undefined): value is PiThinkingLevel {
  return value !== undefined && piThinkingLevels.some((level) => level === value);
}

function bindAbortSignal(
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void> | void,
): () => void {
  if (signal === undefined) {
    return () => {};
  }

  const abort = (): void => {
    try {
      void Promise.resolve(onAbort()).catch(() => undefined);
    } catch {
      // Cancellation is best-effort; the core timeout error remains authoritative.
    }
  };

  if (signal.aborted) {
    abort();
    return () => {};
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw reviewerFailed(message);
}

function materializeScopedEnvAuth(
  authStorage: PiAuthStorage,
  modelRegistry: PiModelRegistry,
  availableModels: PiModel[],
  env: NodeJS.ProcessEnv | undefined,
): void {
  if (env === undefined || authStorage.setRuntimeApiKey === undefined) {
    return;
  }

  const providers = new Set(
    availableModels.flatMap((model) =>
      typeof model.provider === "string" ? [model.provider] : [],
    ),
  );

  for (const provider of providers) {
    const status = modelRegistry.getProviderAuthStatus?.(provider);
    if (status?.source !== "environment" || status.label === undefined) {
      continue;
    }

    const apiKey = env[status.label];
    if (apiKey !== undefined) {
      authStorage.setRuntimeApiKey(provider, apiKey);
    }
  }
}

function createReviewOutputTool(
  capture: (review: ReviewResult) => void,
  captureError: (message: string) => void,
): PiToolDefinition {
  return {
    name: "review_output",
    label: "Review Output",
    description: "Return the final structured code review result. Use this as the final action.",
    promptSnippet: "review_output(review): return the final structured review and terminate",
    promptGuidelines: [
      "Call review_output exactly once when the review is complete.",
      "Do not emit another assistant response after calling review_output.",
    ],
    parameters: reviewResultJsonSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params) {
      const review = unwrapStructuredReview(params);
      if (review === undefined) {
        const message = "Pi reviewer called review_output with invalid arguments";
        captureError(message);
        throw reviewerFailed(message);
      }

      capture(review);
      return {
        content: [{ type: "text", text: "Captured structured review output." }],
        details: review,
        terminate: true,
      };
    },
  };
}

function createExtensionFreeResourceLoader(): PiResourceLoader {
  const extensionRuntime = createEmptyExtensionRuntime();

  return {
    getExtensions() {
      return { extensions: [], errors: [], runtime: extensionRuntime };
    },
    getSkills() {
      return { skills: [], diagnostics: [] };
    },
    getPrompts() {
      return { prompts: [], diagnostics: [] };
    },
    getThemes() {
      return { themes: [], diagnostics: [] };
    },
    getAgentsFiles() {
      return { agentsFiles: [] };
    },
    getSystemPrompt() {
      return undefined;
    },
    getAppendSystemPrompt() {
      return [];
    },
    extendResources() {},
    async reload() {},
  };
}

type EmptyExtensionRuntime = {
  pendingProviderRegistrations: Array<{ name: string; config: unknown; extensionPath: string }>;
};

function createEmptyExtensionRuntime(): EmptyExtensionRuntime & Record<string, unknown> {
  const unavailable = () => {
    throw new Error("Pi extension runtime is disabled for diffwarden reviews.");
  };

  return {
    sendMessage: unavailable,
    sendUserMessage: unavailable,
    appendEntry: unavailable,
    setSessionName: unavailable,
    getSessionName: unavailable,
    setLabel: unavailable,
    getActiveTools: unavailable,
    getAllTools: unavailable,
    setActiveTools: unavailable,
    refreshTools() {},
    getCommands: unavailable,
    setModel() {
      return Promise.reject(new Error("Pi extension runtime is disabled for diffwarden reviews."));
    },
    getThinkingLevel: unavailable,
    setThinkingLevel: unavailable,
    flagValues: new Map<string, boolean | string>(),
    pendingProviderRegistrations: [],
    assertActive() {},
    invalidate() {},
    registerProvider(
      name: string,
      config: unknown,
      extensionPath = "<diffwarden-extension-free-loader>",
    ) {
      this.pendingProviderRegistrations.push({ name, config, extensionPath });
    },
    unregisterProvider(name: string) {
      this.pendingProviderRegistrations = this.pendingProviderRegistrations.filter(
        (registration) => registration.name !== name,
      );
    },
  };
}

function withProcessEnvSync<T>(env: NodeJS.ProcessEnv | undefined, callback: () => T): T {
  if (env === undefined) {
    return callback();
  }

  const originalEnv = process.env;
  try {
    process.env = { ...env };
    return callback();
  } finally {
    process.env = originalEnv;
  }
}
