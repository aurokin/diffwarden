import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  CreateModelRuntimeOptions,
  ModelRuntime,
  ResourceLoader,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
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
import {
  effortResolutionMetadata,
  modelResolutionMetadata,
  sdkOutputMetadata,
  sdkPreflightMetadata,
} from "./metadata.js";
import { piReviewOutputToolName, piSdkReviewTools } from "./pi-tool-policy.js";
import { activitySinkFromDebugOutput } from "./reviewer-activity.js";
import type {
  ListModelsInput,
  ModelCatalogEntry,
  ReviewAdapter,
  ReviewAdapterInput,
  ReviewAdapterOutput,
  ReviewAdapterPreflightInput,
  ReviewAdapterPreflightResult,
  ReviewReviewerValueSource,
} from "./types.js";

const piPackageName = "@earendil-works/pi-coding-agent";
const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const piAuthSources = ["isolated", "shared"] as const;
const piTransportSettings = ["auto", "sse", "websocket", "websocket-cached"] as const;
const piMessageDeliveryModes = ["all", "one-at-a-time"] as const;
const piReviewSettingsKeys = [
  "transport",
  "steeringMode",
  "followUpMode",
  "thinkingBudgets",
] as const;
const piThinkingBudgetKeys = ["minimal", "low", "medium", "high"] as const;
const defaultPiReviewSettings: Partial<PiSettings> = {
  transport: "auto",
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
};

