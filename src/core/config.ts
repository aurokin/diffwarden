import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { invalidConfig } from "./errors.js";
import { reviewerSdkSchema } from "./schema.js";

const configFileName = "diffwarden.config.json";
const effortValues = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const effortSchema = z.enum(effortValues);

const reviewerConfigSchema = z
  .object({
    id: z.string().min(1),
    sdk: reviewerSdkSchema.exclude(["fake"]),
    profile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
    modelCatalog: z.array(z.string().min(1)).optional(),
    effortCatalog: z.array(effortSchema).optional(),
    timeoutSeconds: z.number().positive().optional(),
    readonly: z.literal(true).optional(),
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

function findDiffwardenConfigPath(options: LoadDiffwardenConfigOptions): string | undefined {
  const projectPath = findProjectConfigPath(options.cwd, options.repoRoot);
  if (projectPath !== undefined) {
    return projectPath;
  }

  const env = options.env ?? process.env;
  const userConfigPath = path.join(
    env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
    "diffwarden",
    configFileName,
  );
  if (existsSync(userConfigPath)) {
    return userConfigPath;
  }

  return undefined;
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
