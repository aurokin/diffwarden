import { invalidCli } from "./errors.js";

export type ReviewTargetSpec =
  | {
      kind: "uncommitted";
      raw: "uncommitted";
    }
  | {
      kind: "base";
      raw: string;
      branch: string;
    }
  | {
      kind: "commit";
      raw: string;
      sha: string;
    }
  | {
      kind: "custom";
      raw: string;
      instructions: string;
    };

export function parseTargetSpec(target: string): ReviewTargetSpec {
  if (target === "uncommitted") {
    return {
      kind: "uncommitted",
      raw: target,
    };
  }

  const basePrefix = "base:";
  if (target.startsWith(basePrefix)) {
    const branch = target.slice(basePrefix.length).trim();
    if (branch.length === 0) {
      throw invalidCli("Invalid target: base target requires a branch, for example base:main");
    }

    return {
      kind: "base",
      raw: target,
      branch,
    };
  }

  const commitPrefix = "commit:";
  if (target.startsWith(commitPrefix)) {
    const sha = target.slice(commitPrefix.length).trim();
    if (sha.length === 0) {
      throw invalidCli("Invalid target: commit target requires a SHA, for example commit:abc123");
    }

    return {
      kind: "commit",
      raw: target,
      sha,
    };
  }

  const customPrefix = "custom:";
  if (target.startsWith(customPrefix)) {
    const instructions = target.slice(customPrefix.length).trim();
    if (instructions.length === 0) {
      throw invalidCli(
        "Invalid target: custom target requires instructions, for example custom:Review the auth flow",
      );
    }

    return {
      kind: "custom",
      raw: target,
      instructions,
    };
  }

  throw invalidCli(`Invalid target: ${target}`);
}