type PiThinkingLevel = (typeof piThinkingLevels)[number];
type PiAuthSource = (typeof piAuthSources)[number];
type PiTransportSetting = (typeof piTransportSettings)[number];
type PiMessageDeliveryMode = (typeof piMessageDeliveryModes)[number];

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
      const { availableModels, authOptions } = await createPiRuntimeContext(
        sdk,
        input.env,
        input.reviewer,
      );

      if (!availableModels.length) {
        throw missingAuth("No authenticated Pi models are available for the Pi reviewer");
      }
      const selectedModel = selectPiModel(
        availableModels,
        input.reviewer.model,
        input.reviewer.provider,
      );
      const candidateModels = filterPiModelsByProvider(availableModels, input.reviewer.provider);
      const effort = resolvePiEffort(
        selectedModel,
        input.reviewer.effort,
        input.reviewer.effortSource,
      );
      const settingsManager = createPiSettingsManager(sdk, input.reviewer);

      const metadata: ReviewAdapterPreflightResult["metadata"] = sdkPreflightMetadata("pi", {
        availableModelCount: availableModels.length,
        model: formatPiModel(selectedModel),
        ...piModelResolutionMetadata(input.reviewer, selectedModel),
        ...piProviderMetadata(input.reviewer),
        ...piAuthMetadata(authOptions),
        ...piEffortMetadata(effort),
        ...piImplicitModelSelectionMetadata(input.reviewer, candidateModels),
        ...piSettingsMetadata(settingsManager),
      });

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
            detail: piAuthCheckDetail(availableModels.length, authOptions),
          },
          {
            name: "model",
            status: shouldWarnOnImplicitPiModelSelection(input.reviewer, candidateModels)
              ? "warning"
              : "passed",
            detail: piModelCheckDetail(input.reviewer, selectedModel, candidateModels),
          },
          {
            name: "readonly",
            status: "passed",
            detail: "Pi scaffold will use the read, grep, find, and ls tools for execution.",
          },
          {
            name: "settings",
            status: "passed",
            detail:
              "Pi SDK sessions use isolated in-memory settings; Diffwarden only applies a reviewer timeout when configured.",
          },
        ],
        metadata,
      };
    },
    async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      const sdk = await dependencies.loadSdk();
      const { modelRuntime, availableModels, authOptions } = await createPiRuntimeContext(
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
      const candidateModels = filterPiModelsByProvider(availableModels, input.reviewer.provider);
      const effort = resolvePiEffort(
        selectedModel,
        input.reviewer.effort,
        input.reviewer.effortSource,
      );
      const settingsManager = createPiSettingsManager(sdk, input.reviewer);

      // Event summaries deliberately feed the artifact's debug_output recorder
      // (mirroring the claude/droid/copilot SDK adapters): raw AgentSession
      // events embed thinking parts and full tool payloads the debug contract
      // excludes. Observation only — the prompt invocation is identical either
      // way, and the review_output capture path stays untouched.
      const activity = activitySinkFromDebugOutput("pi-sdk", input.debugOutput);
      let debugCaptureActive = false;

      try {
        const sessionManager = sdk.SessionManager.inMemory(input.cwd);
        const { session } = await sdk.createAgentSession({
          cwd: input.cwd,
          model: selectedModel,
          ...piSessionEffortOptions(effort),
          scopedModels: candidateModels.map((model) => ({
            model,
            ...piSessionEffortOptions(
              resolvePiEffort(model, input.reviewer.effort, input.reviewer.effortSource),
            ),
          })),
          tools: [...piSdkReviewTools],
          customTools: [reviewOutputTool],
          resourceLoader: createExtensionFreeResourceLoader(sdk),
          sessionManager,
          settingsManager,
          modelRuntime,
        });

        const removeAbortListener = bindAbortSignal(input.signal, () => session.abort());
        let unsubscribeDebug: (() => void) | undefined;
        try {
          throwIfAborted(input.signal, "Pi reviewer aborted before prompting");
          // Subscribe only when a debug sink exists; a session without
          // subscribe yields zero debug output rather than an error.
          if (activity !== undefined && typeof session.subscribe === "function") {
            unsubscribeDebug = session.subscribe((event) => activity.event(event));
            debugCaptureActive = true;
          }
          await session.prompt(input.prompt);
        } finally {
          // Both paths — success and throw — drop the debug subscription and
          // flush; debug teardown never fails the review.
          try {
            unsubscribeDebug?.();
          } catch {
            // Debug never fails the review.
          }
          activity?.end();
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

      const metadata: ReviewAdapterOutput["metadata"] = sdkOutputMetadata("pi", {
        // Keyed on the live subscription, not the opt-in alone: unlike the
        // other SDK adapters, a Pi session without subscribe captures nothing,
        // so event-summary mode is only reported when events could flow.
        ...(debugCaptureActive ? { debugOutputMode: "event-summary" } : {}),
        availableModelCount: availableModels.length,
        model: formatPiModel(selectedModel),
        ...piModelResolutionMetadata(input.reviewer, selectedModel),
        ...piProviderMetadata(input.reviewer),
        ...piAuthMetadata(authOptions),
        ...piEffortMetadata(effort),
        ...piImplicitModelSelectionMetadata(input.reviewer, candidateModels),
        ...piSettingsMetadata(settingsManager),
      });

      const output = buildStructuredReviewAdapterOutput(capturedReview, {
        metadata,
      });
      if (output === undefined) {
        throw reviewerFailed("Pi reviewer returned invalid review_output arguments");
      }

      return output;
    },
    async listModels(input: ListModelsInput): Promise<ModelCatalogEntry[]> {
      const sdk = await dependencies.loadSdk();
      // List with the CLI's SHARED auth.json when it exists and the reviewer did not pick a
      // source explicitly: the SDK default is isolated in-memory storage, which would list an
      // EMPTY catalog for every pi-CLI-authenticated user. The catalog is suggestions, never
      // validation (an SDK reviewer without shared auth still fails preflight with its own
      // actionable message if an unusable model is chosen), and review runs keep their
      // existing isolated default. The existence probe matters: AuthStorage.create CREATES
      // auth.json (and its parent dir) when absent, and merely opening a picker must not
      // write outside the repo — a signed-out user falls back to isolated listing, which
      // still surfaces env-API-key models. When the file exists, create() may refresh an
      // expired OAuth token in place, exactly as the pi CLI itself does.
      const explicitSource = optionalStringOption(input.reviewer.sdkOptions, "authSource");
      const reviewer =
        explicitSource !== undefined || !piSharedAuthFileExists(sdk, input.env)
          ? input.reviewer
          : {
              ...input.reviewer,
              sdkOptions: { ...input.reviewer.sdkOptions, authSource: "shared" },
            };
      const { availableModels } = await createPiRuntimeContext(sdk, input.env, reviewer);
      // Scope to the reviewer's provider, and emit BARE ids in that case: the provider is
      // already carried in the reviewer's separate `provider` field, so a provider-qualified
      // value would double-qualify on the CLI path (`--model anthropic/anthropic/...`) and
      // let the picker save a model preflight would reject as outside the provider.
      const entries = filterPiModelsByProvider(availableModels, input.reviewer.provider)
        .filter((model) => typeof model.id === "string")
        .map((model) => piCatalogEntry(model, input.reviewer.provider !== undefined));
      // Signed-out pi does not throw — getAvailable() simply returns nothing. Surface the
      // actionable state instead of a generic "empty model catalog" notice.
      if (entries.length === 0) {
        throw missingAuth(
          input.reviewer.provider !== undefined && availableModels.length > 0
            ? `No authenticated Pi models are available for provider: ${input.reviewer.provider}`
            : "pi is not authenticated — launch pi and run /login",
        );
      }
      return entries;
    },
  };
}

