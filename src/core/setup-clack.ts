import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import {
  type ReviewerSdk,
  type ReviewerTransport,
  defaultReviewerModel,
  defaultReviewerTransport,
  getReviewerCapability,
  getTransportCapability,
} from "../adapters/capabilities.js";
import type { ConfiguredReviewerSummary, PublicReviewerEntry } from "./config.js";
import type { ReviewerDiscoveryCandidate } from "./discovery.js";
import {
  CUSTOM_MODEL_CHOICE,
  type ModelCatalogResult,
  type ModelCatalogSession,
  buildModelAutocompleteOptions,
  catalogEffortChoices,
  createModelCatalogSession,
} from "./setup-catalog.js";

/**
 * The interactive reviewer-setup picker, built on @clack/prompts (arrow-key select / multiselect /
 * text). Reached ONLY behind the AUR-583 shouldRunInteractiveSetup + TTY gate, so agents and --json
 * never construct a raw-mode prompt (clack's setRawMode would otherwise hang on a non-TTY pipe). All
 * prompts render to stderr via `io`, keeping stdout clean for the machine-readable result.
 *
 * Exposes per-reviewer transport / model / effort / id / enabled, plus a reviewer-set editor
 * (membership + default-set designation). For multi-transport engines the transport field lists
 * each option with its discovered readiness, so switching surfaces auth gaps (e.g. cursor-sdk needs
 * CURSOR_API_KEY) instead of hiding them. Reviewers that are not `available` are shown as disabled
 * context rows with the reason they are not ready — surfaced, not silently dropped.
 */

// clack reads keys from stdin and must draw to stderr so stdout stays machine-clean. This one object
// is passed to EVERY clack call — the prompts (select/multiselect/text/confirm) AND the framing
// helpers (intro/outro/cancel). Verified against @clack/prompts 1.6.0: intro/outro/cancel each write
// to `opts.output ?? process.stdout`, so passing `io` here routes their framing text to stderr too;
// they do not silently fall back to stdout.
const io = { input: process.stdin, output: process.stderr };

const effortChoices = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Sentinel value for the always-visible "✕ quit" option, distinct from any real field value. */
const QUIT = "__quit__" as const;

const transportLabel: Record<ReviewerTransport, string> = {
  sdk: "native",
  cli: "cli",
  "app-server": "app-server",
};

/**
 * Mutable working copy whose optional fields are explicit `| undefined` so a field can be cleared in
 * place; `toEntry` drops the undefined keys when producing the final on-disk entry.
 */
export type Draft = {
  id: string;
  engine: ReviewerSdk;
  transport: ReviewerTransport | undefined;
  provider: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  enabled: boolean | undefined;
  profile: string | undefined;
};

// The pure draft/hint/capability helpers below are exported so they can be unit-tested directly:
// the interactive flows they drive cannot run in CI (no TTY / raw mode), so this is their only
// automated coverage. They have no side effects and do not touch the terminal.
export function toDraft(entry: PublicReviewerEntry): Draft {
  return {
    id: entry.id,
    engine: entry.engine,
    transport: entry.transport,
    provider: entry.provider,
    model: entry.model,
    effort: entry.effort,
    enabled: entry.enabled,
    profile: entry.profile,
  };
}

export function toEntry(draft: Draft): PublicReviewerEntry {
  return {
    id: draft.id,
    engine: draft.engine,
    ...(draft.transport !== undefined ? { transport: draft.transport } : {}),
    ...(draft.provider !== undefined ? { provider: draft.provider } : {}),
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.effort !== undefined ? { effort: draft.effort } : {}),
    ...(draft.enabled !== undefined ? { enabled: draft.enabled } : {}),
    ...(draft.profile !== undefined ? { profile: draft.profile } : {}),
  };
}

export function effectiveTransport(draft: Draft): ReviewerTransport {
  return draft.transport ?? defaultReviewerTransport(draft.engine) ?? "sdk";
}

/** Supported transports for an engine, in registry order (default-ish first). */
export function availableTransports(engine: ReviewerSdk): ReviewerTransport[] {
  const cap = getReviewerCapability(engine);
  return (Object.keys(cap.transports) as ReviewerTransport[]).filter(
    (transport) => cap.transports[transport]?.supported === true,
  );
}

/**
 * Capability gating keyed off the transport FLAG, not validateReviewerCapabilityOverrides (which
 * returns early for native transport) — so a native reviewer that cannot honor model/effort is
 * locked in the UI rather than writing a silently-inert value.
 */
