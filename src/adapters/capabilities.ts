import { invalidCli } from "../core/errors.js";
import type { ReviewAdapterOutput, ReviewReviewerConfig } from "./types.js";

export const reviewerSdkValues = [
  "fake",
  "cursor",
  "claude",
  "pi",
  "droid",
  "codex",
  "gemini",
  "opencode",
  "grok",
  "antigravity",
] as const;

export type ReviewerSdk = (typeof reviewerSdkValues)[number];
export type ReviewerTransport = NonNullable<ReviewReviewerConfig["transport"]>;
export type ReadonlyCapability = NonNullable<
  NonNullable<ReviewAdapterOutput["metadata"]>["readonlyCapability"]
>;
export type CaptureMode = NonNullable<NonNullable<ReviewAdapterOutput["metadata"]>["captureMode"]>;

export type ReviewerTransportCapability = {
  transport: ReviewerTransport;
  supported: boolean;
  defaultExecutable?: string;
  supportsModel: boolean;
  supportsEffort: boolean;
  captureMode: CaptureMode;
  readonlyCapability: ReadonlyCapability;
};

export type ReviewerCapability = {
  sdk: ReviewerSdk;
  defaultTransport?: ReviewerTransport;
  defaultModel?: string;
  transports: Partial<Record<ReviewerTransport, ReviewerTransportCapability>>;
};

const reviewerCapabilityDefinitions = {
  fake: {
    sdk: "fake",
    transports: {},
  },
  cursor: {
    sdk: "cursor",
    defaultModel: "composer-2.5",
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        supportsModel: true,
        supportsEffort: false,
        captureMode: "text",
        readonlyCapability: "prompt-only",
      },
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "cursor-agent",
        supportsModel: true,
        supportsEffort: false,
        captureMode: "text",
        readonlyCapability: "prompt-only",
      },
    },
  },
  claude: {
    sdk: "claude",
    defaultModel: "sonnet",
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        defaultExecutable: "claude",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "native-structured",
        readonlyCapability: "tool-restricted",
      },
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "claude",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "native-structured",
        readonlyCapability: "tool-restricted",
      },
    },
  },
  pi: {
    sdk: "pi",
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        supportsModel: true,
        supportsEffort: true,
        captureMode: "tool-call",
        readonlyCapability: "tool-restricted",
      },
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "pi",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "text",
        readonlyCapability: "tool-restricted",
      },
    },
  },
  droid: {
    sdk: "droid",
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        defaultExecutable: "droid",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "native-structured",
        readonlyCapability: "enforced",
      },
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "droid",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "text",
        readonlyCapability: "enforced",
      },
    },
  },
  codex: {
    sdk: "codex",
    defaultTransport: "cli",
    transports: {
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "codex",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "native-structured",
        readonlyCapability: "enforced",
      },
      "app-server": {
        transport: "app-server",
        supported: true,
        defaultExecutable: "codex",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "native-structured",
        readonlyCapability: "enforced",
      },
    },
  },
  gemini: {
    sdk: "gemini",
    defaultTransport: "cli",
    transports: {
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "gemini",
        supportsModel: true,
        supportsEffort: false,
        captureMode: "text",
        readonlyCapability: "tool-restricted",
      },
    },
  },
  opencode: {
    sdk: "opencode",
    defaultTransport: "cli",
    transports: {
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "opencode",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "text",
        readonlyCapability: "prompt-only",
      },
    },
  },
  grok: {
    sdk: "grok",
    defaultTransport: "cli",
    transports: {
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "grok",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "text",
        readonlyCapability: "prompt-only",
      },
    },
  },
  antigravity: {
    sdk: "antigravity",
    defaultTransport: "cli",
    transports: {
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "agy",
        supportsModel: false,
        supportsEffort: false,
        captureMode: "text",
        readonlyCapability: "prompt-only",
      },
    },
  },
} as const satisfies Record<ReviewerSdk, ReviewerCapability>;

export const reviewerCapabilities: Record<ReviewerSdk, ReviewerCapability> =
  reviewerCapabilityDefinitions;

export function isReviewerSdk(value: string | undefined): value is ReviewerSdk {
  return reviewerSdkValues.some((sdk) => sdk === value);
}

export function getReviewerCapability(sdk: ReviewerSdk): ReviewerCapability {
  return reviewerCapabilities[sdk];
}

export function defaultReviewerTransport(sdk: ReviewerSdk): ReviewerTransport | undefined {
  return reviewerCapabilities[sdk].defaultTransport;
}

export function defaultReviewerModel(sdk: ReviewerSdk): string | undefined {
  return reviewerCapabilities[sdk].defaultModel;
}

export function getTransportCapability(
  sdk: ReviewerSdk,
  transport: ReviewerTransport,
): ReviewerTransportCapability | undefined {
  return reviewerCapabilities[sdk].transports[transport];
}

export function reviewerCapabilityDefaults(
  sdk: ReviewerSdk,
  model: string | undefined,
): Pick<ReviewReviewerConfig, "model" | "transport"> {
  return {
    ...reviewerDefaultTransport(sdk),
    ...reviewerDefaultModel(sdk, model),
  };
}

export function reviewerTransportDefaults(
  sdk: ReviewerSdk,
): Pick<ReviewReviewerConfig, "transport"> {
  return reviewerDefaultTransport(sdk);
}

export function validateReviewerCapabilityOverrides(
  reviewer: ReviewReviewerConfig,
): ReviewReviewerConfig {
  const transport = reviewer.transport ?? "sdk";
  if (transport !== "cli" && transport !== "app-server") {
    return reviewer;
  }

  const capability = getTransportCapability(reviewer.sdk, transport);

  if (capability === undefined || !capability.supported) {
    throw invalidCli(`${reviewer.sdk} ${transport} transport is not supported`);
  }

  if (capability.supportsModel !== true && reviewer.model !== undefined) {
    throw invalidCli(`${reviewer.sdk} CLI transport does not support per-run model overrides`);
  }

  if (capability.supportsEffort !== true && reviewer.effort !== undefined) {
    throw invalidCli(`${reviewer.sdk} CLI transport does not support per-run effort overrides`);
  }

  return reviewer;
}

function reviewerDefaultTransport(sdk: ReviewerSdk): Pick<ReviewReviewerConfig, "transport"> {
  const transport = defaultReviewerTransport(sdk);
  return transport === undefined ? {} : { transport };
}

function reviewerDefaultModel(
  sdk: ReviewerSdk,
  model: string | undefined,
): Pick<ReviewReviewerConfig, "model"> {
  if (model !== undefined) {
    return { model };
  }

  const defaultModel = defaultReviewerModel(sdk);
  return defaultModel === undefined ? {} : { model: defaultModel };
}
