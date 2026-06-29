import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ReviewerTransport } from "../adapters/capabilities.js";
import type { ConfiguredReviewerSummary, PublicReviewerEntry } from "./config.js";
import type { ReviewerDiscoveryResult } from "./discovery.js";

/**
 * A narrow interactive prompt surface for explicit config changes. Deliberately frameworkless
 * (node:readline only, no TUI dependency) per docs/adr/0001; injectable streams keep it testable.
 */
export type Prompter = {
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  select(question: string, choices: string[]): Promise<number>;
  close(): void;
};

export function isInteractiveAvailable(stream: { isTTY?: boolean } = process.stdin): boolean {
  return stream.isTTY === true;
}

/**
 * Decide whether a config-mutating setup command should drop into its guided flow (AUR-583's
 * interactive-by-default-in-a-TTY dispatch). `--json` never blocks on input; an explicit
 * `--interactive` opts in (the caller still guards for a real TTY, so a non-TTY `--interactive`
 * errors rather than hanging); otherwise the guided flow is the default only when stdin is a TTY.
 */
export function shouldRunInteractiveSetup(
  options: { interactive?: boolean; json?: boolean },
  stream: { isTTY?: boolean } = process.stdin,
): boolean {
  if (options.json === true) {
    return false;
  }
  if (options.interactive === true) {
    return true;
  }
  return isInteractiveAvailable(stream);
}

export function createReadlinePrompter(io: { input?: Readable; output?: Writable } = {}): Prompter {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = readline.createInterface({ input, output });

  return {
    async confirm(question, defaultYes) {
      const hint = defaultYes ? "[Y/n]" : "[y/N]";
      const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
      if (answer === "") {
        return defaultYes;
      }
      return answer === "y" || answer === "yes";
    },
    async select(question, choices) {
      for (const [index, choice] of choices.entries()) {
        output.write(`  ${index + 1}) ${choice}\n`);
      }
      while (true) {
        const answer = (await rl.question(`${question} [1-${choices.length}]: `)).trim();
        const parsed = Number.parseInt(answer, 10);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= choices.length) {
          return parsed - 1;
        }
        output.write(`Enter a number between 1 and ${choices.length}.\n`);
      }
    },
    close() {
      rl.close();
    },
  };
}

const publicTransportLabel: Record<ReviewerTransport, string> = {
  sdk: "native",
  cli: "cli",
  "app-server": "app-server",
};

/**
 * Present discovered, addable reviewers and return the entry the user selected, or undefined
 * when nothing is addable.
 */
export async function promptSelectReviewerEntry(
  prompter: Prompter,
  result: ReviewerDiscoveryResult,
): Promise<PublicReviewerEntry | undefined> {
  const addable = result.candidates.filter((candidate) => candidate.recommended !== undefined);
  if (addable.length === 0) {
    return undefined;
  }

  const labels = addable.map(
    (candidate) =>
      `${candidate.engine} [${publicTransportLabel[candidate.transport]}] — ${candidate.detail}`,
  );
  const index = await prompter.select("Select a reviewer to add", labels);
  const recommendation = addable[index]?.recommended;
  if (recommendation === undefined) {
    return undefined;
  }

  return {
    id: recommendation.id,
    engine: recommendation.engine,
    ...(recommendation.transport !== undefined ? { transport: recommendation.transport } : {}),
    ...(recommendation.model !== undefined ? { model: recommendation.model } : {}),
  };
}

/**
 * Present the configured reviewers and return the id the user picked, or undefined when there are
 * none to choose. Drives the no-id `reviewers remove` / `reviewers edit` interactive paths, which
 * pick *which* configured reviewer to act on (the patch/force still come from flags).
 */
export async function promptSelectConfiguredReviewer(
  prompter: Prompter,
  reviewers: ConfiguredReviewerSummary[],
  action: string,
): Promise<string | undefined> {
  if (reviewers.length === 0) {
    return undefined;
  }
  const labels = reviewers.map(
    (reviewer) => `${reviewer.id} (${reviewer.engine})${reviewer.enabled ? "" : " [disabled]"}`,
  );
  const index = await prompter.select(`Select a reviewer to ${action}`, labels);
  return reviewers[index]?.id;
}

export function confirmRemoveReviewer(
  prompter: Prompter,
  id: string,
  targetPath: string,
): Promise<boolean> {
  // Default to no: removal is destructive, so an empty Enter must not delete a reviewer.
  return prompter.confirm(`Remove reviewer "${id}" from ${targetPath}?`, false);
}

export function confirmEditReviewer(
  prompter: Prompter,
  id: string,
  targetPath: string,
): Promise<boolean> {
  return prompter.confirm(`Edit reviewer "${id}" in ${targetPath}?`, true);
}

export function confirmWriteEntry(
  prompter: Prompter,
  entry: PublicReviewerEntry,
  targetPath: string,
): Promise<boolean> {
  return prompter.confirm(`Add reviewer "${entry.id}" (${entry.engine}) to ${targetPath}?`, true);
}

export function confirmScaffold(
  prompter: Prompter,
  reviewers: PublicReviewerEntry[],
  targetPath: string,
): Promise<boolean> {
  const ids = reviewers.map((reviewer) => reviewer.id).join(", ");
  return prompter.confirm(
    `Create ${targetPath} with ${reviewers.length} reviewer${
      reviewers.length === 1 ? "" : "s"
    } (${ids})?`,
    true,
  );
}

/**
 * Let the user choose which discovered reviewers to scaffold, confirming each one. Returns the
 * included subset so interactive `init --discover` selects before writing rather than writing
 * every available reviewer.
 */
export async function selectScaffoldReviewers(
  prompter: Prompter,
  reviewers: PublicReviewerEntry[],
): Promise<PublicReviewerEntry[]> {
  const selected: PublicReviewerEntry[] = [];
  for (const reviewer of reviewers) {
    if (await prompter.confirm(`Include ${reviewer.id} (${reviewer.engine})?`, true)) {
      selected.push(reviewer);
    }
  }
  return selected;
}
