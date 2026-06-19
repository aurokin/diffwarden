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

export const reviewFindingSchema = z
  .object({
    title: z.string().min(1),
    body: z.string(),
    confidence_score: z.number().min(0).max(1),
    priority: reviewPrioritySchema.optional(),
    code_location: z
      .object({
        absolute_file_path: z.string().min(1),
        line_range: z
          .object({
            start: z.number().int().positive(),
            end: z.number().int().positive(),
          })
          .strict()
          .refine((range) => range.start <= range.end, {
            message: "line_range.start must be less than or equal to line_range.end",
            path: ["end"],
          }),
      })
      .strict(),
  })
  .strict();

export const reviewArtifactFindingSchema = reviewFindingSchema.extend({
  reviewer_ids: z.array(z.string().min(1)).optional(),
});

export const reviewBatchArtifactFindingSchema = reviewArtifactFindingSchema.extend({
  lane_ids: z.array(z.string().min(1)).min(1),
});

export const reviewResultSchema = z
  .object({
    findings: z.array(reviewFindingSchema),
    overall_correctness: overallCorrectnessSchema,
    overall_explanation: z.string(),
    overall_confidence_score: z.number().min(0).max(1),
  })
  .strict();

export const reviewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "confidence_score", "code_location"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
          },
          body: {
            type: "string",
          },
          confidence_score: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          priority: {
            type: "integer",
            enum: [0, 1, 2, 3],
          },
          code_location: {
            type: "object",
            additionalProperties: false,
            required: ["absolute_file_path", "line_range"],
            properties: {
              absolute_file_path: {
                type: "string",
                minLength: 1,
              },
              line_range: {
                type: "object",
                additionalProperties: false,
                required: ["start", "end"],
                properties: {
                  start: {
                    type: "integer",
                    minimum: 1,
                  },
                  end: {
                    type: "integer",
                    minimum: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
    overall_correctness: {
      type: "string",
      enum: ["patch is correct", "patch is incorrect"],
    },
    overall_explanation: {
      type: "string",
    },
    overall_confidence_score: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
} as const;

export const reviewResultStrictJsonSchema = {
  ...reviewResultJsonSchema,
  properties: {
    ...reviewResultJsonSchema.properties,
    findings: {
      ...reviewResultJsonSchema.properties.findings,
      items: {
        ...reviewResultJsonSchema.properties.findings.items,
        required: ["title", "body", "confidence_score", "priority", "code_location"],
      },
    },
  },
} as const;

export const reviewArtifactResultSchema = reviewResultSchema.extend({
  findings: z.array(reviewArtifactFindingSchema),
  overall_correctness: artifactOverallCorrectnessSchema,
});

export const reviewBatchArtifactResultSchema = reviewArtifactResultSchema.extend({
  findings: z.array(reviewBatchArtifactFindingSchema),
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
  instructions: z.string().min(1).optional(),
  diff_command: z.string(),
  changed_files: z.array(z.string()),
});

export const reviewerSdkSchema = z.enum([
  "cursor",
  "claude",
  "pi",
  "droid",
  "copilot",
  "codex",
  "gemini",
  "opencode",
  "grok",
  "antigravity",
  "fake",
]);
export const adapterPreflightCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passed", "skipped", "warning"]),
  detail: z.string().optional(),
});
export const adapterPreflightResultSchema = z.object({
  checks: z.array(adapterPreflightCheckSchema),
  metadata: z
    .record(z.string(), z.unknown())
    .and(
      z.object({
        readonlyCapability: z.enum(["enforced", "tool-restricted", "prompt-only"]).optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
      }),
    )
    .optional(),
});

export const reviewerErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  exit_code: z.number().int().optional(),
});

const artifactTransportSchema = z.enum(["native", "cli", "app-server"]);

const reviewReviewerArtifactBaseSchema = z
  .object({
    id: z.string(),
    status: z.enum(["success", "failed"]).optional(),
    profile: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    result: reviewArtifactResultSchema.optional(),
    raw_text: z.string().optional(),
    preflight: adapterPreflightResultSchema.optional(),
    usage: z.unknown().optional(),
    adapter_metadata: z
      .record(z.string(), z.unknown())
      .and(
        z.object({
          captureMode: z.enum(["native-structured", "tool-call", "text"]).optional(),
          readonlyCapability: z.enum(["enforced", "tool-restricted", "prompt-only"]).optional(),
        }),
      )
      .optional(),
    validation: reviewValidationSchema.optional(),
    error: reviewerErrorSchema.optional(),
    timing_ms: z.number().nonnegative().optional(),
  })
  .strict();

