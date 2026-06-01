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
  droidSessionDirectory?: string;
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