/**
 * Value is the provider-qualified id (`selectPiModel` accepts it verbatim, and bare ids can
 * collide across providers) — except for provider-scoped reviewers, whose values must stay
 * bare (see listModels). Effort levels reuse `supportedPiThinkingLevels` unchanged — it is
 * already exact per model, including `["off"]` for non-reasoning models.
 */
function piCatalogEntry(model: PiModel, bareId: boolean): ModelCatalogEntry {
  return {
    value: bareId && typeof model.id === "string" ? model.id : formatPiModel(model),
    supportedEffortLevels: supportedPiThinkingLevels(model),
  };
}

/** True when the CLI's shared auth.json already exists; never creates it. */
function piSharedAuthFileExists(sdk: PiSdk, env: NodeJS.ProcessEnv | undefined): boolean {
  if (sdk.getAgentDir === undefined) {
    return false;
  }
  // getAgentDir reads PI_CODING_AGENT_DIR/HOME from process.env.
  const agentDir = withProcessEnvSync(env, () => sdk.getAgentDir?.());
  return agentDir !== undefined && existsSync(path.join(agentDir, "auth.json"));
}

export const piAdapter = createPiAdapter();

type PiSdk = {
  createExtensionRuntime: typeof createExtensionRuntime;
  ModelRuntime: {
    create(options: CreateModelRuntimeOptions): Promise<PiModelRuntime>;
  };
  getAgentDir?(): string;
  SessionManager: {
    inMemory(cwd?: string): PiSessionManager;
  };
  SettingsManager?: {
    inMemory(settings?: Partial<PiSettings>): PiSettingsManager;
  };
  createAgentSession(options: PiCreateAgentSessionOptions): Promise<PiCreateAgentSessionResult>;
};

type PiSessionManager = unknown;
type PiResourceLoader = ResourceLoader;
type PiSettingsManager = {
  getTransport?(): string;
  getSteeringMode?(): string;
  getFollowUpMode?(): string;
  getThinkingBudgets?(): PiSettings["thinkingBudgets"];
  getCompactionSettings(): {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
  getRetrySettings(): {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
  };
  getProviderRetrySettings(): {
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs: number;
  };
  getHttpIdleTimeoutMs?(): number;
};

type PiSettings = {
  transport?: PiTransportSetting;
  steeringMode?: PiMessageDeliveryMode;
  followUpMode?: PiMessageDeliveryMode;
  thinkingBudgets?: {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
  };
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    provider?: {
      timeoutMs?: number;
      maxRetries?: number;
      maxRetryDelayMs?: number;
    };
  };
  httpIdleTimeoutMs?: number;
};

