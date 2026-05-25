import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveExecutable } from "../adapters/cli-process.js";

const execFileAsync = promisify(execFile);

export type MacosDoctorStatus = "passed" | "warning" | "skipped" | "failed";

export type MacosDoctorCheck = {
  name: string;
  status: MacosDoctorStatus;
  detail?: string;
};

export type MacosExecutableDoctor = {
  input: string;
  path?: string;
  status: MacosDoctorStatus;
  checks: MacosDoctorCheck[];
};

export type MacosDoctorReport = {
  platform: NodeJS.Platform;
  executables: MacosExecutableDoctor[];
};

export async function runMacosDoctor(options: {
  paths?: string[];
  executables?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<MacosDoctorReport> {
  const inputs = [...(options.paths ?? []), ...(options.executables ?? [])];

  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      executables: inputs.map((input) => ({
        input,
        status: "skipped",
        checks: [
          {
            name: "platform",
            status: "skipped",
            detail: "macOS executable trust checks only run on darwin.",
          },
        ],
      })),
    };
  }

  return {
    platform: process.platform,
    executables: await Promise.all(
      inputs.map((input) => inspectExecutable(input, options.env ?? process.env)),
    ),
  };
}

async function inspectExecutable(
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<MacosExecutableDoctor> {
  try {
    const executable = await resolveExecutable(input, env);
    const checks = [
      await quarantineCheck(executable),
      await commandAssessment("codesign", executable, [
        "--verify",
        "--deep",
        "--strict",
        executable,
      ]),
      await commandAssessment("spctl", executable, ["--assess", "--type", "execute", executable]),
    ];

    return {
      input,
      path: executable,
      status: aggregateCheckStatus(checks),
      checks,
    };
  } catch (error) {
    return {
      input,
      status: "failed",
      checks: [
        {
          name: "resolve",
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

async function quarantineCheck(executable: string): Promise<MacosDoctorCheck> {
  try {
    const { stdout } = await execFileAsync("xattr", ["-p", "com.apple.quarantine", executable], {
      timeout: 5_000,
    });
    const detail = stdout.trim();
    return {
      name: "quarantine",
      status: "warning",
      detail: detail ? `com.apple.quarantine is set: ${detail}` : "com.apple.quarantine is set.",
    };
  } catch {
    return {
      name: "quarantine",
      status: "passed",
      detail: "com.apple.quarantine is not set.",
    };
  }
}

async function commandAssessment(
  name: "codesign" | "spctl",
  executable: string,
  args: string[],
): Promise<MacosDoctorCheck> {
  try {
    await execFileAsync(name, args, { timeout: 10_000 });
    return {
      name,
      status: "passed",
      detail: `${name} accepted ${executable}.`,
    };
  } catch (error) {
    return {
      name,
      status: "warning",
      detail: `${name} did not accept ${executable}: ${commandErrorDetail(error)}`,
    };
  }
}

function commandErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [stripCommandStderrFromMessage(error.message)];
  if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    parts.push(error.stderr.trim());
  }
  return parts.join(": ");
}

function aggregateCheckStatus(checks: MacosDoctorCheck[]): MacosDoctorStatus {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }
  if (checks.some((check) => check.status === "skipped")) {
    return "skipped";
  }
  return "passed";
}

function stripCommandStderrFromMessage(message: string): string {
  const firstLine = message.split("\n", 1)[0];
  return firstLine?.trim() || message.trim();
}