const reviewReviewerArtifactV2Schema = reviewReviewerArtifactBaseSchema.extend({
  engine: reviewerSdkSchema,
  transport: artifactTransportSchema.optional(),
});

export const reviewReviewerArtifactSchema = reviewReviewerArtifactV2Schema.superRefine(
  (artifact, context) => {
    if (artifact.status === "failed") {
      if (artifact.error === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "failed reviewer artifacts must include error",
          path: ["error"],
        });
      }
      return;
    }

    if (artifact.result === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "successful reviewer artifacts must include result",
        path: ["result"],
      });
    }

    if (artifact.validation === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "successful reviewer artifacts must include validation",
        path: ["validation"],
      });
    }
  },
);

export const reviewArtifactSchema = z
  .object({
    schema_version: z.literal(2),
    engine: reviewerSdkSchema.optional(),
    reviewers: z.array(reviewReviewerArtifactSchema).optional(),
    cwd: z.string(),
    target: reviewTargetResolvedSchema,
    result: reviewArtifactResultSchema,
    raw_text: z.string().optional(),
    validation: reviewValidationSchema,
    warnings: z.array(z.string()).optional(),
    timing_ms: z.number().nonnegative().optional(),
  })
  .strict();

export const reviewLaneSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["overview", "focus"]),
    focus: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((lane, context) => {
    if (lane.kind === "focus" && lane.focus === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "focus lanes must include focus instructions",
        path: ["focus"],
      });
    }
    if (lane.kind === "overview" && lane.focus !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "overview lanes must not include focus instructions",
        path: ["focus"],
      });
    }
  });

export const reviewPlanSchema = z
  .object({
    include_overview: z.boolean(),
    focus: z.array(z.string().min(1)),
    lanes: z.array(reviewLaneSchema).min(1),
  })
  .strict();

const reviewBatchLaneArtifactBaseSchema = reviewLaneSchema.extend({
  timing_ms: z.number().nonnegative().optional(),
});

export const reviewBatchLaneArtifactSchema = z.union([
  reviewBatchLaneArtifactBaseSchema
    .extend({
      status: z.literal("success"),
      artifact: reviewArtifactSchema,
    })
    .strict(),
  reviewBatchLaneArtifactBaseSchema
    .extend({
      status: z.literal("failed"),
      error: reviewerErrorSchema,
    })
    .strict(),
]);

export const reviewBatchArtifactSchema = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal("batch"),
    cwd: z.string(),
    target: reviewTargetResolvedSchema,
    plan: reviewPlanSchema,
    result: reviewBatchArtifactResultSchema,
    validation: reviewValidationSchema,
    warnings: z.array(z.string()).optional(),
    timing_ms: z.number().nonnegative().optional(),
    lanes: z.array(reviewBatchLaneArtifactSchema).min(1),
  })
  .strict();

export const reviewRunArtifactSchema = z.union([reviewBatchArtifactSchema, reviewArtifactSchema]);

export type ReviewPriority = z.infer<typeof reviewPrioritySchema>;
export type OverallCorrectness = z.infer<typeof overallCorrectnessSchema>;
export type ArtifactOverallCorrectness = z.infer<typeof artifactOverallCorrectnessSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewArtifactFinding = z.infer<typeof reviewArtifactFindingSchema>;
export type ReviewBatchArtifactFinding = z.infer<typeof reviewBatchArtifactFindingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewArtifactResult = z.infer<typeof reviewArtifactResultSchema>;
export type ReviewBatchArtifactResult = z.infer<typeof reviewBatchArtifactResultSchema>;
export type ParseMode = z.infer<typeof parseModeSchema>;
export type ReviewValidation = z.infer<typeof reviewValidationSchema>;
export type ReviewTargetResolved = z.infer<typeof reviewTargetResolvedSchema>;
export type ReviewerSdk = z.infer<typeof reviewerSdkSchema>;
export type AdapterPreflightCheck = z.infer<typeof adapterPreflightCheckSchema>;
export type AdapterPreflightResult = z.infer<typeof adapterPreflightResultSchema>;
export type ReviewerError = z.infer<typeof reviewerErrorSchema>;
export type ReviewReviewerArtifact = z.infer<typeof reviewReviewerArtifactSchema>;
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;
export type ReviewLane = z.infer<typeof reviewLaneSchema>;
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
export type ReviewBatchLaneArtifact = z.infer<typeof reviewBatchLaneArtifactSchema>;
export type ReviewBatchArtifact = z.infer<typeof reviewBatchArtifactSchema>;
export type ReviewRunArtifact = z.infer<typeof reviewRunArtifactSchema>;

