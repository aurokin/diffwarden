import {
  type ReviewerSdk,
  type ReviewerTransport,
  defaultReviewerModel,
  defaultReviewerTransport,
  reviewerSupportsModelCatalog,
} from "../adapters/capabilities.js";
import { claudeAdapter } from "../adapters/claude.js";
import { codexAppServerListModels } from "../adapters/codex-app-server.js";
import { cursorAdapter } from "../adapters/cursor.js";
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

/**
 * Engine → listing adapter. Deliberately decoupled from the draft's configured transport
 * (e.g. codex will always list via app-server regardless of the review transport); the
 * per-transport `reviewerSupportsModelCatalog` gate stays the caller-side guard.
 */
const catalogListers: Partial<
  Record<ReviewerSdk, (input: ListModelsInput) => Promise<ModelCatalogEntry[]>>
> = {
  ...(claudeAdapter.listModels !== undefined ? { claude: claudeAdapter.listModels } : {}),
  ...(cursorAdapter.listModels !== undefined ? { cursor: cursorAdapter.listModels } : {}),
  codex: codexAppServerListModels,
};

const catalogFetch: ModelCatalogFetch = (engine, input) => {
  const list = catalogListers[engine];
  if (list === undefined) {
    return Promise.reject(new Error(`No model catalog for engine: ${engine}`));
  }
  return list(input);
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

  // Key on the EFFECTIVE transport: an explicit "sdk" and an unset transport are the same
  // catalog, so a no-op transport toggle must not re-run auth or lose the cached narrowing.
  const key = (draft: ModelCatalogDraft) =>
    `${draft.engine}::${draft.transport ?? defaultReviewerTransport(draft.engine) ?? "sdk"}`;

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
        // Cache successes only: the dominant failure mode is "go log in and come back",
        // and a session-long negative cache would defeat exactly that recovery.
        if (result.status === "ok") {
          cache.set(cacheKey, result);
        }
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
    // Some listing surfaces (copilot's staged workspace) need a directory to run from.
    cwd: process.cwd(),
  };

  // Abort the underlying fetch on timeout so a hung auth probe/SDK query does not
  // keep a subprocess alive after the picker has already degraded to free text.
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const models = await Promise.race([
      fetch(draft.engine, { ...input, signal: abort.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
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
 * "custom…" for ids the catalog does not list. A configured model the catalog omits (a pinned id,
 * a previous custom entry) gets its own row so it stays visible and an accidental Enter keeps it
 * instead of silently clearing the override. Pure so tests can cover it without a TTY.
 */
export function buildModelSelectOptions(
  models: ModelCatalogEntry[],
  engine: ReviewerSdk,
  currentModel?: string,
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
    ...(currentModel !== undefined && !models.some((model) => model.value === currentModel)
      ? [{ value: currentModel, label: currentModel, hint: "current — not in the catalog" }]
      : []),
    { value: CUSTOM_MODEL_CHOICE, label: "custom…", hint: "enter a model id" },
  ];
}

/**
 * Rows for the model autocomplete at a given query — the single source of truth the dynamic
 * options getter returns on every keystroke (when the previously focused row falls out of the
 * filtered set, clack refocuses to index 0 and Enter commits it, so ORDER here is submit
 * behavior). In order:
 *
 * 1. What the query names, first: on a non-empty query, index 0 is the row whose value EXACTLY
 *    matches it (case-insensitive — a case variant of a catalog id should commit the catalog
 *    row, not fork a new slug), hoisted above earlier substring survivors; when NO row matches
 *    exactly, a creatable `use "<typed slug>"` row whose value IS the typed slug. First position
 *    is what makes "one Enter commits what you typed" true, even when the typed id is a
 *    substring of other catalog ids (`gpt-5` amid `gpt-5-fast`) or vice versa.
 * 2. The "default" row, matched ONLY against its literal label: its hint embeds the
 *    engine-default model id, and hint-matching would resurface it — focused first — on exactly
 *    the model-name queries users type, turning Enter into an accidental clear.
 * 3. Catalog + current rows, substring-filtered case-insensitively over value, label, and hint.
 * 4. "custom…" always retained as the free-text escape hatch.
 *
 * Pure so tests can cover the filtering/creatable semantics without a TTY.
 */
export function buildModelAutocompleteOptions(
  models: ModelCatalogEntry[],
  engine: ReviewerSdk,
  currentModel: string | undefined,
  query: string,
  reservedValues: readonly string[] = [],
): { value: string; label: string; hint?: string }[] {
  const base = buildModelSelectOptions(models, engine, currentModel);
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const rows: { value: string; label: string; hint?: string }[] = [];

  const isSelectable = (row: { value: string }) =>
    row.value !== "" && row.value !== CUSTOM_MODEL_CHOICE;
  const exactMatch = base.some((row) => isSelectable(row) && row.value.toLowerCase() === needle);
  // A creatable row whose value collides with a control sentinel (custom…, the caller's quit
  // row) would trigger that action instead of committing the id — such ids stay enterable
  // through the custom… free-text path.
  const reserved = typed === CUSTOM_MODEL_CHOICE || reservedValues.includes(typed);
  if (typed !== "" && !exactMatch && !reserved) {
    rows.push({ value: typed, label: `use "${typed}"`, hint: "off-catalog model id" });
  }

  for (const row of base) {
    if (row.value === CUSTOM_MODEL_CHOICE) {
      rows.push(row);
    } else if (row.value === "") {
      if (needle === "" || row.label.toLowerCase().includes(needle)) {
        rows.push(row);
      }
    } else if (
      needle === "" ||
      `${row.value}\n${row.label}\n${row.hint ?? ""}`.toLowerCase().includes(needle)
    ) {
      rows.push(row);
    }
  }

  // Hoist the exact match to index 0: catalog order may list a substring survivor
  // (`claude-sonnet-4` before `sonnet`) ahead of the row the user typed verbatim.
  if (exactMatch) {
    const exactIndex = rows.findIndex(
      (row) => isSelectable(row) && row.value.toLowerCase() === needle,
    );
    if (exactIndex > 0) {
      rows.unshift(...rows.splice(exactIndex, 1));
    }
  }
  return rows;
}

/**
 * Effort choices narrowed by the catalog: pure intersection with the effective model's
 * supportedEffortLevels, in menu order. Adapters are authoritative — each catalog entry lists
 * exactly the diffwarden levels deliverable to that model over the effective transport (including
 * "off"/"minimal" when applicable), so no shared re-add rules belong here. Returns undefined when
 * the catalog cannot narrow — caller keeps the full menu.
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
  return allChoices.filter((choice) => levels.includes(choice));
}
