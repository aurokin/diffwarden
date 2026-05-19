import {
  DiffwardenError,
  missingAuth,
  missingRequirement,
  reviewerFailed,
} from "../core/errors.js";
import { type ReviewResult, reviewResultJsonSchema, reviewResultSchema } from "../core/schema.js";
import type {
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
} from "./types.js";

const piPackageName = "@earendil-works/pi-coding-agent";

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
      const { availableModels } = createPiRuntimeContext(sdk, input.env);

      if (!availableModels.length) {
        throw missingAuth("No authenticated Pi models are available for the Pi reviewer");
      }
      selectPiModel(availableModels, input.reviewer.model);

      const metadata: ReviewAdapterPreflightResult["metadata"] = {
        readonlyCapability: "tool-restricted",
        preferredCaptureMode: "tool-call",
        availableModelCount: availableModels.length,
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
            status: "skipped",
            detail: "Pi profile/model selection is not implemented yet.",
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
      const selectedModel = selectPiModel(availableModels, input.reviewer.model);

      try {
        const sessionManager = sdk.SessionManager.inMemory(input.cwd);
        const { session } = await sdk.createAgentSession({
          cwd: input.cwd,
          model: selectedModel,
          scopedModels: availableModels.map((model) => ({ model })),
          tools: ["read", "grep", "find", "ls", "review_output"],
          customTools: [reviewOutputTool],
          resourceLoader: createExtensionFreeResourceLoader(),
          sessionManager,
          authStorage,
          modelRegistry,
        });

        try {
          await session.prompt(input.prompt);
        } finally {
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

      const parsedReview = reviewResultSchema.safeParse(capturedReview);
      if (!parsedReview.success) {
        throw reviewerFailed("Pi reviewer returned invalid review_output arguments");
      }

      const metadata: ReviewAdapterOutput["metadata"] = {
        captureMode: "tool-call",
        readonlyCapability: "tool-restricted",
        availableModelCount: availableModels.length,
      };

      return {
        structured: parsedReview.data,
        metadata,
      };
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
};

type PiModel = {
  provider?: unknown;
  id?: unknown;
};

type PiAuthStatus = {
  source?: string;
  label?: string;
};

type PiCreateAgentSessionOptions = {
  cwd: string;
  model: PiModel;
  scopedModels: Array<{ model: PiModel }>;
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
): {
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
  availableModels: PiModel[];
} {
  try {
    return withProcessEnvSync(env, () => {
      const authStorage = sdk.AuthStorage.inMemory();
      const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
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

function selectPiModel(availableModels: PiModel[], requestedModel: string | undefined): PiModel {
  if (requestedModel === undefined) {
    const selectedModel = availableModels[0];
    if (selectedModel === undefined) {
      throw missingAuth("No authenticated Pi models are available for the Pi reviewer");
    }
    return selectedModel;
  }

  const selectedModel = availableModels.find((model) => {
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
      const parsedReview = reviewResultSchema.safeParse(params);
      if (!parsedReview.success) {
        const message = "Pi reviewer called review_output with invalid arguments";
        captureError(message);
        throw reviewerFailed(message);
      }

      capture(parsedReview.data);
      return {
        content: [{ type: "text", text: "Captured structured review output." }],
        details: parsedReview.data,
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
