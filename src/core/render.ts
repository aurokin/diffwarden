import type { ReviewFailureArtifact, ReviewRunArtifact } from "./schema.js";

export function renderJson(artifact: ReviewRunArtifact | ReviewFailureArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
