import { describe, expect, it } from "vitest";
import { parseOpencodeModels } from "../src/adapters/opencode.js";

describe("parseOpencodeModels", () => {
  it("takes each plain provider/model line as an id, ids only", () => {
    const stdout = [
      "opencode/claude-opus-4-5",
      "anthropic/claude-haiku-4-5",
      "github-copilot/gpt-5.2",
      "",
    ].join("\n");
    expect(parseOpencodeModels(stdout)).toEqual([
      { value: "opencode/claude-opus-4-5" },
      { value: "anthropic/claude-haiku-4-5" },
      { value: "github-copilot/gpt-5.2" },
    ]);
  });

  it("skips banners, log noise, and non-qualified lines", () => {
    const stdout = [
      "Checking for updates...",
      "WARN some log line",
      "not-a-model",
      "zai-coding-plan/glm-5.2",
    ].join("\n");
    // Only provider/model-shaped lines survive; an all-noise result degrades to the catalog
    // session's "unavailable" instead of an empty picker.
    expect(parseOpencodeModels(stdout)).toEqual([{ value: "zai-coding-plan/glm-5.2" }]);
    expect(parseOpencodeModels("Please run: opencode auth login")).toEqual([]);
  });
});
