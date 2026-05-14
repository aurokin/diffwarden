import { z } from "zod";

export const reviewPrioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const overallCorrectnessSchema = z.enum(["patch is correct", "patch is incorrect"]);
export const artifactOverallCorrectnessSchema = z.union([
  overallCorrectnessSchema,
  z.literal("unknown"),
]);

export const reviewFindingSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  confidence_score: z.number().min(0).max(1),
  priority: reviewPrioritySchema.optional(),
  code_location: z.object({
    absolute_file_path: z.string().min(1),
    line_range: z
      .object({
        start: z.number().int().positive(),
        end: z.number().int().positive(),
      })
      .refine((range) => range.start <= range.end, {
        message: "line_range.start must be less than or equal to line_range.end",
        path: ["end"],
      }),
  }),
});

export const reviewResultSchema = z.object({
  findings: z.array(reviewFindingSchema),
  overall_correctness: overallCorrectnessSchema,
  overall_explanation: z.string(),
  overall_confidence_score: z.number().min(0).max(1),
});

export const reviewArtifactResultSchema = reviewResultSchema.extend({
  overall_correctness: artifactOverallCorrectnessSchema,
});

export const parseModeSchema = z.enum([
  "strict-json",
  "extracted-json",
  "tool-output",
  "fallback-text",
]);

export const reviewValidationSchema = z.object({
  parse_mode: parseModeSchema,
  valid_schema: z.boolean(),
  findings_overlap_diff: z.boolean(),
  valid_locations: z.boolean(),
  invalid_locations: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      reason: z.string(),
    }),
  ),
});

export const reviewTargetResolvedSchema = z.object({
  kind: z.enum(["uncommitted", "base", "commit", "pr", "custom"]),
  repo_root: z.string(),
  base_ref: z.string().optional(),
  base_sha: z.string().optional(),
  head_sha: z.string().optional(),
  commit_sha: z.string().optional(),
  pr: z
    .object({
      number: z.number().int().positive().optional(),
      url: z.string().optional(),
    })
    .optional(),
  diff_command: z.string(),
  changed_files: z.array(z.string()),
});

export const reviewerSdkSchema = z.enum(["cursor", "claude", "pi", "fake"]);

export const reviewReviewerArtifactSchema = z.object({
  id: z.string(),
  sdk: reviewerSdkSchema,
  profile: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  result: reviewArtifactResultSchema,
  raw_text: z.string().optional(),
  validation: reviewValidationSchema,
  timing_ms: z.number().nonnegative().optional(),
});

export const reviewArtifactSchema = z.object({
  schema_version: z.literal(1),
  sdk: reviewerSdkSchema.optional(),
  reviewers: z.array(reviewReviewerArtifactSchema).optional(),
  cwd: z.string(),
  target: reviewTargetResolvedSchema,
  result: reviewArtifactResultSchema,
  raw_text: z.string().optional(),
  validation: reviewValidationSchema,
  timing_ms: z.number().nonnegative().optional(),
});

export type ReviewPriority = z.infer<typeof reviewPrioritySchema>;
export type OverallCorrectness = z.infer<typeof overallCorrectnessSchema>;
export type ArtifactOverallCorrectness = z.infer<typeof artifactOverallCorrectnessSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewArtifactResult = z.infer<typeof reviewArtifactResultSchema>;
export type ParseMode = z.infer<typeof parseModeSchema>;
export type ReviewValidation = z.infer<typeof reviewValidationSchema>;
export type ReviewTargetResolved = z.infer<typeof reviewTargetResolvedSchema>;
export type ReviewerSdk = z.infer<typeof reviewerSdkSchema>;
export type ReviewReviewerArtifact = z.infer<typeof reviewReviewerArtifactSchema>;
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;

export function createFallbackReviewResult(text: string): ReviewArtifactResult {
  return {
    findings: [],
    overall_correctness: "unknown",
    overall_explanation: text,
    overall_confidence_score: 0,
  };
}