function rowSupports(draft: Draft): { model: boolean; effort: boolean } {
  const capability = getTransportCapability(draft.engine, effectiveTransport(draft));
  return { model: capability?.supportsModel === true, effort: capability?.supportsEffort === true };
}

/**
 * One-line summary of a reviewer's overrides. Only explicitly-set values appear; an unconfigured
 * reviewer reads "defaults" rather than resolving a default model to a concrete value (which would
 * masquerade as an explicit override).
 */
export function reviewerHint(draft: Draft): string {
  const supports = rowSupports(draft);
  const parts: string[] = [];
  if (supports.model && draft.model !== undefined) {
    parts.push(`model ${draft.model}`);
  }
  if (supports.effort && draft.effort !== undefined) {
    parts.push(`effort ${draft.effort}`);
  }
  if (draft.enabled === false) {
    parts.push("disabled");
  }
  return parts.length > 0 ? parts.join(" · ") : "defaults";
}

/**
 * Field-menu hint for the model row. An explicit override shows verbatim; otherwise it reads
 * "default" — with the known default value in parens when the registry exposes one — so an unset
 * model is clearly the engine/transport default, not a missing/empty value.
 */
export function modelFieldHint(draft: Draft): string {
  if (draft.model !== undefined) {
    return draft.model;
  }
  const fallback = defaultReviewerModel(draft.engine);
  return fallback !== undefined ? `default (${fallback})` : "default";
}

/** Build disabled, non-selectable rows for engines that are not ready, with the reason from discovery. */
export function contextOptions(
  candidates: ReviewerDiscoveryCandidate[],
  ready: PublicReviewerEntry[],
): { value: string; label: string; hint: string; disabled: true }[] {
  const readyEngines = new Set(ready.map((entry) => entry.engine));
  const seen = new Set<ReviewerSdk>();
  const rows: { value: string; label: string; hint: string; disabled: true }[] = [];
  // Candidates arrive sorted best-status-first, so the first non-available hit per engine is the
  // most informative one to surface.
  for (const candidate of candidates) {
    if (
      candidate.status === "available" ||
      readyEngines.has(candidate.engine) ||
      seen.has(candidate.engine)
    ) {
      continue;
    }
    seen.add(candidate.engine);
    rows.push({
      value: `__context_${candidate.engine}`,
      label: `${candidate.engine} · ${transportLabel[candidate.transport]}`,
      hint: candidate.detail,
      disabled: true,
    });
  }
  return rows;
}

function buildCandidateMap(
  candidates: ReviewerDiscoveryCandidate[],
): Map<string, ReviewerDiscoveryCandidate> {
  // Per-(engine, transport) readiness, so the transport field can show each option's auth state.
  const map = new Map<string, ReviewerDiscoveryCandidate>();
  for (const candidate of candidates) {
    map.set(`${candidate.engine}::${candidate.transport}`, candidate);
  }
  return map;
}

/** Scaffold a whole config from discovery (the `init` flow). */
export function runClackReviewerSetup(options: {
  ready: PublicReviewerEntry[];
  candidates: ReviewerDiscoveryCandidate[];
  configPath: string;
}): Promise<PublicReviewerEntry[] | undefined> {
  return runReviewerConfigureFlow({ ...options, title: "diffwarden · setup", writeVerb: "Write" });
}

/** Add reviewers to an existing config (the `reviewers add` flow); the caller merges the result. */
export function runClackReviewerAdd(options: {
  ready: PublicReviewerEntry[];
  candidates: ReviewerDiscoveryCandidate[];
  configPath: string;
  /** Ids already in the config (excluded from `ready`) — an in-picker rename must not collide with them. */
  reservedIds: Set<string>;
}): Promise<PublicReviewerEntry[] | undefined> {
  return runReviewerConfigureFlow({
    ...options,
    title: "diffwarden · add reviewers",
    writeVerb: "Add",
  });
}

/**
 * Shared selection→configure flow behind `init` (scaffold) and `reviewers add` (merge). Returns the
 * configured entries, or undefined when the user backs all the way out, quits, or selects nothing.
 * The caller decides how to persist them; this only shapes the entries.
 */
