import { missingRequirement } from "../core/errors.js";
import { execCliFile } from "./cli-process.js";

export const droidCliReviewAllowedTools = [
  "read-cli",
  "glob-search-cli",
  "grep_tool_cli",
  "ls-cli",
  "exit-spec-mode",
] as const;
export const droidSdkReviewAllowedTools = ["Read", "Glob", "Grep", "LS", "ExitSpecMode"] as const;

export const droidCliReviewPolicyCliFlags = [
  "--cwd",
  "--output-format",
  "--use-spec",
  "--file",
  "--spec-model",
  "--spec-reasoning-effort",
  "--tag",
  "--enabled-tools",
  "--list-tools",
  "--log-group-id",
] as const;

const droidCliRequiredReviewPolicyCliFlags = [
  "--cwd",
  "--output-format",
  "--use-spec",
  "--file",
  "--tag",
  "--enabled-tools",
  "--list-tools",
] as const;

export type DroidCliReviewPolicySupport = {
  logGroupId: boolean;
};

export type DroidCliReviewPolicyOptions = {
  cwd?: string;
  model?: string;
  effort?: string;
  requiredFlags?: readonly string[];
};

export function droidCliReviewAllowedToolsArg(): string {
  return droidCliReviewAllowedTools.join(",");
}

export function droidSdkReviewAllowedToolList(): string[] {
  return [...droidSdkReviewAllowedTools];
}

export function droidCliReviewPolicyMetadata(): Record<string, unknown> {
  return {
    droidInteractionMode: "spec",
    droidAutonomyLevel: "default-readonly",
    droidToolPolicy: "allowlist",
    droidAllowedTools: [...droidCliReviewAllowedTools],
    droidMissionMode: "disabled",
  };
}

export function droidSdkReviewPolicyMetadata(): Record<string, unknown> {
  return {
    droidInteractionMode: "spec",
    droidAutonomyLevel: "off",
    droidToolPolicy: "allowlist",
    droidAllowedTools: [...droidSdkReviewAllowedTools],
  };
}

