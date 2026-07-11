import type { ReviewAdapterInput, ReviewAdapterOutput, ReviewReviewerConfig } from "./types.js";

export type CliEngine = Exclude<ReviewReviewerConfig["sdk"], "fake">;

export type CliInvocation = {
  executable: string;
  resolvedExecutable?: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  unsetEnv?: string[];
  stdin?: string;
  outputPath?: string;
  droidLogGroupId?: string | undefined;
  droidSessionDirectory?: string;
  claudeAuthMode?: "api-key" | "claude-code";
  /** Invocation-level metadata merged into the run output metadata. */
  metadata?: Record<string, string>;
  captureMode: NonNullable<ReviewAdapterOutput["metadata"]>["captureMode"];
};

export type CliRunResult = {
  executable: string;
  stdout: string;
  stderr: string;
};

export type CliSpec = {
  buildInvocation(input: ReviewAdapterInput, tempDir: string): Promise<CliInvocation>;
  parseOutput(result: CliRunResult, invocation: CliInvocation): Promise<ReviewAdapterOutput>;
};
