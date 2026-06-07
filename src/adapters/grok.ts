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

function helpOutputHasFlag(output: string, flag: string): boolean {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escapedFlag}(?=$|[^\\w-])`).test(output);
}
