import { invalidCli } from "./errors.js";

export type ReviewEnvOptions = {
  reviewers?: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
  timeoutSeconds?: number;
};

export function resolveReviewerSelectionWithEnv(options: {
  reviewers: string[];
  reviewerSet: string | undefined;
  envOptions: ReviewEnvOptions;
}): { reviewers?: string[]; reviewerSet?: string } {
  const hasCliReviewerSelection = options.reviewers.length > 0 || options.reviewerSet !== undefined;
  if (hasCliReviewerSelection) {
    return {
      ...(options.reviewers.length > 0 ? { reviewers: options.reviewers } : {}),
      ...(options.reviewerSet !== undefined ? { reviewerSet: options.reviewerSet } : {}),
    };
  }

  return {
    ...(options.envOptions.reviewers !== undefined
      ? { reviewers: options.envOptions.reviewers }
      : {}),
    ...(options.envOptions.reviewerSet !== undefined
      ? { reviewerSet: options.envOptions.reviewerSet }
      : {}),
  };
}

export function resolveReviewEnvOptions(env: NodeJS.ProcessEnv): ReviewEnvOptions {
  return resolveReviewEnvOptionsWithSettings(env, { includeTimeout: true });
}

export function resolveReviewEnvOptionsWithSettings(
  env: NodeJS.ProcessEnv,
  settings: { includeTimeout: boolean },
): ReviewEnvOptions {
  const options: ReviewEnvOptions = {
    ...parseEnvReviewers(env.DIFFWARDEN_REVIEWERS),
  };
  const reviewerSet = stringEnvOption(env.DIFFWARDEN_REVIEWER_SET);
  if (reviewerSet !== undefined) {
    options.reviewerSet = reviewerSet;
  }
  const model = stringEnvOption(env.DIFFWARDEN_MODEL);
  if (model !== undefined) {
    options.model = model;
  }
  const effort = stringEnvOption(env.DIFFWARDEN_EFFORT);
  if (effort !== undefined) {
    options.effort = effort;
  }
  if (settings.includeTimeout) {
    const timeoutSeconds = parseTimeoutSeconds(
      "DIFFWARDEN_TIMEOUT_SECONDS",
      env.DIFFWARDEN_TIMEOUT_SECONDS,
    );
    if (timeoutSeconds !== undefined) {
      options.timeoutSeconds = timeoutSeconds;
    }
  }
  return options;
}

export function parseTimeoutSeconds(label: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw invalidCli(`Invalid ${label} value: ${value}`);
  }

  return parsed;
}

function parseEnvReviewers(value: string | undefined): Pick<ReviewEnvOptions, "reviewers"> {
  if (value === undefined || value.trim() === "") {
    return {};
  }

  const reviewers = value.split(",").map((reviewer) => reviewer.trim());
  if (reviewers.some((reviewer) => reviewer.length === 0)) {
    throw invalidCli("Invalid DIFFWARDEN_REVIEWERS value");
  }

  return {
    reviewers,
  };
}

function stringEnvOption(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value.trim();
}
