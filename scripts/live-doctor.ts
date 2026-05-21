import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

type Check = {
  id: string;
  kind: "sdk" | "cli";
  executable?: string;
  auth: string;
};

const checks: Check[] = [
  {
    id: "cursor-sdk",
    kind: "sdk",
    auth: process.env.CURSOR_API_KEY ? "env present" : "missing CURSOR_API_KEY",
  },
  {
    id: "claude-sdk",
    kind: "sdk",
    auth: process.env.ANTHROPIC_API_KEY
      ? "ANTHROPIC_API_KEY present"
      : "API key absent; Claude Code auth may work",
  },
  { id: "pi-sdk", kind: "sdk", auth: "provider auth checked by Pi preflight" },
  { id: "codex", kind: "cli", executable: "codex", auth: "delegated to CLI" },
  { id: "claude-cli", kind: "cli", executable: "claude", auth: "delegated to CLI" },
  { id: "cursor-cli", kind: "cli", executable: "cursor-agent", auth: "delegated to CLI" },
  { id: "gemini", kind: "cli", executable: "gemini", auth: "delegated to CLI" },
  { id: "opencode", kind: "cli", executable: "opencode", auth: "delegated to CLI" },
  { id: "pi-cli", kind: "cli", executable: "pi", auth: "delegated to CLI" },
  { id: "grok", kind: "cli", executable: "grok", auth: "delegated to CLI" },
  { id: "antigravity", kind: "cli", executable: "agy", auth: "delegated to CLI" },
];

for (const check of checks) {
  const result =
    check.kind === "cli" && check.executable !== undefined
      ? await cliStatus(check.id, check.executable)
      : "n/a";
  process.stdout.write(
    `${check.id.padEnd(12)} ${check.kind.padEnd(3)} ${result.padEnd(46)} ${check.auth}\n`,
  );
}

async function cliStatus(id: string, fallback: string): Promise<string> {
  const executable = process.env[`DIFFWARDEN_LIVE_${envName(id)}_EXECUTABLE`] ?? fallback;
  const resolved = await resolveExecutable(executable);
  return resolved === undefined ? `missing executable: ${executable}` : `found: ${resolved}`;
}

async function resolveExecutable(executable: string): Promise<string | undefined> {
  if (executable.includes(path.sep)) {
    return (await isExecutable(executable)) ? executable : undefined;
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, executable);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envName(id: string): string {
  return id.replace(/-cli$/, "").replace(/-sdk$/, "").replace("-", "_").toUpperCase();
}