export async function assertDroidExecutableSupportsReviewPolicy(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  options: DroidCliReviewPolicyOptions = {},
): Promise<DroidCliReviewPolicySupport> {
  const requiredFlags = options.requiredFlags ?? droidCliReviewPolicyCliFlags;
  let output: string;
  try {
    const { stdout, stderr } = await execCliFile(executable, ["exec", "--help"], {
      ...(env !== undefined ? { env } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    output = `${stdout}${stderr}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Droid executable policy preflight failed: ${detail}`);
  }

  const missingFlags = requiredDroidCliReviewPolicyFlags(options, requiredFlags).filter(
    (flag) => !helpOutputHasFlag(output, flag),
  );
  if (missingFlags.length) {
    throw missingRequirement(
      `Droid executable does not support Diffwarden review policy flags: ${missingFlags.join(", ")}. Upgrade Droid CLI or configure a newer executable.`,
    );
  }

  assertDroidModelAndEffortSupported(output, options);
  await assertDroidToolAllowlist(executable, env, options);

  return {
    logGroupId: helpOutputHasFlag(output, "--log-group-id"),
  };
}

async function assertDroidToolAllowlist(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  options: DroidCliReviewPolicyOptions,
): Promise<void> {
  const args = [
    "exec",
    "--list-tools",
    ...(options.cwd !== undefined ? ["--cwd", options.cwd] : []),
    "--output-format",
    "json",
    "--use-spec",
    "--enabled-tools",
    droidCliReviewAllowedToolsArg(),
  ];
  if (options.model !== undefined) {
    args.push("--spec-model", options.model);
  }
  if (options.effort !== undefined) {
    args.push("--spec-reasoning-effort", options.effort);
  }

  let stdout: string;
  try {
    ({ stdout } = await execCliFile(executable, args, {
      ...(env !== undefined ? { env } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Droid executable tool allowlist preflight failed: ${detail}`);
  }

  const actualTools = droidAllowedToolIdsFromListToolsJson(stdout);
  const expectedTools = new Set<string>(droidCliReviewAllowedTools);
  const missingTools = [...expectedTools].filter((tool) => !actualTools.has(tool));
  const unexpectedTools = [...actualTools].filter((tool) => !expectedTools.has(tool));
  if (missingTools.length || unexpectedTools.length) {
    throw missingRequirement(
      `Droid executable does not enforce Diffwarden review tool allowlist. Missing: ${formatList(missingTools)}. Unexpected: ${formatList(unexpectedTools)}.`,
    );
  }
}

function droidAllowedToolIdsFromListToolsJson(stdout: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw missingRequirement(`Droid executable returned invalid tool list JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw missingRequirement("Droid executable returned an invalid tool list payload.");
  }

  const tools = new Set<string>();
  for (const tool of parsed) {
    if (
      typeof tool === "object" &&
      tool !== null &&
      "currentlyAllowed" in tool &&
      tool.currentlyAllowed === true &&
      "id" in tool &&
      typeof tool.id === "string"
    ) {
      tools.add(tool.id);
    }
  }
  return tools;
}

function assertDroidModelAndEffortSupported(
  helpOutput: string,
  options: DroidCliReviewPolicyOptions,
): void {
  const models = parseDroidCliModels(helpOutput);
  const modelId = droidCliModelIdForHelpLookup(options.model, models);
  if (
    options.model !== undefined &&
    models.size > 0 &&
    !options.model.startsWith("custom:") &&
    modelId === undefined
  ) {
    throw missingRequirement(`Droid executable does not list requested model: ${options.model}.`);
  }
  const effortModelId = modelId ?? models.defaultModelId;
  if (options.effort === undefined || effortModelId === undefined) {
    return;
  }

  const model = models.get(effortModelId);
  if (model === undefined || model.supportedEfforts.size === 0) {
    return;
  }
  if (!model.supportedEfforts.has(options.effort)) {
    throw missingRequirement(
      `Droid executable model ${effortModelId} does not support reasoning effort ${options.effort}. Supported efforts: ${[...model.supportedEfforts].join(", ")}.`,
    );
  }
}

function requiredDroidCliReviewPolicyFlags(
  options: DroidCliReviewPolicyOptions,
  requiredFlags: readonly string[],
): string[] {
  if (options.requiredFlags !== undefined) {
    return [...requiredFlags];
  }

  return [
    ...droidCliRequiredReviewPolicyCliFlags,
    ...(options.model !== undefined ? ["--spec-model"] : []),
    ...(options.effort !== undefined ? ["--spec-reasoning-effort"] : []),
  ];
}

function helpOutputHasFlag(output: string, flag: string): boolean {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escapedFlag}(?=$|[^\\w-])`).test(output);
}

type DroidCliModelInfo = {
  displayName: string;
  supportedEfforts: Set<string>;
};

type DroidCliModelRegistry = Map<string, DroidCliModelInfo> & {
  defaultModelId?: string;
};

function parseDroidCliModels(output: string): DroidCliModelRegistry {
  const models = new Map<string, DroidCliModelInfo>() as DroidCliModelRegistry;
  let section: "available" | "details" | undefined;
  const displayToModelIds = new Map<string, string[]>();

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "Available Models:") {
      section = "available";
      continue;
    }
    if (line.trim() === "Model details:") {
      section = "details";
      continue;
    }
    if (section === "available") {
      const match = line.match(/^\s{2}(\S+)\s{2,}(.+?)\s*$/);
      if (match === null) {
        continue;
      }
      const modelId = match[1];
      const rawDisplayName = match[2];
      if (modelId === undefined || rawDisplayName === undefined) {
        continue;
      }
      const displayName = normalizeDroidModelDisplayName(rawDisplayName);
      models.set(modelId, { displayName, supportedEfforts: new Set() });
      const modelIds = displayToModelIds.get(displayName) ?? [];
      modelIds.push(modelId);
      displayToModelIds.set(displayName, modelIds);
      if (/\(default\)/.test(rawDisplayName)) {
        models.defaultModelId = modelId;
      }
      continue;
    }
    if (section === "details") {
      const match = line.match(
        /^\s*-\s+(.+?): supports reasoning: \S+; supported: \[([^\]]*)\]; default: \S+/,
      );
      if (match === null) {
        continue;
      }
      const rawDisplayName = match[1];
      const rawSupportedEfforts = match[2];
      if (rawDisplayName === undefined || rawSupportedEfforts === undefined) {
        continue;
      }
      const displayName = normalizeDroidModelDisplayName(rawDisplayName);
      const supportedEfforts = new Set(
        rawSupportedEfforts
          .split(",")
          .map((effort) => effort.trim())
          .filter((effort) => effort.length > 0),
      );
      for (const modelId of displayToModelIds.get(displayName) ?? []) {
        const model = models.get(modelId);
        if (model !== undefined) {
          model.supportedEfforts = supportedEfforts;
        }
      }
    }
  }

  return models;
}

function droidCliModelIdForHelpLookup(
  model: string | undefined,
  models: DroidCliModelRegistry,
): string | undefined {
  if (model === undefined || model.startsWith("custom:")) {
    return model;
  }
  if (models.has(model)) {
    return model;
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    return undefined;
  }

  const bareModel = model.slice(slashIndex + 1);
  return models.has(bareModel) ? bareModel : undefined;
}

function normalizeDroidModelDisplayName(value: string): string {
  return value.replace(/\s+\(default\)$/, "").trim();
}

function formatList(values: readonly string[]): string {
  return values.length ? values.join(", ") : "none";
}
