import { describe, expect, it } from "vitest";
import { parseTargetSpec } from "../src/core/target.js";

describe("parseTargetSpec", () => {
  it("parses uncommitted targets", () => {
    expect(parseTargetSpec("uncommitted")).toEqual({
      kind: "uncommitted",
      raw: "uncommitted",
    });
  });

  it("parses base targets", () => {
    expect(parseTargetSpec("base:main")).toEqual({
      kind: "base",
      raw: "base:main",
      branch: "main",
    });
  });

  it("parses commit targets", () => {
    expect(parseTargetSpec("commit:abc123")).toEqual({
      kind: "commit",
      raw: "commit:abc123",
      sha: "abc123",
    });
  });

  it("parses custom targets", () => {
    expect(parseTargetSpec("custom: Review the auth flow ")).toEqual({
      kind: "custom",
      raw: "custom: Review the auth flow ",
      instructions: "Review the auth flow",
    });
  });

  it("rejects empty custom targets", () => {
    expect(() => parseTargetSpec("custom:   ")).toThrow(
      "Invalid target: custom target requires instructions",
    );
  });

  it("rejects unsupported targets", () => {
    expect(() => parseTargetSpec("pr:1")).toThrow("Invalid target");
  });
});
