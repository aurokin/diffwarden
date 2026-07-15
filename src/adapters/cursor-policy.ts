import type { AgentModeOption, AgentOptions, LocalAgentOptions } from "@cursor/sdk";
import { execCliFile } from "./cli-process.js";

export const cursorReviewMode = "plan" satisfies AgentModeOption;
export const cursorReviewAutoReview = true;
export const cursorReviewSettingSources = [] satisfies NonNullable<
  LocalAgentOptions["settingSources"]
>;
export const cursorReviewSandboxOptions = {
  enabled: true,
} satisfies NonNullable<LocalAgentOptions["sandboxOptions"]>;
export const cursorReviewMcpServers = {} satisfies NonNullable<AgentOptions["mcpServers"]>;

export const cursorCliReviewMode = "plan";
export const cursorCliSandboxMode = "enabled";

/**
 * Help-text support probe for cursor-agent's native stream output mode. The
 * help output enumerates the --output-format values (live capture 2026-07-15:
 * "text | json | stream-json"), so both tokens must appear. FAIL CLOSED: any
 * probe failure (timeout, spawn error, nonzero exit) or a help text that does
 * not enumerate stream-json keeps the review on the verified json mode — the
 * probe must never switch the real review to an unverified output format.
 */
export async function cursorCliSupportsStreamJsonOutput(
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
      helpOutputHasToken(output, "--output-format") && helpOutputHasToken(output, "stream-json")
    );
  } catch {
    return false;
  }
}

function helpOutputHasToken(output: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}(?=$|[^\\w-])`).test(output);
}
