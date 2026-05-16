import type { ReviewAdapter, ReviewAdapterInput, ReviewAdapterOutput } from "./types.js";

export const fakeAdapter: ReviewAdapter = {
  name: "fake",
  async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
    return {
      structured: {
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: `Fake reviewer inspected ${input.target.changed_files.length} changed file(s).`,
        overall_confidence_score: 0.5,
      },
      metadata: {
        captureMode: "native-structured",
        readonlyCapability: "enforced",
      },
    };
  },
};