async function runReviewerConfigureFlow(options: {
  ready: PublicReviewerEntry[];
  candidates: ReviewerDiscoveryCandidate[];
  configPath: string;
  title: string;
  writeVerb: "Write" | "Add";
  reservedIds?: Set<string>;
}): Promise<PublicReviewerEntry[] | undefined> {
  intro(options.title, io);

  const candidateByTransport = buildCandidateMap(options.candidates);
  // One catalog session per run: auth resolution and the model fetch happen at most once per
  // engine+transport, no matter how often the user revisits the model/effort fields.
  const catalog = createModelCatalogSession();
  // Ids a rename must not collide with: those already configured (options.reservedIds) AND every
  // discovered reviewer's own id. The latter matters because a draft renamed to another discovered
  // reviewer's id would collide once that reviewer is also selected — the reconciliation re-adds it
  // under its original id and the write merges by id, silently dropping one. A draft can still keep
  // its own id or take a fresh custom one (see editIdField's `trimmed === entry.id` allowance).
  //
  // This set is intentionally static — it never shrinks when a draft renames away from its id. So a
  // discovery id whose owner has been renamed (pi-a → pi-main) stays reserved and a second draft
  // cannot reclaim the vacated "pi-a". That looks over-conservative in a single screen, but the
  // owner can be deselected and re-picked on a later trip through the multiselect, which re-adds a
  // fresh draft keyed by that original id — resurrecting the exact same-id collision. We prefer a
  // loud "already used" rejection here over a silent merge-drop at write, which is unrecoverable;
  // reusing a just-vacated id is rare, losing a configured reviewer is not an acceptable trade.
  const reservedIds = new Set<string>([
    ...(options.reservedIds ?? []),
    ...options.ready.map((entry) => entry.id),
  ]);

  // Drafts persist across back-and-forth between the selection screen and the configure loop, keyed
  // by the stable discovery id so per-reviewer edits survive stepping back to re-pick reviewers.
  const draftsById = new Map<string, Draft>();

  // F4: an accidental Enter on an empty selection used to hard-abort the whole flow. Warn and
  // re-prompt once; only a second consecutive empty confirm quits.
  let warnedEmptySelection = false;

  while (true) {
    const readyOptions = options.ready.map((entry) => {
      const draft = draftsById.get(entry.id) ?? toDraft(entry);
      return {
        value: entry.id,
        label: `${draft.id}  (${entry.engine} · ${transportLabel[effectiveTransport(draft)]})`,
        hint: reviewerHint(draft),
      };
    });

    const picked = await multiselect({
      message: "Select reviewers to include  (Esc to quit)",
      options: [...readyOptions, ...contextOptions(options.candidates, options.ready)],
      initialValues: options.ready
        .filter((entry) => draftsById.has(entry.id))
        .map((entry) => entry.id),
      required: false,
      ...io,
    });
    // The selection screen is the top level: Esc / Ctrl-C quits (nothing above to step back to).
    if (isCancel(picked)) {
      cancel("Cancelled — nothing written.", io);
      return undefined;
    }

    const chosen = new Set(picked);
    // Reconcile drafts with the selection: drop deselected, add freshly selected, keep the rest.
    for (const id of [...draftsById.keys()]) {
      if (!chosen.has(id)) {
        draftsById.delete(id);
      }
    }
    for (const entry of options.ready) {
      if (chosen.has(entry.id) && !draftsById.has(entry.id)) {
        draftsById.set(entry.id, toDraft(entry));
      }
    }
    const draft = options.ready
      .filter((entry) => chosen.has(entry.id))
      .map((entry) => draftsById.get(entry.id))
      .filter((entry): entry is Draft => entry !== undefined);
    if (draft.length === 0) {
      if (!warnedEmptySelection) {
        warnedEmptySelection = true;
        log.warn("Nothing selected — space toggles a reviewer. Enter again to quit.", io);
        continue;
      }
      cancel("No reviewers selected — nothing written.", io);
      return undefined;
    }
    warnedEmptySelection = false;

    const outcome = await configureLoop(
      draft,
      candidateByTransport,
      options.configPath,
      options.writeVerb,
      reservedIds,
      catalog,
    );
    if (outcome === "back") {
      continue;
    }
    if (outcome === "quit") {
      cancel("Cancelled — nothing written.", io);
      return undefined;
    }
    const gerund = options.writeVerb === "Add" ? "Adding" : "Writing";
    outro(
      `${gerund} ${draft.length} reviewer${draft.length === 1 ? "" : "s"} to ${options.configPath}`,
      io,
    );
    return draft.map(toEntry);
  }
}

/**
 * The configure hub: pick a reviewer to edit, write the config, or leave. Esc / Ctrl-C steps back to
 * the selection screen; the always-visible "✕ quit" option exits the run without writing.
 */
