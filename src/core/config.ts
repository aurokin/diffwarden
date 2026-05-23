import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { invalidConfig } from "./errors.js";
import { reviewerSdkSchema } from "./schema.js";

const configFileName = "diffwarden.config.json";
const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const effortSchema = z.enum(effortValues);
const transportSchema = z.enum(["sdk", "cli"]);

const reviewerConfigSchema = z
  .object({
    id: z.string().min(1),
    sdk: reviewerSdkSchema.exclude(["fake"]),
    transport: transportSchema.optional(),
    profile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
    modelCatalog: z.array(z.string().min(1)).optional(),
    effortCatalog: z.array(effortSchema).optional(),
    timeoutSeconds: z.number().positive().optional(),
    readonly: z.literal(true).optional(),
    cliOptions: z.record(z.string(), z.unknown()).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    sdkOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const diffwardenConfigSchema = z
  .object({
    defaultReviewerSet: z.string().min(1).optional(),
    reviewerSets: z.record(z.string(), z.array(z.string().min(1))).optional(),
    reviewers: z.array(reviewerConfigSchema).optional(),
    readonly: z.literal(true).optional(),
    timeoutSeconds: z.number().positive().optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    const profileKeys = new Set<string>();
    for (const [index, reviewer] of (config.reviewers ?? []).entries()) {
      if (ids.has(reviewer.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate reviewer id: ${reviewer.id}`,
          path: ["reviewers", index, "id"],
        });
      }
      ids.add(reviewer.id);

      if (reviewer.transport === "sdk" && isCliOnlyReviewerSdk(reviewer.sdk)) {
        ctx.addIssue({
          code: "custom",
          message: `Reviewer ${reviewer.id} must use CLI transport for sdk: ${reviewer.sdk}`,
          path: ["reviewers", index, "transport"],
        });
      }

      if (reviewer.profile !== undefined) {
        const profileKey = `${reviewer.sdk}:${reviewer.profile}`;
        if (profileKeys.has(profileKey)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate reviewer profile: ${profileKey}`,
            path: ["reviewers", index, "profile"],
          });
        }
        profileKeys.add(profileKey);
      }
    }
  });

export type DiffwardenConfig = z.infer<typeof diffwardenConfigSchema>;

export type LoadedDiffwardenConfig = {
  path: string;
  config: DiffwardenConfig;
};

export type LoadDiffwardenConfigOptions = {
  cwd: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type InitDiffwardenConfigOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export async function loadDiffwardenConfig(
  options: LoadDiffwardenConfigOptions,
): Promise<LoadedDiffwardenConfig | undefined> {
  const configPath = findDiffwardenConfigPath(options);
  if (configPath === undefined) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw invalidConfig(`Unable to read config at ${configPath}: ${errorMessage(error)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw invalidConfig(`Invalid JSON in config at ${configPath}: ${errorMessage(error)}`);
  }

  const parsed = diffwardenConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw invalidConfig(`Invalid config at ${configPath}: ${z.prettifyError(parsed.error)}`);
  }

  return {
    path: configPath,
    config: parsed.data,
  };
}

export async function initDiffwardenConfig(
  options: InitDiffwardenConfigOptions = {},
): Promise<string> {
  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);

  await mkdir(path.dirname(configPath), { recursive: true });
  try {
    await writeFile(configPath, starterConfigJson(), { flag: "wx" });
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw invalidConfig(`Config already exists: ${configPath}`);
    }
    throw invalidConfig(`Unable to create config at ${configPath}: ${errorMessage(error)}`);
  }
  return configPath;
}

function findDiffwardenConfigPath(options: LoadDiffwardenConfigOptions): string | undefined {
  const projectPath = findProjectConfigPath(options.cwd, options.repoRoot);
  if (projectPath !== undefined) {
    return projectPath;
  }

  const configPath = userConfigPath(options.env ?? process.env, options.homeDir);
  if (existsSync(configPath)) {
    return configPath;
  }

  return undefined;
}

function userConfigPath(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  return path.join(
    env.XDG_CONFIG_HOME?.trim()
      ? env.XDG_CONFIG_HOME
      : path.join(env.HOME?.trim() ? env.HOME : homeDir, ".config"),
    "diffwarden",
    configFileName,
  );
}

function starterConfigJson(): string {
  return `${JSON.stringify(
    {
      defaultReviewerSet: "1",
      reviewerSets: {
        "1": ["pi-default"],
      },
      reviewers: [
        {
          id: "pi-default",
          sdk: "pi",
        },
      ],
      readonly: true,
      timeoutSeconds: 300,
    },
    null,
    2,
  )}\n`;
}

function findProjectConfigPath(cwd: string, repoRoot: string | undefined): string | undefined {
  let current = path.resolve(cwd);
  const stopAt = repoRoot === undefined ? path.parse(current).root : path.resolve(repoRoot);

  while (true) {
    const candidate = path.join(current, configFileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (current === stopAt) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function isCliOnlyReviewerSdk(sdk: string): boolean {
  return (
    sdk === "codex" ||
    sdk === "gemini" ||
    sdk === "opencode" ||
    sdk === "grok" ||
    sdk === "antigravity"
  );
}
