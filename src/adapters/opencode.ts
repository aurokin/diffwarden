import { missingAuth } from "../core/errors.js";
import { cliExecutable } from "./cli-helpers.js";
import { execCliFile, resolveExecutable } from "./cli-process.js";
import type { ListModelsInput, ModelCatalogEntry } from "./types.js";

/**
 * Opencode model listing: shell `opencode models` and take each plain `provider/model` line as
 * an id. Ids only, deliberately — opencode's effort variants are arbitrary model-specific
 * strings delivered verbatim as `--variant`, so there is no effort metadata to narrow with,
 * and the effort menu stays full exactly as it is today.
 */
export async function opencodeListModels(input: ListModelsInput): Promise<ModelCatalogEntry[]> {
  const executable = await resolveExecutable(cliExecutable(input.reviewer, "opencode"), input.env);
  try {
    const { stdout } = await execCliFile(executable, ["models"], {
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      closeStdin: true,
    });
    return parseOpencodeModels(stdout, input.reviewer.provider);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not (logged|signed) in|unauthorized|unauthenticated|log ?in|authenticat/i.test(detail)) {
      throw missingAuth('opencode is not authenticated — run "opencode auth login"');
    }
    throw error;
  }
}

/**
 * One `provider/model` id per line; anything else (banners, blank lines, log noise with
 * spaces) is skipped, so an empty result degrades to the catalog session's "unavailable".
 *
 * A provider-scoped reviewer gets BARE ids under its provider: the provider already rides in
 * the reviewer's own `provider` field, and a qualified value would double-qualify the CLI
 * invocation (`--model anthropic/anthropic/...`).
 */
export function parseOpencodeModels(stdout: string, provider?: string): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.trim();
    if (id === "" || id.includes(" ") || !id.includes("/")) {
      continue;
    }
    if (provider === undefined) {
      entries.push({ value: id });
    } else if (id.startsWith(`${provider}/`)) {
      entries.push({ value: id.slice(provider.length + 1) });
    }
  }
  return entries;
}