async function configureLoop(
  draft: Draft[],
  candidateByTransport: Map<string, ReviewerDiscoveryCandidate>,
  configPath: string,
  writeVerb: "Write" | "Add",
  reservedIds: Set<string>,
  catalog: ModelCatalogSession,
): Promise<"back" | "quit" | "write"> {
  while (true) {
    const action = await select({
      message: "Configure a reviewer, write, or go back (Esc)",
      options: [
        ...draft.map((entry, index) => ({
          value: String(index),
          label: entry.id,
          hint: `${transportLabel[effectiveTransport(entry)]} · ${reviewerHint(entry)}`,
        })),
        {
          value: "write",
          label: `✓ ${writeVerb} ${draft.length} reviewer${draft.length === 1 ? "" : "s"}`,
          hint: configPath,
        },
        { value: QUIT, label: "✕ quit", hint: "exit without writing" },
      ],
      ...io,
    });
    if (isCancel(action)) {
      return "back";
    }
    if (action === "write") {
      return "write";
    }
    if (action === QUIT) {
      return "quit";
    }
    if (
      (await editReviewer(
        draft,
        Number.parseInt(action, 10),
        candidateByTransport,
        reservedIds,
        catalog,
      )) === "quit"
    ) {
      return "quit";
    }
  }
}

/**
 * Edit one existing reviewer's fields (the `reviewers edit` flow). When no targetId is given it first
 * lets the user pick which configured reviewer to edit. The field menu is the top level, so Esc /
 * Ctrl-C or "✕ quit" cancels without writing; "✓ save changes" returns the id + edited entry.
 * Blanking model / choosing "default" effort clears the override (honored by setReviewerInUserConfig).
 */
export async function runClackReviewerEdit(options: {
  entries: PublicReviewerEntry[];
  targetId?: string;
  candidates: ReviewerDiscoveryCandidate[];
  configPath: string;
}): Promise<{ id: string; entry: PublicReviewerEntry } | undefined> {
  intro("diffwarden · edit reviewer", io);
  const candidateByTransport = buildCandidateMap(options.candidates);
  const catalog = createModelCatalogSession();

  let entry =
    options.targetId !== undefined
      ? options.entries.find((candidate) => candidate.id === options.targetId)
      : undefined;
  if (entry === undefined) {
    const picked = await select({
      message: "Select a reviewer to edit (Esc to cancel)",
      options: options.entries.map((candidate) => ({
        value: candidate.id,
        label: candidate.id,
        hint: `${candidate.engine}${candidate.enabled === false ? " · disabled" : ""}`,
      })),
      ...io,
    });
    if (isCancel(picked)) {
      cancel("Cancelled — nothing written.", io);
      return undefined;
    }
    entry = options.entries.find((candidate) => candidate.id === picked);
  }
  if (entry === undefined) {
    cancel("Cancelled — nothing written.", io);
    return undefined;
  }

  const reviewerId = entry.id;
  const draft = toDraft(entry);

  while (true) {
    const transport = transportLabel[effectiveTransport(draft)];
    const field = await select({
      message: `Editing ${draft.id} (${draft.engine} · ${transport})`,
      options: [
        transportFieldRow(draft),
        modelFieldRow(draft),
        effortFieldRow(draft),
        enabledFieldRow(draft),
        { value: "save", label: "✓ save changes", hint: options.configPath },
        quitOption,
      ],
      ...io,
    });
    if (isCancel(field) || field === QUIT) {
      cancel("Edit cancelled — nothing written.", io);
      return undefined;
    }
    if (field === "save") {
      break;
    }

    let outcome: FieldOutcome = "continue";
    if (field === "transport") {
      outcome = await editTransportField(draft, candidateByTransport);
    } else if (field === "model") {
      outcome = await editModelField(draft, catalog);
    } else if (field === "effort") {
      outcome = await editEffortField(draft, catalog);
    } else if (field === "enabled") {
      outcome = await editEnabledField(draft);
    }
    if (outcome === "quit") {
      cancel("Edit cancelled — nothing written.", io);
      return undefined;
    }
  }

  outro(`Updating ${reviewerId} in ${options.configPath}`, io);
  return { id: reviewerId, entry: toEntry(draft) };
}

/**
 * Pick a configured reviewer to remove (the `reviewers remove` flow), then confirm. Returns the id
 * to remove, or undefined when the user cancels at either step. Confirm defaults to "no" — a stray
 * Enter must not delete a reviewer.
 */