type PiModelRuntime = {
  getAvailable(provider?: string): Promise<readonly PiModel[]>;
  setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
  registerProvider(providerName: string, config: PiProviderConfig): void;
  getProviders: ModelRuntime["getProviders"];
  registerNativeProvider: ModelRuntime["registerNativeProvider"];
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

type PiCreateAgentSessionOptions = {
  cwd: string;
  model: PiModel;
  thinkingLevel?: PiThinkingLevel;
  scopedModels: Array<{ model: PiModel; thinkingLevel?: PiThinkingLevel }>;
  tools: string[];
  customTools: PiToolDefinition[];
  resourceLoader: PiResourceLoader;
  sessionManager: PiSessionManager;
  settingsManager: PiSettingsManager;
  modelRuntime: PiModelRuntime;
};

type PiCreateAgentSessionResult = {
  session: PiSession;
};

type PiSession = {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  /**
   * Live event feed running alongside `prompt`. Optional: older Pi SDKs may
   * not expose it, and its absence means zero debug output — a well-defined
   * absence, never an error.
   */
  subscribe?(listener: (event: unknown) => void): () => void;
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
    // 0.85.0's entrypoint imports an unpublished pi-server dependency; stay on 0.84.4.
    const sdk = await import("@earendil-works/pi-coding-agent");
    return {
      ModelRuntime: sdk.ModelRuntime,
      createExtensionRuntime: sdk.createExtensionRuntime,
      getAgentDir: sdk.getAgentDir,
      SessionManager: sdk.SessionManager,
      SettingsManager: sdk.SettingsManager,
      // The adapter's injectable session shape omits provider-specific model/tool fields.
      createAgentSession: sdk.createAgentSession as unknown as PiSdk["createAgentSession"],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Failed to load ${piPackageName}: ${detail}`);
  }
}

async function createPiRuntimeContext(
  sdk: PiSdk,
  env: NodeJS.ProcessEnv | undefined,
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): Promise<{
  modelRuntime: PiModelRuntime;
  availableModels: PiModel[];
  authOptions: NormalizedPiAuthOptions;
}> {
  try {
    const authOptions = normalizePiAuthOptions(reviewer);
    const providerOptions = normalizePiProviderOptions(reviewer);
    // Pi 0.81 replaced AuthStorage/ModelRegistry session options with ModelRuntime.
    // Disable disk model configuration and network catalog refresh for review isolation.
    const authPath =
      authOptions.authPath ??
      withProcessEnvSync(env, () => {
        const directory = sdk.getAgentDir?.();
        return directory === undefined ? undefined : path.join(directory, "auth.json");
      });
    const modelRuntime = await sdk.ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
      ...(authOptions.source === "shared"
        ? authPath === undefined
          ? {}
          : { authPath }
        : { credentials: createPiMemoryCredentials() }),
    });
    const providerApiKey = await materializeConfiguredProviderAuth(
      modelRuntime,
      reviewer,
      env,
      providerOptions,
    );
    materializeConfiguredProviderRegistration(
      modelRuntime,
      reviewer,
      env,
      providerOptions,
      providerApiKey,
    );
    scopePiProviderEnvironment(modelRuntime, env);
    const providers = modelRuntime.getProviders();
    const availableModels =
      providers.length === 0
        ? [...(await modelRuntime.getAvailable())]
        : (
            await Promise.all(providers.map((provider) => modelRuntime.getAvailable(provider.id)))
          ).flat();
    return { modelRuntime, availableModels, authOptions };
  } catch (error) {
    if (error instanceof DiffwardenError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw reviewerFailed(`Pi reviewer setup failed: ${detail}`);
  }
}

function createPiMemoryCredentials(): NonNullable<CreateModelRuntimeOptions["credentials"]> {
  type Credential = Awaited<
    ReturnType<NonNullable<CreateModelRuntimeOptions["credentials"]>["read"]>
  >;
  const credentials = new Map<string, Exclude<Credential, undefined>>();
  return {
    async read(provider) {
      return credentials.get(provider);
    },
    async list() {
      return [...credentials].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(provider, update) {
      const credential = await update(credentials.get(provider));
      if (credential !== undefined) credentials.set(provider, credential);
      return credentials.get(provider);
    },
    async delete(provider) {
      credentials.delete(provider);
    },
  };
}

/** Bind asynchronous provider auth to the review environment without changing process.env. */
function scopePiProviderEnvironment(
  runtime: PiModelRuntime,
  env: NodeJS.ProcessEnv | undefined,
): void {
  if (env === undefined) return;
  const scopedEnv = { ...env };
  for (const provider of runtime.getProviders()) {
    const apiKey = provider.auth.apiKey;
    if (apiKey === undefined) continue;
    const check = apiKey.check;
    runtime.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        apiKey: {
          ...apiKey,
          ...(check === undefined
            ? {}
            : {
                check: (input) =>
                  check({ ...input, ctx: { ...input.ctx, env: async (name) => scopedEnv[name] } }),
              }),
          resolve: (input) =>
            apiKey.resolve({
              ...input,
              ctx: { ...input.ctx, env: async (name) => scopedEnv[name] },
            }),
        },
      },
    });
  }
}

async function materializeConfiguredProviderAuth(
  modelRuntime: PiModelRuntime,
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  env: NodeJS.ProcessEnv | undefined,
  providerOptions: NormalizedPiProviderOptions,
): Promise<string | undefined> {
  if (providerOptions.apiKeyEnv === undefined) {
    return undefined;
  }

  const apiKey = env?.[providerOptions.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw missingAuth(`Missing ${providerOptions.apiKeyEnv} for Pi provider ${reviewer.provider}`);
  }

  await modelRuntime.setRuntimeApiKey(providerOptions.provider, apiKey);
  return apiKey;
}

function materializeConfiguredProviderRegistration(
  modelRuntime: PiModelRuntime,
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  env: NodeJS.ProcessEnv | undefined,
  providerOptions: NormalizedPiProviderOptions,
  providerApiKey: string | undefined,
): void {
  if (providerOptions.baseUrlEnv === undefined) {
    return;
  }

  const baseUrl = env?.[providerOptions.baseUrlEnv]?.trim();
  if (!baseUrl) {
    throw missingRequirement(
      `Missing ${providerOptions.baseUrlEnv} for Pi provider ${reviewer.provider}`,
    );
  }

  modelRuntime.registerProvider(providerOptions.provider, {
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

type NormalizedPiAuthOptions = {
  source: PiAuthSource;
  authPath?: string;
};

function normalizePiAuthOptions(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): NormalizedPiAuthOptions {
  const requestedSource = optionalStringOption(reviewer.sdkOptions, "authSource");
  const authPath = optionalStringOption(reviewer.sdkOptions, "authPath");

  if (requestedSource !== undefined && !isPiAuthSource(requestedSource)) {
    throw invalidConfig(
      `Pi authSource must be one of: ${piAuthSources.join(", ")} (got ${requestedSource})`,
    );
  }

  const source: PiAuthSource = requestedSource ?? "isolated";

  if (authPath !== undefined && source !== "shared") {
    throw invalidConfig('Pi authPath requires sdkOptions.authSource "shared"');
  }

  return {
    source,
    ...(authPath !== undefined ? { authPath: expandHomePath(authPath) } : {}),
  };
}

function createPiSettingsManager(
  sdk: PiSdk,
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): PiSettingsManager {
  if (sdk.SettingsManager?.inMemory === undefined) {
    throw missingRequirement(
      `${piPackageName} does not expose SettingsManager.inMemory; upgrade the package to use the Pi SDK reviewer`,
    );
  }

  const settings = normalizePiReviewSettings(reviewer);
  try {
    return sdk.SettingsManager.inMemory(settings);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw reviewerFailed(`Pi reviewer settings setup failed: ${detail}`);
  }
}

function piSettingsMetadata(settingsManager: PiSettingsManager): Record<string, unknown> {
  const retry = settingsManager.getRetrySettings();
  const providerRetry = settingsManager.getProviderRetrySettings();
  const compaction = settingsManager.getCompactionSettings();
  const transport = settingsManager.getTransport?.();
  const steeringMode = settingsManager.getSteeringMode?.();
  const followUpMode = settingsManager.getFollowUpMode?.();
  const thinkingBudgets = settingsManager.getThinkingBudgets?.();
  const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs?.();

  return {
    piSettingsSource: "in-memory",
    piSettingsDiskInheritance: false,
    piTimeoutPolicy: "diffwarden-configured-reviewer-timeout",
    piTransport: transport ?? null,
    piTransportSource: transport === undefined ? "not-exposed-by-installed-pi-sdk" : "settings",
    piSteeringMode: steeringMode ?? null,
    piSteeringModeSource:
      steeringMode === undefined ? "not-exposed-by-installed-pi-sdk" : "settings",
    piFollowUpMode: followUpMode ?? null,
    piFollowUpModeSource:
      followUpMode === undefined ? "not-exposed-by-installed-pi-sdk" : "settings",
    piThinkingBudgets: thinkingBudgets ?? null,
    piThinkingBudgetsSource:
      settingsManager.getThinkingBudgets === undefined
        ? "not-exposed-by-installed-pi-sdk"
        : thinkingBudgets === undefined
          ? "unset"
          : "settings",
    piRetryEnabled: retry.enabled,
    piRetryMaxRetries: retry.maxRetries,
    piRetryBaseDelayMs: retry.baseDelayMs,
    piProviderTimeoutMs: providerRetry.timeoutMs ?? null,
    piProviderTimeoutSource: providerRetry.timeoutMs === undefined ? "sdk-default" : "settings",
    piProviderMaxRetries: providerRetry.maxRetries ?? null,
    piProviderMaxRetriesSource: providerRetry.maxRetries === undefined ? "sdk-default" : "settings",
    piProviderMaxRetryDelayMs: providerRetry.maxRetryDelayMs,
    piCompactionEnabled: compaction.enabled,
    piCompactionReserveTokens: compaction.reserveTokens,
    piCompactionKeepRecentTokens: compaction.keepRecentTokens,
    piHttpIdleTimeoutMs: httpIdleTimeoutMs ?? null,
    piHttpIdleTimeoutSource:
      httpIdleTimeoutMs === undefined ? "not-exposed-by-installed-pi-sdk" : "sdk-default",
  };
}

function normalizePiReviewSettings(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
): Partial<PiSettings> {
  const rawSettings = reviewer.sdkOptions?.settings;
  if (rawSettings === undefined) {
    return defaultPiReviewSettings;
  }
  if (!isRecord(rawSettings)) {
    throw invalidConfig("Pi sdkOptions.settings must be an object");
  }

  for (const key of Object.keys(rawSettings)) {
    if (!isPiReviewSettingsKey(key)) {
      throw invalidConfig(
        `Pi sdkOptions.settings.${key} is not supported; supported fields: ${piReviewSettingsKeys.join(", ")}`,
      );
    }
  }

  const settings: Partial<PiSettings> = { ...defaultPiReviewSettings };
  if (rawSettings.transport !== undefined) {
    settings.transport = piTransportOption(rawSettings.transport, "sdkOptions.settings.transport");
  }
  if (rawSettings.steeringMode !== undefined) {
    settings.steeringMode = piMessageDeliveryModeOption(
      rawSettings.steeringMode,
      "sdkOptions.settings.steeringMode",
    );
  }
  if (rawSettings.followUpMode !== undefined) {
    settings.followUpMode = piMessageDeliveryModeOption(
      rawSettings.followUpMode,
      "sdkOptions.settings.followUpMode",
    );
  }
  if (rawSettings.thinkingBudgets !== undefined) {
    settings.thinkingBudgets = piThinkingBudgetsOption(
      rawSettings.thinkingBudgets,
      "sdkOptions.settings.thinkingBudgets",
    );
  }

  return settings;
}

function piTransportOption(value: unknown, name: string): PiTransportSetting {
  if (!isPiTransportSetting(value)) {
    throw invalidConfig(`${name} must be one of: ${piTransportSettings.join(", ")}`);
  }
  return value;
}

function piMessageDeliveryModeOption(value: unknown, name: string): PiMessageDeliveryMode {
  if (!isPiMessageDeliveryMode(value)) {
    throw invalidConfig(`${name} must be one of: ${piMessageDeliveryModes.join(", ")}`);
  }
  return value;
}

function isPiReviewSettingsKey(value: string): value is (typeof piReviewSettingsKeys)[number] {
  return piReviewSettingsKeys.some((key) => key === value);
}

function isPiTransportSetting(value: unknown): value is PiTransportSetting {
  return typeof value === "string" && piTransportSettings.some((transport) => transport === value);
}

function isPiMessageDeliveryMode(value: unknown): value is PiMessageDeliveryMode {
  return typeof value === "string" && piMessageDeliveryModes.some((mode) => mode === value);
}

function piThinkingBudgetsOption(
  value: unknown,
  name: string,
): NonNullable<PiSettings["thinkingBudgets"]> {
  if (!isRecord(value)) {
    throw invalidConfig(`${name} must be an object`);
  }

  const budgets: NonNullable<PiSettings["thinkingBudgets"]> = {};
  for (const key of Object.keys(value)) {
    if (!isPiThinkingBudgetKey(key)) {
      throw invalidConfig(
        `${name}.${key} is not supported; supported fields: ${piThinkingBudgetKeys.join(", ")}`,
      );
    }
  }

  for (const level of piThinkingBudgetKeys) {
    const budget = value[level];
    if (budget === undefined) {
      continue;
    }
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
      throw invalidConfig(`${name}.${level} must be a positive number`);
    }
    budgets[level] = budget;
  }

  return budgets;
}

function isPiThinkingBudgetKey(value: string): value is (typeof piThinkingBudgetKeys)[number] {
  return piThinkingBudgetKeys.some((key) => key === value);
}

function piAuthMetadata(authOptions: NormalizedPiAuthOptions): Record<string, string> {
  return {
    authSource: authOptions.source,
    ...(authOptions.authPath !== undefined ? { authPath: authOptions.authPath } : {}),
  };
}

function piAuthCheckDetail(modelCount: number, authOptions: NormalizedPiAuthOptions): string {
  if (authOptions.source === "shared") {
    const location = authOptions.authPath ?? "default Pi CLI auth.json";
    return `${modelCount} Pi model(s) are available from shared CLI auth (${location}).`;
  }

  return `${modelCount} Pi model(s) are available from environment-backed auth.`;
}

function isPiAuthSource(value: string): value is PiAuthSource {
  return piAuthSources.some((source) => source === value);
}

function expandHomePath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.slice(2));
  }

  return filePath;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function piModelResolutionMetadata(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  selectedModel: PiModel,
): Record<string, string> {
  return modelResolutionMetadata({
    requested: reviewer.model,
    resolved: formatPiModel(selectedModel),
    source:
      reviewer.model === undefined ? "adapter-selection" : (reviewer.modelSource ?? "requested"),
  });
}

function piImplicitModelSelectionMetadata(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  candidateModels: PiModel[],
): Record<string, unknown> {
  const implicit = reviewer.model === undefined;

  return {
    piImplicitModelSelection: implicit,
    ...(implicit
      ? {
          piImplicitModelCandidateCount: candidateModels.length,
          piImplicitModelSelectionScope:
            reviewer.provider === undefined ? "all-authenticated-models" : "provider",
        }
      : {}),
  };
}

function shouldWarnOnImplicitPiModelSelection(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  candidateModels: PiModel[],
): boolean {
  return reviewer.model === undefined && candidateModels.length > 1;
}

function piModelCheckDetail(
  reviewer: ReviewAdapterInput["reviewer"] | ReviewAdapterPreflightInput["reviewer"],
  selectedModel: PiModel,
  candidateModels: PiModel[],
): string {
  const selected = formatPiModel(selectedModel);
  if (reviewer.model !== undefined) {
    return `Using requested Pi model: ${selected}.`;
  }

  const scope =
    reviewer.provider === undefined
      ? "all authenticated Pi models"
      : `provider ${reviewer.provider}`;

  if (candidateModels.length > 1) {
    return `No Pi model configured; using first available Pi model: ${selected} from ${candidateModels.length} candidate(s) in ${scope}. Pin reviewer.model for stable provider-heavy profiles.`;
  }

  return `No Pi model configured; using only available Pi model: ${selected} in ${scope}.`;
}

function resolvePiEffort(
  model: PiModel,
  requestedEffort: string | undefined,
  source: ReviewReviewerValueSource | undefined,
): {
  requested?: PiThinkingLevel | "max";
  effective?: PiThinkingLevel;
  supported?: PiThinkingLevel[];
  source?: Extract<ReviewReviewerValueSource, "config" | "env" | "requested">;
} {
  // Pi has no max thinking level; clamp with xhigh but report the public
  // requested value so the down-mapping stays visible in metadata.
  const piEffort = requestedEffort === "max" ? "xhigh" : requestedEffort;
  if (!isPiThinkingLevel(piEffort)) {
    return {};
  }

  const supported = supportedPiThinkingLevels(model);
  return {
    requested: requestedEffort === "max" ? "max" : piEffort,
    effective: clampPiThinkingLevel(supported, piEffort),
    supported,
    ...(source === "config" || source === "env" || source === "requested" ? { source } : {}),
  };
}

function piSessionEffortOptions(effort: {
  effective?: PiThinkingLevel;
}): Pick<PiCreateAgentSessionOptions, "thinkingLevel"> {
  return effort.effective === undefined ? {} : { thinkingLevel: effort.effective };
}

function piEffortMetadata(effort: {
  requested?: PiThinkingLevel | "max";
  effective?: PiThinkingLevel;
  supported?: PiThinkingLevel[];
  source?: Extract<ReviewReviewerValueSource, "config" | "env" | "requested">;
}): Record<string, string | string[]> {
  if (effort.requested === undefined) {
    return {};
  }

  return {
    effort: effort.effective ?? effort.requested,
    ...effortResolutionMetadata({
      requested: effort.requested,
      resolved: effort.effective ?? effort.requested,
      source:
        effort.effective === effort.requested
          ? (effort.source ?? "requested")
          : "adapter-selection",
    }),
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

function createReviewOutputTool(
  capture: (review: ReviewResult) => void,
  captureError: (message: string) => void,
): PiToolDefinition {
  return {
    name: piReviewOutputToolName,
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

function createExtensionFreeResourceLoader(sdk: PiSdk): PiResourceLoader {
  const extensionRuntime = sdk.createExtensionRuntime();

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
    getSystemPromptSource() {
      return undefined;
    },
    getAppendSystemPromptSources() {
      return [];
    },
    getAppendSystemPrompt() {
      return [];
    },
    extendResources() {},
    async reload() {},
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
