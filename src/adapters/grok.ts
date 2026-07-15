import { missingRequirement } from "../core/errors.js";
import { execCliFile } from "./cli-process.js";
import { grokCliReviewPolicyCliFlags } from "./grok-tool-policy.js";

export async function assertGrokExecutableSupportsReviewPolicy(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  requiredFlags: readonly string[] = grokCliReviewPolicyCliFlags,
): Promise<void> {
  let output: string;
  try {
    const { stdout, stderr } = await execCliFile(executable, ["--help"], {
      ...(env !== undefined ? { env } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    output = `${stdout}${stderr}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Grok executable policy preflight failed: ${detail}`);
  }

  const missingFlags = requiredFlags.filter((flag) => !helpOutputHasFlag(output, flag));
  if (missingFlags.length) {
    throw missingRequirement(
      `Grok executable does not support Diffwarden review policy flags: ${missingFlags.join(", ")}. Upgrade Grok CLI or configure a newer executable.`,
    );
  }
}

/**
 * Help-text support probe for grok's native stream output mode. The help
 * output enumerates the --output-format values (live capture 2026-07-15:
 * "plain, json, streaming-json"), so both tokens must appear. Note the
 * spelling: grok's value is `streaming-json`, NOT claude's `stream-json` —
 * the token match requires the full hyphen-bounded word, so a help text
 * enumerating only `stream-json` fails the probe. FAIL CLOSED: any probe
 * failure (timeout, spawn error, nonzero exit) or a help text that does not
 * enumerate streaming-json keeps the review on the verified json mode — the
 * probe must never switch the real review to an unverified output format.
 */
export async function grokCliSupportsStreamingJsonOutput(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
  try {
    const { stdout, stderr } = await execCliFile(executable, ["--help"], {
      ...(env !== undefined ? { env } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      // CLIs that treat piped stdin as a prompt source wait for EOF before
      // printing anything (droid's probe stalled 10s without this).
      closeStdin: true,
    });
    const output = `${stdout}${stderr}`;
    return (
      helpOutputHasFlag(output, "--output-format") && helpOutputHasFlag(output, "streaming-json")
    );
  } catch {
    return false;
  }
}

function helpOutputHasFlag(output: string, flag: string): boolean {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escapedFlag}(?=$|[^\\w-])`).test(output);
}
