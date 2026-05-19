import { missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
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
      const availableModels = getAvailablePiModels(sdk, input.env);

      if (!availableModels.length) {
        throw missingAuth("No authenticated Pi models are available for the Pi reviewer");
      }

      const metadata: ReviewAdapterPreflightResult["metadata"] = {
        readonlyCapability: "tool-restricted",
        preferredCaptureMode: "tool-call",
        availableModelCount: availableModels.length,
      };

      if (input.reviewer.model !== undefined) {
        metadata.model = input.reviewer.model;
      }

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
    async run(_input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
      throw reviewerFailed(
        "Pi reviewer execution is not implemented yet; the current Pi adapter only supports preflight",
      );
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
};

type PiAuthStorage = unknown;

type PiModelRegistry = {
  getAvailable(): unknown[];
};

async function loadPiSdk(): Promise<PiSdk> {
  try {
    return (await import(piPackageName)) as unknown as PiSdk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Failed to load ${piPackageName}: ${detail}`);
  }
}

function getAvailablePiModels(sdk: PiSdk, env: NodeJS.ProcessEnv | undefined): unknown[] {
  return withProcessEnv(env, () => {
    const authStorage = sdk.AuthStorage.inMemory();
    const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
    return modelRegistry.getAvailable();
  });
}

function withProcessEnv<T>(env: NodeJS.ProcessEnv | undefined, callback: () => T): T {
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
