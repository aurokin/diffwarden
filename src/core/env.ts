import { invalidCli } from "./errors.js";

export type ReviewEnvOptions = {
  reviewers?: string[];
  reviewerSet?: string;
  model?: string;
  effort?: string;
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
  const options: ReviewEnvOptions = {
    ...parseEnvReviewers(env.DIFFWARDEN_REVIEWERS),
  };
  setStringEnvOption(options, "reviewerSet", env.DIFFWARDEN_REVIEWER_SET);
  setStringEnvOption(options, "model", env.DIFFWARDEN_MODEL);
  setStringEnvOption(options, "effort", env.DIFFWARDEN_EFFORT);
  return options;
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

function setStringEnvOption<Key extends keyof Omit<ReviewEnvOptions, "reviewers">>(
  options: ReviewEnvOptions,
  key: Key,
  value: string | undefined,
): void {
  if (value === undefined || value.trim() === "") {
    return;
  }

  options[key] = value.trim();
}
