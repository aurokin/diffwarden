import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ChangedLineRanges, LineRange } from "./diff.js";
import type { ReviewArtifactResult, ReviewTargetResolved, ReviewValidation } from "./schema.js";

export type ValidateReviewResultInput = {
  result: ReviewArtifactResult;
  target: ReviewTargetResolved;
  validation: ReviewValidation;
  changedLineRanges?: ChangedLineRanges;
};

export function validateReviewResult(input: ValidateReviewResultInput): ReviewValidation {
  if (input.target.kind === "custom") {
    const invalidLocations = validateCustomFindingLocations(input.result, input.target);

    return {
      ...input.validation,
      valid_locations: invalidLocations.length === 0,
      findings_overlap_diff: true,
      invalid_locations: invalidLocations,
    };
  }

  const invalidLocations = input.result.findings.flatMap((finding, index) => {
    const filePath = normalizeFindingPath(finding.code_location.absolute_file_path, input.target);

    if (input.target.changed_files.includes(filePath)) {
      const changedRanges = input.changedLineRanges?.[filePath];
      if (changedRanges === undefined) {
        return [];
      }

      if (lineRangesOverlap(finding.code_location.line_range, changedRanges)) {
        return [];
      }

      return [
        {
          index,
          reason: `Finding line range does not overlap changed lines: ${finding.code_location.absolute_file_path}`,
        },
      ];
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
    findings_overlap_diff: invalidLocations.length === 0,
    invalid_locations: invalidLocations,
  };
}

function validateCustomFindingLocations(
  result: ReviewArtifactResult,
  target: ReviewTargetResolved,
): ReviewValidation["invalid_locations"] {
  return result.findings.flatMap((finding, index) => {
    const repoRoot = realpathSync(target.repo_root);
    const resolvedPath = resolveFindingPath(finding.code_location.absolute_file_path, repoRoot);

    try {
      const realFindingPath = realpathSync(resolvedPath);
      if (!isPathInside(realFindingPath, repoRoot)) {
        return [
          {
            index,
            reason: `Finding path is outside the repository: ${finding.code_location.absolute_file_path}`,
          },
        ];
      }

      if (!statSync(realFindingPath).isFile()) {
        return [
          {
            index,
            reason: `Finding path is not a file in the repository: ${finding.code_location.absolute_file_path}`,
          },
        ];
      }
    } catch {
      if (!isPathInside(resolvedPath, repoRoot)) {
        return [
          {
            index,
            reason: `Finding path is outside the repository: ${finding.code_location.absolute_file_path}`,
          },
        ];
      }

      return [
        {
          index,
          reason: `Finding path does not exist: ${finding.code_location.absolute_file_path}`,
        },
      ];
    }

    return [];
  });
}

function normalizeFindingPath(filePath: string, target: ReviewTargetResolved): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(target.repo_root, filePath);
  }

  return filePath;
}

function resolveFindingPath(filePath: string, repoRoot: string): string {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }

  return path.resolve(repoRoot, filePath);
}

function isPathInside(candidate: string, parent: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function lineRangesOverlap(findingRange: LineRange, changedRanges: LineRange[]): boolean {
  return changedRanges.some(
    (changedRange) =>
      findingRange.start <= changedRange.end && findingRange.end >= changedRange.start,
  );
}