export async function runClackReviewerRemove(options: {
  reviewers: ConfiguredReviewerSummary[];
  configPath: string;
}): Promise<string | undefined> {
  intro("diffwarden · remove reviewer", io);

  const choice = await select({
    message: "Select a reviewer to remove (Esc to cancel)",
    options: options.reviewers.map((reviewer) => ({
      value: reviewer.id,
      label: reviewer.id,
      hint: `${reviewer.engine}${reviewer.enabled ? "" : " · disabled"}`,
    })),
    ...io,
  });
  if (isCancel(choice)) {
    cancel("Cancelled — nothing removed.", io);
    return undefined;
  }

  const confirmed = await confirm({
    message: `Remove "${choice}" from ${options.configPath}?`,
    initialValue: false,
    ...io,
  });
  if (isCancel(confirmed) || confirmed !== true) {
    cancel("Cancelled — nothing removed.", io);
    return undefined;
  }

  outro(`Removing ${choice} from ${options.configPath}`, io);
  return choice;
}

/**
 * Outcome of a leaf field prompt: "quit" propagates a hard exit up to the top of the run, while
 * "continue" returns to the field menu (whether the edit applied or was cancelled with Esc).
 */
type FieldOutcome = "quit" | "continue";

const quitOption = { value: QUIT, label: "✕ quit", hint: "exit without writing" } as const;

/** Field-menu rows for the three shared fields, so init/add/edit render the same transport/model/effort. */
function transportFieldRow(entry: Draft) {
  const currentTransport = effectiveTransport(entry);
  const transport = transportLabel[currentTransport];
  const transports = availableTransports(entry.engine);
  const otherTransports = transports
    .filter((option) => option !== currentTransport)
    .map((option) => transportLabel[option]);
  return {
    value: "transport",
    label: "transport",
    hint:
      transports.length > 1
        ? `${transport} — or ${otherTransports.join(" / ")}`
        : `${transport} — only option`,
    disabled: transports.length <= 1,
  };
}

function modelFieldRow(entry: Draft) {
  const supports = rowSupports(entry);
  const transport = transportLabel[effectiveTransport(entry)];
  return {
    value: "model",
    label: "model",
    hint: supports.model ? modelFieldHint(entry) : `n/a — ${transport} has no per-run model`,
    disabled: !supports.model,
  };
}

function effortFieldRow(entry: Draft) {
  const supports = rowSupports(entry);
  const transport = transportLabel[effectiveTransport(entry)];
  return {
    value: "effort",
    label: "effort",
    hint: supports.effort
      ? (entry.effort ?? "default")
      : `n/a — ${transport} has no per-run effort`,
    disabled: !supports.effort,
  };
}

function enabledFieldRow(entry: Draft) {
  return {
    value: "enabled",
    label: "enabled",
    hint: entry.enabled === false ? "disabled" : "enabled",
  };
}

/** Transport leaf editor: pick a transport (with live auth hints) and clear now-inert overrides. */
async function editTransportField(
  entry: Draft,
  candidateByTransport: Map<string, ReviewerDiscoveryCandidate>,
): Promise<FieldOutcome> {
  const value = await select({
    message: `transport for ${entry.id} (Esc to go back)`,
    options: [
      ...availableTransports(entry.engine).map((option) => {
        const candidate = candidateByTransport.get(`${entry.engine}::${option}`);
        return { value: option, label: transportLabel[option], hint: candidate?.detail ?? "" };
      }),
      quitOption,
    ],
    initialValue: effectiveTransport(entry),
    ...io,
  });
  if (isCancel(value)) {
    return "continue";
  }
  if (value === QUIT) {
    return "quit";
  }
  entry.transport = value;
  // Support can differ by transport; drop now-inert overrides so we never write a dead value.
  const nowSupports = rowSupports(entry);
  if (!nowSupports.model) {
    entry.model = undefined;
  }
  if (!nowSupports.effort) {
    entry.effort = undefined;
  }
  return "continue";
}

/** Fetch (or reuse) a draft's model catalog behind a spinner so auth resolution has visible progress. */
async function fetchCatalogWithSpinner(
  entry: Draft,
  catalog: ModelCatalogSession,
): Promise<ModelCatalogResult> {
  const cached = catalog.peek(entry);
  if (cached !== undefined) {
    return cached;
  }
  const spin = spinner({ output: process.stderr });
  spin.start(`Fetching ${entry.engine} model catalog`);
  const result = await catalog.fetch(entry);
  spin.stop(
    result.status === "ok"
      ? `${entry.engine} model catalog loaded (${result.models.length} models)`
      : `${entry.engine} model catalog unavailable`,
  );
  return result;
}

