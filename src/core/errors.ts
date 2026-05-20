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

export function invalidConfig(message: string): DiffwardenError {
  return new DiffwardenError("invalid_config", message, 2);
}

export function missingAuth(message: string): DiffwardenError {
  return new DiffwardenError("missing_auth", message, 3);
}

export function missingRequirement(message: string): DiffwardenError {
  return new DiffwardenError("missing_requirement", message, 3);
}

export function reviewerFailed(message: string): DiffwardenError {
  return new DiffwardenError("reviewer_failed", message, 3);
}

export function timeoutError(message: string): DiffwardenError {
  return new DiffwardenError("timeout", message, 3);
}
