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
    await emitFakeDebugOutput(input);
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

/**
 * Deterministic incremental debug output for tests and demos, active only when
 * the run opted into debug capture AND DIFFWARDEN_FAKE_DEBUG_CHUNKS is set.
 * DIFFWARDEN_FAKE_DEBUG_DELAY_MS spaces the chunks out to simulate streaming.
 */
async function emitFakeDebugOutput(input: ReviewAdapterInput): Promise<void> {
  const debugOutput = input.debugOutput;
  const chunkCount = parseFakeDebugNumber(input.env?.DIFFWARDEN_FAKE_DEBUG_CHUNKS);
  if (debugOutput === undefined || chunkCount === 0) {
    return;
  }

  const delayMs = parseFakeDebugNumber(input.env?.DIFFWARDEN_FAKE_DEBUG_DELAY_MS);
  for (let index = 1; index <= chunkCount; index += 1) {
    debugOutput.onChunk(
      "stdout",
      `fake debug: reviewing hunk ${index}/${chunkCount} of ${input.target.changed_files.length} changed file(s)\n`,
    );
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  debugOutput.onChunk("stderr", "fake debug: reviewer diagnostics written to stderr\n");
}

function parseFakeDebugNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