/**
 * Model leaf editor. Engines whose transport declares supportsModelCatalog get a live catalog
 * autocomplete: typing filters the rows, an off-catalog slug commits in one Enter via the
 * creatable row, only the explicit "default" row clears the override, and "custom…" falls
 * through to an EMPTY free-text prompt. A failed fetch (no auth, offline, timeout) degrades to
 * the free-text prompt — prefilled with the current model — after a one-line notice. Engines
 * without a catalog keep the plain free-text editor, where blank clears the override.
 */
async function editModelField(entry: Draft, catalog: ModelCatalogSession): Promise<FieldOutcome> {
  // The custom… escape hatch opens the free-text prompt empty: the user just declined every
  // catalog row (including the current model's), so prefilling the old value would be stale.
  let prefillFreeText = true;
  if (catalog.supports(entry.engine, entry.transport)) {
    const result = await fetchCatalogWithSpinner(entry, catalog);
    if (result.status === "ok") {
      const { models } = result;
      const currentModel = entry.model;
      const value = await autocomplete<string>({
        message: `model for ${entry.id} (type to filter · Esc to go back)`,
        // Dynamic getter: the sole authority over rows and their order at each keystroke.
        // Focus semantics (clack 1.6 AutocompletePrompt): while typing, focus STAYS on the
        // focused row as long as it survives the filter, and jumps to index 0 only when it
        // drops out. So when the configured model itself matches the query (typing "gpt-5"
        // while gpt-5-fast is configured), Enter keeps the visibly-highlighted current row —
        // standard autocomplete behavior, intentional; the typed slug sits one row above.
        // Fresh entries focus the "default" row, which no model-name query matches, so there
        // typing an off-catalog slug + Enter always commits the slug via the creatable row.
        options() {
          return [
            ...buildModelAutocompleteOptions(models, entry.engine, currentModel, this.userInput, [
              QUIT,
            ]),
            quitOption,
          ];
        },
        // Load-bearing no-op: omitting `filter` does NOT disable filtering — clack falls back
        // to its built-in matcher ON TOP of the getter's output, re-filtering away the pinned
        // rows (creatable/default/custom/quit) the getter deliberately returned.
        filter: () => true,
        // The current model is always a selectable row (catalog or synthetic), so Enter on an
        // empty query preserves the configured value instead of clearing it.
        initialValue: entry.model ?? "",
        ...io,
      });
      if (isCancel(value)) {
        // F8: clack commits the cancelled prompt's typed query to scrollback (strikethrough is
        // unreliable, e.g. under tmux), where it reads like a committed model. State the truth
        // right below it so the ghost cannot be misread.
        log.info(modelUnchangedNote(entry), io);
        return "continue";
      }
      if (value === QUIT) {
        return "quit";
      }
      if (value !== CUSTOM_MODEL_CHOICE) {
        entry.model = value === "" ? undefined : value;
        return "continue";
      }
      prefillFreeText = false;
      // "custom…" falls through to the free-text prompt below.
    } else {
      log.warn(`model catalog unavailable — ${result.reason}`, { output: process.stderr });
    }
  }

  const value = await text({
    message: `model for ${entry.id} (blank = default · Esc to go back)`,
    placeholder: defaultReviewerModel(entry.engine) ?? "default",
    ...(prefillFreeText && entry.model !== undefined ? { initialValue: entry.model } : {}),
    ...io,
  });
  if (isCancel(value)) {
    log.info(modelUnchangedNote(entry), io);
    return "continue";
  }
  const trimmed = value.trim();
  entry.model = trimmed === "" ? undefined : trimmed;
  return "continue";
}

/** F8 cancel note: names the value actually kept, so a cancelled prompt's ghost cannot mislead. */
function modelUnchangedNote(entry: Draft): string {
  return `model unchanged — kept ${entry.model ?? "engine default"}`;
}

/**
 * Effort leaf editor: pick from the effort enum, or "default" to clear the override. When the
 * engine supports a catalog whose effective-model entry lists supportedEffortLevels, the menu
 * narrows to those levels — fetching on demand (cached across fields), so it narrows identically
 * whether the user opens the effort field or the model field first.
 */
