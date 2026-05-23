import type { ReviewAdapter, ReviewAdapterInput, ReviewAdapterOutput } from "./types.js";

export const fakeAdapter: ReviewAdapter = {
  name: "fake",
  async preflight() {
    return {
      checks: [
        {
          name: "runtime",
          status: "passed",
          detail: "Fake reviewer runs in-process.",
        },
        {
          name: "readonly",
          status: "passed",
          detail: "Fake reviewer cannot modify files.",
        },
      ],
      metadata: {
        readonlyCapability: "enforced",
      },
    };
  },
  async run(input: ReviewAdapterInput): Promise<ReviewAdapterOutput> {
    const findingPath = input.env?.DIFFWARDEN_FAKE_FINDING_PATH;
    return {
      structured: {
        findings:
          findingPath === undefined
            ? []
            : [
                {
                  title: "[P2] Fake finding",
                  body: "Fake reviewer emitted a deterministic finding for CLI tests.",
                  confidence_score: 0.8,
                  priority: 2,
                  code_location: {
                    absolute_file_path: findingPath,
                    line_range: {
                      start: 1,
                      end: 1,
                    },
                  },
                },
              ],
        overall_correctness: findingPath === undefined ? "patch is correct" : "patch is incorrect",
        overall_explanation:
          findingPath === undefined
            ? `Fake reviewer inspected ${input.target.changed_files.length} changed file(s).`
            : "Fake reviewer emitted a deterministic finding.",
        overall_confidence_score: 0.5,
      },
      metadata: {
        captureMode: "native-structured",
        readonlyCapability: "enforced",
      },
    };
  },
};
