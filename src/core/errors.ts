export type ReviewErrorCode =
  | "invalid_cli"
  | "invalid_config"
  | "invalid_model"
  | "invalid_effort"
  | "missing_requirement"
  | "missing_auth"
  | "reviewer_failed"
  | "timeout"
  | "parse_failed"
  | "validation_failed";

export class DiffwardenError extends Error {
  readonly code: ReviewErrorCode;
  readonly exitCode: number;

  constructor(code: ReviewErrorCode, message: string, exitCode: number) {
    super(message);
    this.name = "DiffwardenError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function invalidCli(message: string): DiffwardenError {
  return new DiffwardenError("invalid_cli", message, 2);
}