async function editEffortField(entry: Draft, catalog: ModelCatalogSession): Promise<FieldOutcome> {
  const result = catalog.supports(entry.engine, entry.transport)
    ? await fetchCatalogWithSpinner(entry, catalog)
    : undefined;
  const narrowed = catalogEffortChoices(result, entry, effortChoices);
  const choices = narrowed !== undefined ? [...narrowed] : [...effortChoices];
  // Keep a previously-set effort selectable even if the catalog would hide it,
  // so the menu always reflects what is currently configured.
  if (entry.effort !== undefined && !choices.includes(entry.effort)) {
    choices.push(entry.effort);
  }
  const value = await select({
    message: `effort for ${entry.id} (Esc to go back)`,
    options: [
      {
        value: "",
        label: "default",
        hint: "diffwarden sets high where supported, else engine decides",
      },
      ...choices.map((e) => ({ value: e, label: e })),
      quitOption,
    ],
    initialValue: entry.effort ?? "",
    ...io,
  });
  if (isCancel(value)) {
    return "continue";
  }
  if (value === QUIT) {
    return "quit";
  }
  entry.effort = value === "" ? undefined : value;
  return "continue";
}

/**
 * Id leaf editor: rename to a fresh id, rejecting empties and any collision. `reservedIds` holds every
 * id a rename must avoid — those already configured AND every other discovered reviewer's id — so the
 * final write can never merge two drafts onto one id (which would silently drop one). Keeping the
 * draft's own current id is always allowed; only a *change* to an already-taken id is rejected.
 */
async function editIdField(
  entry: Draft,
  siblings: Draft[],
  reservedIds: Set<string>,
): Promise<FieldOutcome> {
  const value = await text({
    message: "id (Esc to go back)",
    initialValue: entry.id,
    validate: (input) => {
      const trimmed = (input ?? "").trim();
      if (trimmed === "") {
        return "id cannot be empty";
      }
      // Keeping the current id is a no-op; the reviewer's own id is in reservedIds, so allow it.
      if (trimmed === entry.id) {
        return undefined;
      }
      if (
        reservedIds.has(trimmed) ||
        siblings.some((other) => other !== entry && other.id === trimmed)
      ) {
        return `id "${trimmed}" is already used by another reviewer`;
      }
      return undefined;
    },
    ...io,
  });
  if (isCancel(value)) {
    return "continue";
  }
  entry.id = value.trim();
  return "continue";
}

/** Enabled leaf editor: toggle the disabled placeholder (active reviewers omit `enabled`). */
async function editEnabledField(entry: Draft): Promise<FieldOutcome> {
  const value = await select({
    message: `enabled for ${entry.id} (Esc to go back)`,
    options: [
      { value: "true", label: "enabled", hint: "reviewer runs" },
      { value: "false", label: "disabled", hint: "kept in config but skipped" },
      quitOption,
    ],
    initialValue: entry.enabled === false ? "false" : "true",
    ...io,
  });
  if (isCancel(value)) {
    return "continue";
  }
  if (value === QUIT) {
    return "quit";
  }
  entry.enabled = value === "false" ? false : undefined;
  return "continue";
}

/**
 * Per-reviewer field editor for the init/add configure loop. Esc / Ctrl-C steps back one level:
 * inside a field prompt it discards just that edit and returns to the field menu; at the field menu
 * it returns "back" to the configure loop. The always-visible "✕ quit" option returns "quit" to abort
 * the whole run. So the picker is a wizard you can back out of step by step, with a hard exit always
 * one keystroke away.
 */
async function editReviewer(
  draft: Draft[],
  index: number,
  candidateByTransport: Map<string, ReviewerDiscoveryCandidate>,
  reservedIds: Set<string>,
  catalog: ModelCatalogSession,
): Promise<"back" | "quit"> {
  while (true) {
    const entry = draft[index];
    if (entry === undefined) {
      return "back";
    }
    const transport = transportLabel[effectiveTransport(entry)];

    const field = await select({
      message: `Editing ${entry.id} (${entry.engine} · ${transport})`,
      options: [
        transportFieldRow(entry),
        modelFieldRow(entry),
        effortFieldRow(entry),
        { value: "id", label: "id", hint: entry.id },
        // Present at add time too: some users configure reviewers disabled up front and only
        // enable them later (often via an agent) when they are ready to spend that budget.
        enabledFieldRow(entry),
        { value: "back", label: "← back" },
        quitOption,
      ],
      ...io,
    });
    if (isCancel(field) || field === "back") {
      return "back";
    }
    if (field === QUIT) {
      return "quit";
    }

    let outcome: FieldOutcome = "continue";
    if (field === "transport") {
      outcome = await editTransportField(entry, candidateByTransport);
    } else if (field === "model") {
      outcome = await editModelField(entry, catalog);
    } else if (field === "effort") {
      outcome = await editEffortField(entry, catalog);
    } else if (field === "id") {
      outcome = await editIdField(entry, draft, reservedIds);
    } else if (field === "enabled") {
      outcome = await editEnabledField(entry);
    }
    if (outcome === "quit") {
      return "quit";
    }
  }
}

