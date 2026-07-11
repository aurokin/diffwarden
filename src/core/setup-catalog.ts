import {
  type ReviewerSdk,
  type ReviewerTransport,
  defaultReviewerModel,
  reviewerSupportsModelCatalog,
} from "../adapters/capabilities.js";
import { claudeAdapter } from "../adapters/claude.js";
import type { ListModelsInput, ModelCatalogEntry } from "../adapters/types.js";

/**
 * Live model-catalog access for interactive setup. The clack flows cannot run in CI, so everything
 * decision-shaped lives here as injectable/pure pieces: the session caches one fetch per
 * engine+transport (auth resolution shells out — never repeat it inside a prompt loop), and the
 * select/effort builders are pure functions over the fetched entries.
 */

export type ModelCatalogResult =
  | { status: "ok"; models: ModelCatalogEntry[] }
  | { status: "unavailable"; reason: string };

export type ModelCatalogDraft = {
  id: string;
  engine: ReviewerSdk;
  transport: ReviewerTransport | undefined;
  model: string | undefined;
};

export type ModelCatalogFetch = (
  engine: ReviewerSdk,
  input: ListModelsInput,
) => Promise<ModelCatalogEntry[]>;

const defaultCatalogTimeoutMs = 10_000;

/** Engines with a listModels implementation; gate with reviewerSupportsModelCatalog per transport. */
const catalogFetch: ModelCatalogFetch = (engine, input) => {
  if (engine === "claude" && claudeAdapter.listModels !== undefined) {
    return claudeAdapter.listModels(input);
  }
  return Promise.reject(new Error(`No model catalog for engine: ${engine}`));
};

export type ModelCatalogSession = {
  supports(engine: ReviewerSdk, transport: ReviewerTransport | undefined): boolean;
  /** Fetch (or reuse) the catalog for a draft. Never rejects: failures become `unavailable`. */
  fetch(draft: ModelCatalogDraft): Promise<ModelCatalogResult>;
  /** Cached result only — never triggers a fetch. For consumers like the effort menu. */
  peek(draft: ModelCatalogDraft): ModelCatalogResult | undefined;
};

export function createModelCatalogSession(
  dependencies: {
    fetch?: ModelCatalogFetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): ModelCatalogSession {
  const fetch = dependencies.fetch ?? catalogFetch;
  const timeoutMs = dependencies.timeoutMs ?? defaultCatalogTimeoutMs;
  const env = dependencies.env ?? process.env;
  const cache = new Map<string, ModelCatalogResult>();
  const pending = new Map<string, Promise<ModelCatalogResult>>();

  const key = (draft: ModelCatalogDraft) => `${draft.engine}::${draft.transport ?? "default"}`;

  return {
    supports(engine, transport) {
      return reviewerSupportsModelCatalog(engine, transport);
    },
    async fetch(draft) {
      const cacheKey = key(draft);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const inFlight = pending.get(cacheKey);
      if (inFlight !== undefined) {
        return inFlight;
      }
      const attempt = runCatalogFetch(fetch, draft, env, timeoutMs).then((result) => {
        cache.set(cacheKey, result);
        pending.delete(cacheKey);
        return result;
      });
      pending.set(cacheKey, attempt);
      return attempt;
    },
    peek(draft) {
      return cache.get(key(draft));
    },
  };
}

async function runCatalogFetch(
  fetch: ModelCatalogFetch,
  draft: ModelCatalogDraft,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ModelCatalogResult> {
  // Setup drafts carry no auth settings today, so the fetch resolves auth in "auto"
  // mode; the reviewer still rides along so future drafts with sdkOptions Just Work.
  const input: ListModelsInput = {
    reviewer: {
      id: draft.id,
      sdk: draft.engine,
      ...(draft.transport !== undefined ? { transport: draft.transport } : {}),
      ...(draft.model !== undefined ? { model: draft.model } : {}),
      readonly: true,
    },
    env,
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const models = await Promise.race([
      fetch(draft.engine, input),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        );
      }),
    ]);
    return models.length > 0
      ? { status: "ok", models }
      : { status: "unavailable", reason: "engine returned an empty model catalog" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // First line only: SDK/auth failures can be multi-line, the notice is one line.
    return { status: "unavailable", reason: detail.split("\n")[0] ?? detail };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Sentinel for the free-text escape hatch in the catalog select. */
export const CUSTOM_MODEL_CHOICE = "__custom__" as const;

/**
 * Rows for the model select: "default" (clears the override), one row per catalog entry, then
 * "custom…" for ids the catalog does not list. Pure so tests can cover it without a TTY.
 */
export function buildModelSelectOptions(
  models: ModelCatalogEntry[],
  engine: ReviewerSdk,
): { value: string; label: string; hint?: string }[] {
  const engineDefault = defaultReviewerModel(engine);
  return [
    {
      value: "",
      label: "default",
      hint: engineDefault !== undefined ? `engine default (${engineDefault})` : "engine default",
    },
    ...models.map((model) => ({
      value: model.value,
      label: model.displayName ?? model.value,
      hint: [model.description, model.default === true ? "default" : undefined]
        .filter((piece): piece is string => piece !== undefined)
        .join(" · "),
    })),
    { value: CUSTOM_MODEL_CHOICE, label: "custom…", hint: "enter a model id" },
  ];
}

/**
 * Effort choices narrowed by the catalog: when the draft's effective model carries
 * supportedEffortLevels, keep only those (plus "off", which disables reasoning rather than
 * selecting a level). Returns undefined when the catalog cannot narrow — caller keeps the full menu.
 */
export function catalogEffortChoices(
  result: ModelCatalogResult | undefined,
  draft: ModelCatalogDraft,
  allChoices: readonly string[],
): string[] | undefined {
  if (result === undefined || result.status !== "ok") {
    return undefined;
  }
  const effectiveModel = draft.model ?? defaultReviewerModel(draft.engine);
  const entry = result.models.find((model) => model.value === effectiveModel);
  const levels = entry?.supportedEffortLevels;
  if (levels === undefined || levels.length === 0) {
    return undefined;
  }
  return allChoices.filter((choice) => choice === "off" || levels.includes(choice));
}
