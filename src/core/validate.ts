import path from "node:path";
import type { ReviewArtifactResult, ReviewTargetResolved, ReviewValidation } from "./schema.js";

export type ValidateReviewResultInput = {
  result: ReviewArtifactResult;
  target: ReviewTargetResolved;
  validation: ReviewValidation;
};

export function validateReviewResult(input: ValidateReviewResultInput): ReviewValidation {
  const invalidLocations = input.result.findings.flatMap((finding, index) => {
    const filePath = normalizeFindingPath(finding.code_location.absolute_file_path, input.target);

    if (input.target.changed_files.includes(filePath)) {
      return [];
    }

    return [
      {
        index,
        reason: `Finding path is not in changed files: ${finding.code_location.absolute_file_path}`,
      },
    ];
  });

  return {
    ...input.validation,
    valid_locations: invalidLocations.length === 0,
    findings_overlap_diff: false,
    invalid_locations: invalidLocations,
  };
}

function normalizeFindingPath(filePath: string, target: ReviewTargetResolved): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(target.repo_root, filePath);
  }

  return filePath;
}