/**
 * Streaming review events emitted by `runReviewEvents()`.
 *
 * This is a versioned public contract (`schema_version: 2`). Once `run_started`
 * is emitted the stream always terminates with exactly one of `final_result`
 * or `error`. Per-reviewer `reviewer_result` events carry `provisional: true`:
 * their findings are pre-aggregation (not deduplicated or merged across
 * reviewers). Only `final_result.artifact` is authoritative.
 */
export type ReviewEvent =
  | ReviewBatchStartedEvent
  | ReviewRunStartedEvent
  | ReviewPreflightStartedEvent
  | ReviewPreflightFinishedEvent
  | ReviewReviewerStartedEvent
  | ReviewReviewerResultEvent
  | ReviewReviewerFailedEvent
  | ReviewLaneFinishedEvent
  | ReviewLaneFailedEvent
  | ReviewFinalResultEvent
  | ReviewErrorEvent;

type ReviewEventEnvelope = { schema_version: 2 };

export type ReviewRunStartedEvent = ReviewEventEnvelope & {
  type: "run_started";
  lane_id?: string;
  cwd: string;
  target: ReviewTargetResolved;
  reviewers: Array<{ id: string; engine: ReviewerSdk }>;
};

export type ReviewPreflightStartedEvent = ReviewEventEnvelope & {
  type: "preflight_started";
  lane_id?: string;
  reviewer_id: string;
};

export type ReviewPreflightFinishedEvent = ReviewEventEnvelope & {
  type: "preflight_finished";
  lane_id?: string;
  reviewer_id: string;
  ok: boolean;
  timing_ms: number;
};

export type ReviewReviewerStartedEvent = ReviewEventEnvelope & {
  type: "reviewer_started";
  lane_id?: string;
  reviewer_id: string;
};

export type ReviewReviewerResultEvent = ReviewEventEnvelope & {
  type: "reviewer_result";
  lane_id?: string;
  reviewer_id: string;
  /** Always true: these findings are pre-aggregation; see `final_result`. */
  provisional: true;
  artifact: ReviewReviewerArtifact;
};

export type ReviewReviewerFailedEvent = ReviewEventEnvelope & {
  type: "reviewer_failed";
  lane_id?: string;
  reviewer_id: string;
  error: ReviewerError;
  timing_ms: number;
};

export type ReviewBatchStartedEvent = ReviewEventEnvelope & {
  type: "batch_started";
  cwd: string;
  target: ReviewTargetResolved;
  reviewers: Array<{ id: string; engine: ReviewerSdk }>;
  plan: ReviewPlan;
};

export type ReviewLaneFinishedEvent = ReviewEventEnvelope & {
  type: "lane_finished";
  lane_id: string;
  artifact: ReviewArtifact;
  timing_ms: number;
};

export type ReviewLaneFailedEvent = ReviewEventEnvelope & {
  type: "lane_failed";
  lane_id: string;
  error: ReviewerError;
  timing_ms: number;
};

export type ReviewFinalResultEvent = ReviewEventEnvelope & {
  type: "final_result";
  /** Authoritative, aggregated, validated result. */
  artifact: ReviewRunArtifact;
};

export type ReviewErrorEvent = ReviewEventEnvelope & {
  type: "error";
  error: ReviewerError;
};

export function createFallbackReviewResult(text: string): ReviewArtifactResult {
  return {
    findings: [],
    overall_correctness: "unknown",
    overall_explanation: text,
    overall_confidence_score: 0,
  };
}
