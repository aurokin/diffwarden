import type { ReviewRunArtifact } from "./schema.js";

export function renderJson(artifact: ReviewRunArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
