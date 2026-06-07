import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { missingAuth, missingRequirement, reviewerFailed } from "../core/errors.js";
import type { CliInvocation, CliRunResult } from "./cli-types.js";
import type { ReviewAdapterInput } from "./types.js";

const abortKillGraceMs = 1_000;
const defaultWindowsPathExt = ".COM;.EXE;.BAT;.CMD";
const execFileAsync = promisify(execFile);

type ExecCliFileOptions = {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
  timeout?: number;
};

export async function runCli(
  invocation: CliInvocation,
  input: ReviewAdapterInput,
): Promise<CliRunResult> {
  throwIfAborted(input.signal, `${invocation.executable} reviewer aborted before start`);
  const env = {
    ...(input.env ?? process.env),
    ...invocation.env,
  };
  for (const key of invocation.unsetEnv ?? []) {
    Reflect.deleteProperty(env, key);
  }
  const executable =
    invocation.resolvedExecutable ?? (await resolveExecutable(invocation.executable, env));

  return await new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, invocation.args, {
        cwd: invocation.cwd ?? input.cwd,
        env,
        detached: process.platform !== "win32",
        shell: shouldUseWindowsCommandShell(executable),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(classifyCliStartError(executable, error));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let abortError: Error | undefined;
    let abortKillTimer: NodeJS.Timeout | undefined;

    const removeAbortListener = bindAbortSignal(input.signal, () => {
      abortError = reviewerFailed(`${invocation.executable} reviewer aborted`);
      killChildProcess(child, "SIGTERM");
      abortKillTimer = setTimeout(() => killChildProcess(child, "SIGKILL"), abortKillGraceMs);
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", (error) => {
      if (isNodeErrorWithCode(error, "EPIPE")) {
        return;
      }
      rejectOnce(reviewerFailed(`${invocation.executable} stdin failed: ${error.message}`));
    });
    child.on("error", (error) => {
      removeAbortListener();
      if (abortKillTimer !== undefined) {
        clearTimeout(abortKillTimer);
      }
      if (isNodeErrorWithCode(error, "ENOENT")) {
        rejectOnce(missingRequirement(`CLI executable not found: ${executable}`));
        return;
      }
      rejectOnce(classifyCliStartError(executable, error));
    });
    child.on("close", (code, signal) => {
      removeAbortListener();
      if (abortKillTimer !== undefined) {
        clearTimeout(abortKillTimer);
      }
      if (abortError !== undefined) {
        rejectOnce(abortError);
        return;
      }
      const result = {
        executable,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `signal ${signal ?? "none"}`;
        rejectOnce(classifyCliExit(invocation.executable, code, detail));
        return;
      }
      resolveOnce(result);
    });

    try {
      if (invocation.stdin !== undefined) {
        child.stdin.end(invocation.stdin);
      } else {
        child.stdin.end();
      }
    } catch (error) {
      rejectOnce(reviewerFailed(`${invocation.executable} stdin failed: ${errorMessage(error)}`));
    }

    function resolveOnce(result: CliRunResult): void {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }

    function rejectOnce(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    }
  });
}

function killChildProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.killed && signal === "SIGTERM") {
    return;
  }

  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }

  child.kill(signal);
}

export async function resolveExecutable(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  if (isPathLikeExecutable(executable)) {
    for (const candidate of executableSearchNames(executable, env)) {
      try {
        await assertExecutable(candidate);
        return candidate;
      } catch {
        // Keep searching PATHEXT candidates on Windows.
      }
    }
    throw missingRequirement(`CLI executable not found: ${executable}`);
  }

  for (const directory of ((env === undefined ? process.env.PATH : env.PATH) ?? "").split(
    path.delimiter,
  )) {
    if (!directory) {
      continue;
    }
    for (const executableName of executableSearchNames(executable, env)) {
      const candidate = path.join(directory, executableName);
      try {
        await assertExecutable(candidate);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  throw missingRequirement(`CLI executable not found: ${executable}`);
}

export async function execCliFile(
  executable: string,
  args: string[],
  options: ExecCliFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    ...options,
    shell: shouldUseWindowsCommandShell(executable),
  });
  return {
    stdout: String(stdout),
    stderr: String(stderr),
  };
}

export function executableSearchNames(
  executable: string,
  env: NodeJS.ProcessEnv | undefined = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || path.extname(executable)) {
    return [executable];
  }

  return [
    executable,
    ...windowsPathExtensions(env).map((extension) => `${executable}${extension}`),
  ];
}

export function shouldUseWindowsCommandShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:bat|cmd)$/i.test(executable);
}

function isPathLikeExecutable(executable: string): boolean {
  return (
    executable.includes(path.sep) || (process.platform === "win32" && executable.includes("/"))
  );
}

function windowsPathExtensions(env: NodeJS.ProcessEnv | undefined): string[] {
  const pathext = env?.PATHEXT ?? defaultWindowsPathExt;
  return pathext
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
}

export function trimForMetadata(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}...` : trimmed;
}

function classifyCliStartError(executable: string, error: unknown): Error {
  if (isNodeErrorWithCode(error, "ENOENT")) {
    return missingRequirement(`CLI executable not found: ${executable}`);
  }

  if (isNodeErrorWithCode(error, "ENOEXEC")) {
    return missingRequirement(
      `CLI executable is not runnable: ${executable}${macosStartHint(executable)}`,
    );
  }

  if (isNodeErrorWithCode(error, "EPERM") || isNodeErrorWithCode(error, "EACCES")) {
    return missingRequirement(
      `CLI executable is not permitted to run: ${executable}${macosStartHint(executable)}`,
    );
  }

  return reviewerFailed(
    `${executable} failed to start: ${errorMessage(error)}${macosStartHint(executable)}`,
  );
}

function classifyCliExit(executable: string, code: number | null, detail: string): Error {
  if (/max_turns exceeded/i.test(detail)) {
    return reviewerFailed(`${executable} exited with code ${code}: ${detail}`);
  }

  if (isMissingAuthOutput(detail)) {
    return missingAuth(`${executable} authentication is missing or expired: ${detail}`);
  }

  return reviewerFailed(`${executable} exited with code ${code}: ${detail}`);
}

function isMissingAuthOutput(detail: string): boolean {
  return /\b(auth|authentication|login|logged in|api key|unauthorized|401|403)\b/i.test(detail);
}

async function assertExecutable(executable: string): Promise<void> {
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw missingRequirement(`CLI executable not found: ${executable}`);
  }
}

function bindAbortSignal(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (signal === undefined) {
    return () => {};
  }
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw reviewerFailed(message);
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function macosStartHint(executable: string): string {
  if (process.platform !== "darwin") {
    return "";
  }

  return `\nOn macOS this can be caused by Gatekeeper quarantine or an unsigned executable. Run: diffwarden macos doctor --path ${shellQuote(executable)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
