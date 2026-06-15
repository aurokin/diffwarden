import type { ReviewArtifact } from "./schema.js";

export function renderJson(artifact: ReviewArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