/**
 * Interactive reviewer-set editor (the bare `reviewers set` flow): pick a set (or create
 * one), toggle membership with current members pre-checked, and optionally make it the
 * default set. Returns the full replacement to persist, or undefined when the user cancels.
 * The caller does the atomic write (replaceReviewerSetInUserConfig) with the read-time sha.
 */
export async function runClackReviewerSetEdit(options: {
  reviewers: ConfiguredReviewerSummary[];
  sets: Record<string, string[]>;
  defaultReviewerSet: string | undefined;
  configPath: string;
}): Promise<{ setName: string; members: string[]; makeDefault: boolean } | undefined> {
  intro("diffwarden · reviewer sets", io);

  const NEW_SET = "__new_set__";
  const setNames = Object.keys(options.sets);
  const picked = await select({
    message: "Select a reviewer set to edit (Esc to cancel)",
    options: [
      ...setNames.map((name) => ({
        value: name,
        label: name,
        hint: `${(options.sets[name] ?? []).join(", ") || "empty"}${
          name === options.defaultReviewerSet ? " · default" : ""
        }`,
      })),
      { value: NEW_SET, label: "＋ new set…", hint: "create a reviewer set" },
    ],
    ...io,
  });
  if (isCancel(picked)) {
    cancel("Cancelled — nothing written.", io);
    return undefined;
  }

  let setName = picked;
  if (picked === NEW_SET) {
    const typed = await text({
      message: "Name for the new set (Esc to cancel)",
      validate(value) {
        const trimmed = (value ?? "").trim();
        if (trimmed === "") {
          return "Set name cannot be empty";
        }
        if (setNames.includes(trimmed)) {
          return `Set "${trimmed}" already exists — pick it from the list instead`;
        }
        return undefined;
      },
      ...io,
    });
    if (isCancel(typed)) {
      cancel("Cancelled — nothing written.", io);
      return undefined;
    }
    setName = typed.trim();
  }

  const currentMembers = options.sets[setName] ?? [];
  const isDefault = setName === options.defaultReviewerSet;

  // Same warn-then-abort shape as the reviewer multiselect (F4): an accidental empty Enter
  // must not commit. Emptying the DEFAULT set is refused outright — the write-path guard
  // would reject it anyway; failing here keeps the refusal interactive instead of terminal.
  let warnedEmptySelection = false;
  let members: string[];
  while (true) {
    const pickedMembers = await multiselect({
      message: `Members of "${setName}"  (space toggles · enter confirms · Esc cancels)`,
      options: options.reviewers.map((reviewer) => ({
        value: reviewer.id,
        label: reviewer.id,
        hint: `${reviewer.engine}${reviewer.enabled ? "" : " · disabled"}`,
      })),
      initialValues: currentMembers.filter((member) =>
        options.reviewers.some((reviewer) => reviewer.id === member),
      ),
      required: false,
      ...io,
    });
    if (isCancel(pickedMembers)) {
      cancel("Cancelled — nothing written.", io);
      return undefined;
    }
    if (pickedMembers.length === 0) {
      if (isDefault) {
        cancel(`"${setName}" is the default reviewer set and cannot be emptied.`, io);
        return undefined;
      }
      if (!warnedEmptySelection) {
        warnedEmptySelection = true;
        log.warn(
          "Nothing selected — space toggles a reviewer. Enter again to save an empty set.",
          io,
        );
        continue;
      }
    }
    members = pickedMembers;
    break;
  }

  let makeDefault = false;
  if (!isDefault && members.length > 0) {
    const answer = await confirm({
      message: `Make "${setName}" the default reviewer set?${
        options.defaultReviewerSet !== undefined
          ? `  (currently "${options.defaultReviewerSet}")`
          : ""
      }`,
      initialValue: options.defaultReviewerSet === undefined,
      ...io,
    });
    // Esc on the default question is a "no", not a flow cancel: the membership edit stands.
    makeDefault = answer === true;
  }

  outro(`Updating reviewer set "${setName}" in ${options.configPath}`, io);
  return { setName, members, makeDefault };
}
