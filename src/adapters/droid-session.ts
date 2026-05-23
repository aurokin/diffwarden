import type { ReviewAdapterInput } from "./types.js";

export type DroidSessionTransport = "cli" | "sdk";

export type DroidSessionTag = {
  name: string;
  metadata: Record<string, string>;
};

export function droidSessionTag(
  input: ReviewAdapterInput,
  transport: DroidSessionTransport,
): DroidSessionTag {
  return {
    name: "diffwarden",
    metadata: {
      transport,
      reviewer: input.reviewer.id,
      target: input.target.kind,
    },
  };
}
