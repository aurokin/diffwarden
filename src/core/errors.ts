export type ReviewErrorCode =
  | "invalid_cli"
  | "invalid_config"
  | "invalid_model"
  | "invalid_effort"
  | "missing_requirement"
  | "missing_auth"
  | "reviewer_failed"
  | "reviewer_environment_failed"
  | "timeout"
  | "parse_failed"
  | "validation_failed";

export type ReviewErrorMetadata = {
  reason?: string;
  recovery?: readonly string[];
};

export class DiffwardenError extends Error {
  readonly code: ReviewErrorCode;
  readonly exitCode: number;
  readonly reason?: string;
  readonly recovery?: readonly string[];

  constructor(
    code: ReviewErrorCode,
    message: string,
    exitCode: number,
    metadata: ReviewErrorMetadata = {},
  ) {
    super(message);
    this.name = "DiffwardenError";
    this.code = code;
    this.exitCode = exitCode;
    if (metadata.reason !== undefined) {
      this.reason = metadata.reason;
    }
    if (metadata.recovery !== undefined) {
      this.recovery = metadata.recovery;
    }
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

export function reviewerEnvironmentFailed(
  message: string,
  metadata: ReviewErrorMetadata = {},
): DiffwardenError {
  return new DiffwardenError("reviewer_environment_failed", message, 3, metadata);
}

export function timeoutError(message: string): DiffwardenError {
  return new DiffwardenError("timeout", message, 3);
}

export function parseFailed(message: string): DiffwardenError {
  return new DiffwardenError("parse_failed", message, 4);
}

export function validationFailed(message: string): DiffwardenError {
  return new DiffwardenError("validation_failed", message, 4);
}
