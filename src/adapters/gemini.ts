import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { missingRequirement } from "../core/errors.js";
import { geminiCliReviewPolicyCliFlags, geminiCliSkipTrustFlag } from "./gemini-tool-policy.js";

const execFileAsync = promisify(execFile);

export async function assertGeminiExecutableSupportsReviewPolicy(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  requiredFlags: readonly string[] = geminiCliReviewPolicyCliFlags,
): Promise<void> {
  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync(executable, [geminiCliSkipTrustFlag, "--help"], {
      ...(env !== undefined ? { env } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    output = `${stdout}${stderr}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Gemini executable policy preflight failed: ${detail}`);
  }

  const missingFlags = requiredFlags.filter((flag) => !helpOutputHasFlag(output, flag));
  if (missingFlags.length) {
    throw missingRequirement(
      `Gemini executable does not support Diffwarden review policy flags: ${missingFlags.join(", ")}. Upgrade Gemini CLI or configure a newer executable.`,
    );
  }
}

function helpOutputHasFlag(output: string, flag: string): boolean {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escapedFlag}(?=$|[^\\w-])`).test(output);
}
