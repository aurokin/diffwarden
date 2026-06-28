import { invalidCli } from "../core/errors.js";
import type { ReviewAdapterOutput, ReviewReviewerConfig } from "./types.js";

export const reviewerSdkValues = [
  "fake",
  "cursor",
  "claude",
  "pi",
  "droid",
  "copilot",
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
  /** npm package import-probed to detect SDK availability (sdk transport only). */
  sdkPackage?: string;
  supportsModel: boolean;
  supportsEffort: boolean;
  captureMode: CaptureMode;
  readonlyCapability: ReadonlyCapability;
};

/** A credential file whose readability indicates a logged-in state. Checked token-free. */
export type ReviewerAuthFile = {
  /** Env var holding the base directory, if any (e.g. CODEX_HOME). */
  baseEnvVar?: string;
  /** Directory under the user home used when baseEnvVar is unset (e.g. ".codex"). */
  homeSubdir: string;
  /** Credential file name within the resolved directory (e.g. "auth.json"). */
  file: string;
};

/**
 * Declarative, token-free auth signals an engine exposes so host-aware discovery can
 * classify readiness without spending model budget or running review prompts.
 */
export type ReviewerAuthSignal = {
  /** Env vars whose presence indicates the engine is authenticated. Any one satisfies the check. */
  envVars?: readonly string[];
  /** When true, the env vars are recommended but their absence is a warning, not a hard failure. */
  envVarsOptional?: boolean;
  /** A credential file that, when readable, indicates a logged-in state. */
  credentialFile?: ReviewerAuthFile;
  /**
   * True when auth is delegated to the engine's own login and cannot be confirmed token-free.
   * Discovery reports the engine as present-but-unverified rather than missing_auth when no
   * other positive signal is found.
   */
  loginDelegated?: boolean;
  /**
   * Transports that cannot use the engine's delegated login and require explicit env/credential
   * auth (e.g. the Cursor SDK needs CURSOR_API_KEY even though the Cursor CLI has its own login).
   * Delegated login is not applied when classifying these transports.
   */
  explicitAuthTransports?: readonly ReviewerTransport[];
};

export type ReviewerCapability = {
  sdk: ReviewerSdk;
  defaultTransport?: ReviewerTransport;
  defaultModel?: string;
  auth?: ReviewerAuthSignal;
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
    auth: {
      envVars: ["CURSOR_API_KEY"],
      loginDelegated: true,
      // The Cursor SDK requires CURSOR_API_KEY; only the cursor-agent CLI has a delegated login.
      explicitAuthTransports: ["sdk"],
    },
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        sdkPackage: "@cursor/sdk",
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
    auth: {
      envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      loginDelegated: true,
    },
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        defaultExecutable: "claude",
        sdkPackage: "@anthropic-ai/claude-agent-sdk",
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
    auth: {
      loginDelegated: true,
    },
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        sdkPackage: "@earendil-works/pi-coding-agent",
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
    auth: {
      envVars: ["FACTORY_API_KEY"],
      envVarsOptional: true,
      loginDelegated: true,
    },
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        defaultExecutable: "droid",
        sdkPackage: "@factory/droid-sdk",
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
  copilot: {
    sdk: "copilot",
    auth: {
      loginDelegated: true,
    },
    transports: {
      sdk: {
        transport: "sdk",
        supported: true,
        sdkPackage: "@github/copilot-sdk",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "text",
        readonlyCapability: "tool-restricted",
      },
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "copilot",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "text",
        readonlyCapability: "tool-restricted",
      },
    },
  },
  codex: {
    sdk: "codex",
    defaultTransport: "cli",
    auth: {
      credentialFile: { baseEnvVar: "CODEX_HOME", homeSubdir: ".codex", file: "auth.json" },
    },
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
    auth: {
      credentialFile: { homeSubdir: ".gemini", file: "oauth_creds.json" },
      loginDelegated: true,
    },
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
    auth: {
      // opencode writes auth.json on first login under the XDG data dir. XDG_DATA_HOME points at
      // the parent of the opencode/ dir (not the dir itself), so it cannot be a baseEnvVar here;
      // the default ~/.local/share/opencode path is probed directly. Logout rewrites the file to
      // {} rather than deleting it, so this is a "logged in at least once" signal. loginDelegated
      // stays the fallback for provider-env/OAuth auth that leaves no token-free file.
      credentialFile: { homeSubdir: ".local/share/opencode", file: "auth.json" },
      loginDelegated: true,
    },
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
    auth: {
      loginDelegated: true,
    },
    transports: {
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "grok",
        supportsModel: true,
        supportsEffort: true,
        captureMode: "text",
        readonlyCapability: "enforced",
      },
    },
  },
  antigravity: {
    sdk: "antigravity",
    defaultTransport: "cli",
    auth: {
      credentialFile: { homeSubdir: ".gemini", file: "oauth_creds.json" },
      loginDelegated: true,
    },
    transports: {
      cli: {
        transport: "cli",
        supported: true,
        defaultExecutable: "agy",
        supportsModel: false,
        supportsEffort: false,
        captureMode: "text",
        readonlyCapability: "tool-restricted",
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

export function getReviewerAuthSignal(sdk: ReviewerSdk): ReviewerAuthSignal | undefined {
  return reviewerCapabilities[sdk].auth;
}

export function reviewerSdkPackage(sdk: ReviewerSdk): string | undefined {
  return reviewerCapabilities[sdk].transports.sdk?.sdkPackage;
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
