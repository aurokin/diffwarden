/**
 * TTY-gate helpers for the config-mutating setup commands (AUR-583). These decide *whether* a command
 * may drop into its interactive flow; the flow itself is the @clack/prompts picker in setup-clack.ts.
 * Kept dependency-free and pure so the dispatch decision is trivially testable.
 */

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
