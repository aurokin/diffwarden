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
const legacyArtifactTransportSchema = z.enum(["sdk", "cli"]);

const reviewReviewerArtifactBaseSchema = z.object({
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
});

const reviewReviewerArtifactV2Schema = reviewReviewerArtifactBaseSchema.extend({
  engine: reviewerSdkSchema,
  transport: artifactTransportSchema.optional(),
});

const reviewReviewerArtifactV1Schema = reviewReviewerArtifactBaseSchema.extend({
  sdk: reviewerSdkSchema,
  transport: legacyArtifactTransportSchema.optional(),
});

export const reviewReviewerArtifactSchema = z
  .union([reviewReviewerArtifactV2Schema, reviewReviewerArtifactV1Schema])
  .transform((artifact) => {
    if ("engine" in artifact) {
      return artifact;
    }

    const { sdk, transport, ...rest } = artifact;
    return {
      ...rest,
      engine: sdk,
      ...(transport !== undefined ? { transport: artifactTransport(transport) } : {}),
    };
  })
  .superRefine((artifact, context) => {
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
  });

const reviewArtifactV2Schema = z.object({
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
});

const reviewArtifactV1Schema = z.object({
  schema_version: z.literal(1),
  sdk: reviewerSdkSchema.optional(),
  reviewers: z.array(reviewReviewerArtifactSchema).optional(),
  cwd: z.string(),
  target: reviewTargetResolvedSchema,
  result: reviewArtifactResultSchema,
  raw_text: z.string().optional(),
  validation: reviewValidationSchema,
  warnings: z.array(z.string()).optional(),
  timing_ms: z.number().nonnegative().optional(),
});

export const reviewArtifactSchema = z
  .union([reviewArtifactV2Schema, reviewArtifactV1Schema])
  .transform((artifact) => {
    if ("engine" in artifact || artifact.schema_version === 2) {
      return artifact;
    }

    const { sdk, ...rest } = artifact;
    return {
      ...rest,
      schema_version: 2 as const,
      ...(sdk !== undefined ? { engine: sdk } : {}),
    };
  });

function artifactTransport(
  transport: z.infer<typeof legacyArtifactTransportSchema>,
): "native" | "cli" | "app-server" {
  return transport === "sdk" ? "native" : transport;
}

export type ReviewPriority = z.infer<typeof reviewPrioritySchema>;
export type OverallCorrectness = z.infer<typeof overallCorrectnessSchema>;
export type ArtifactOverallCorrectness = z.infer<typeof artifactOverallCorrectnessSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewArtifactFinding = z.infer<typeof reviewArtifactFindingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewArtifactResult = z.infer<typeof reviewArtifactResultSchema>;
export type ParseMode = z.infer<typeof parseModeSchema>;
export type ReviewValidation = z.infer<typeof reviewValidationSchema>;
export type ReviewTargetResolved = z.infer<typeof reviewTargetResolvedSchema>;
export type ReviewerSdk = z.infer<typeof reviewerSdkSchema>;
export type AdapterPreflightCheck = z.infer<typeof adapterPreflightCheckSchema>;
export type AdapterPreflightResult = z.infer<typeof adapterPreflightResultSchema>;
export type ReviewerError = z.infer<typeof reviewerErrorSchema>;
export type ReviewReviewerArtifact = z.infer<typeof reviewReviewerArtifactSchema>;
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;

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
  | ReviewRunStartedEvent
  | ReviewPreflightStartedEvent
  | ReviewPreflightFinishedEvent
  | ReviewReviewerStartedEvent
  | ReviewReviewerResultEvent
  | ReviewReviewerFailedEvent
  | ReviewFinalResultEvent
  | ReviewErrorEvent;

type ReviewEventEnvelope = { schema_version: 2 };

export type ReviewRunStartedEvent = ReviewEventEnvelope & {
  type: "run_started";
  cwd: string;
  target: ReviewTargetResolved;
  reviewers: Array<{ id: string; engine: ReviewerSdk }>;
};

export type ReviewPreflightStartedEvent = ReviewEventEnvelope & {
  type: "preflight_started";
  reviewer_id: string;
};

export type ReviewPreflightFinishedEvent = ReviewEventEnvelope & {
  type: "preflight_finished";
  reviewer_id: string;
  ok: boolean;
  timing_ms: number;
};

export type ReviewReviewerStartedEvent = ReviewEventEnvelope & {
  type: "reviewer_started";
  reviewer_id: string;
};

export type ReviewReviewerResultEvent = ReviewEventEnvelope & {
  type: "reviewer_result";
  reviewer_id: string;
  /** Always true: these findings are pre-aggregation; see `final_result`. */
  provisional: true;
  artifact: ReviewReviewerArtifact;
};

export type ReviewReviewerFailedEvent = ReviewEventEnvelope & {
  type: "reviewer_failed";
  reviewer_id: string;
  error: ReviewerError;
  timing_ms: number;
};

export type ReviewFinalResultEvent = ReviewEventEnvelope & {
  type: "final_result";
  /** Authoritative, aggregated, validated result. */
  artifact: ReviewArtifact;
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
