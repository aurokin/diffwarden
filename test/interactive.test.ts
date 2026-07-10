import { describe, expect, it } from "vitest";
import { isInteractiveAvailable, shouldRunInteractiveSetup } from "../src/core/interactive.js";

describe("isInteractiveAvailable", () => {
  it("is true only for a TTY stream", () => {
    expect(isInteractiveAvailable({ isTTY: true })).toBe(true);
    expect(isInteractiveAvailable({ isTTY: false })).toBe(false);
    expect(isInteractiveAvailable({})).toBe(false);
  });
});

describe("shouldRunInteractiveSetup", () => {
  it("defaults to the guided flow only when stdin is a TTY", () => {
    expect(shouldRunInteractiveSetup({}, { isTTY: true })).toBe(true);
    expect(shouldRunInteractiveSetup({}, { isTTY: false })).toBe(false);
    expect(shouldRunInteractiveSetup({}, {})).toBe(false);
  });

  it("never blocks on input when --json is set, even in a TTY", () => {
    expect(shouldRunInteractiveSetup({ json: true }, { isTTY: true })).toBe(false);
  });

  it("opts in with --interactive even on a non-TTY (the caller guards the real TTY)", () => {
    expect(shouldRunInteractiveSetup({ interactive: true }, { isTTY: false })).toBe(true);
  });

  it("treats --json as authoritative over --interactive so it can never hang", () => {
    expect(shouldRunInteractiveSetup({ interactive: true, json: true }, { isTTY: true })).toBe(
      false,
    );
  });
});
