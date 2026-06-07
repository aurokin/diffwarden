import { missingRequirement } from "../core/errors.js";
import { execCliFile } from "./cli-process.js";

export const antigravityMinimumReviewPolicyVersion = "1.0.6";

export async function assertAntigravityExecutableSupportsReviewPolicy(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  let output: string;
  try {
    const { stdout, stderr } = await execCliFile(executable, ["--version"], {
      ...(env !== undefined ? { env } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    output = `${stdout}${stderr}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Antigravity executable policy preflight failed: ${detail}`);
  }

  const version = antigravityVersion(output);
  if (version === undefined) {
    throw missingRequirement(
      "Antigravity executable policy preflight could not determine agy version. Upgrade Antigravity CLI or configure a newer executable.",
    );
  }

  if (compareVersions(version, antigravityMinimumReviewPolicyVersion) < 0) {
    throw missingRequirement(
      `Antigravity executable ${version} is older than Diffwarden's required review policy version ${antigravityMinimumReviewPolicyVersion}. Upgrade Antigravity CLI or configure a newer executable.`,
    );
  }
}

export function antigravityVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}
