import { describe, expect, it } from "vitest";
import {
  MIN_USABLE_COLUMNS,
  clampSummaryWidth,
  glyphsFor,
  supportsLiveMotion,
  supportsUnicodeGlyphs,
  truncateLine,
  visibleLength,
  wrapText,
} from "../src/core/terminal-caps.js";

describe("supportsUnicodeGlyphs", () => {
  it("opts up only on a UTF-8 locale with a capable TERM", () => {
    expect(supportsUnicodeGlyphs({ LANG: "en_US.UTF-8", TERM: "xterm-256color" })).toBe(true);
    expect(supportsUnicodeGlyphs({ LC_ALL: "C.utf8", TERM: "tmux-256color" })).toBe(true);
  });

  it("defaults to ASCII when the locale or TERM cannot vouch for glyphs", () => {
    expect(supportsUnicodeGlyphs({})).toBe(false);
    expect(supportsUnicodeGlyphs({ LANG: "C" })).toBe(false);
    expect(supportsUnicodeGlyphs({ LANG: "en_US.UTF-8", TERM: "dumb" })).toBe(false);
    expect(supportsUnicodeGlyphs({ LANG: "en_US.UTF-8", TERM: "linux" })).toBe(false);
    expect(glyphsFor({ LANG: "C" }).spinner).toEqual(["-", "\\", "|", "/"]);
  });

  it("lets LC_ALL override LANG, matching locale precedence", () => {
    expect(supportsUnicodeGlyphs({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(false);
  });
});

describe("supportsLiveMotion", () => {
  const env = { TERM: "xterm-256color" };

  it("requires a TTY that reports usable columns", () => {
    expect(supportsLiveMotion({ isTTY: true, columns: 120 }, env)).toBe(true);
    expect(supportsLiveMotion({ isTTY: false, columns: 120 }, env)).toBe(false);
    // A PTY can report isTTY=true with columns undefined; cursor math would be NaN.
    expect(supportsLiveMotion({ isTTY: true, columns: undefined as never }, env)).toBe(false);
    expect(supportsLiveMotion({ isTTY: true, columns: MIN_USABLE_COLUMNS - 1 }, env)).toBe(false);
  });

  it("stays append-only under CI and dumb terminals", () => {
    expect(supportsLiveMotion({ isTTY: true, columns: 120 }, { TERM: "dumb" })).toBe(false);
    expect(supportsLiveMotion({ isTTY: true, columns: 120 }, { ...env, CI: "1" })).toBe(false);
  });
});

describe("clampSummaryWidth", () => {
  it("clamps into the readable band and defaults missing columns to 80", () => {
    expect(clampSummaryWidth(undefined)).toBe(80);
    expect(clampSummaryWidth(20)).toBe(MIN_USABLE_COLUMNS);
    expect(clampSummaryWidth(300)).toBe(100);
    expect(clampSummaryWidth(90)).toBe(90);
  });
});

describe("wrapText", () => {
  it("wraps on word boundaries with a hanging indent", () => {
    const lines = wrapText("alpha beta gamma delta epsilon", 20, "  ");
    expect(lines).toEqual(["  alpha beta gamma", "  delta epsilon"]);
  });

  it("preserves paragraph breaks", () => {
    expect(wrapText("one\n\ntwo", 40, "")).toEqual(["one", "", "two"]);
  });

  it("passes fitting lines through untouched, keeping indentation and internal spacing", () => {
    const snippet = "    if ok:\n        return  {'a':  1}";
    expect(wrapText(snippet, 60, "  ")).toEqual(["      if ok:", "          return  {'a':  1}"]);
  });

  it("keeps leading indentation on wrapped continuation lines", () => {
    const lines = wrapText("    alpha beta gamma delta epsilon zeta", 24, "");
    expect(lines).toEqual(["    alpha beta gamma", "    delta epsilon zeta"]);
  });
});

describe("truncateLine", () => {
  it("measures wide characters as two terminal cells", () => {
    // "審査" occupies 4 cells; a JS-length measure would let the row wrap and break the
    // live renderer's one-physical-line invariant.
    expect(visibleLength("審査 review")).toBe(4 + " review".length);
    expect(truncateLine("審査審査審査", 5, "...")).toBe("審...");
    expect(visibleLength(truncateLine("審査審査審査", 5, "..."))).toBeLessThanOrEqual(5);
  });

  it("measures visible width through SGR sequences", () => {
    const styled = "\u001B[31mred\u001B[0m line";
    expect(visibleLength(styled)).toBe("red line".length);
    expect(truncateLine(styled, 80, "...")).toBe(styled);
  });

  it("never exceeds the requested width, even below the ellipsis length", () => {
    expect(truncateLine("abcdefgh", 2, "...")).toBe("..");
    expect(truncateLine("abcdefgh", 0, "...")).toBe("");
  });

  it("de-styles before slicing so no escape is cut mid-sequence", () => {
    const styled = `\u001B[32m${"a".repeat(50)}\u001B[0m`;
    const truncated = truncateLine(styled, 10, "...");
    expect(truncated).toBe(`${"a".repeat(7)}...`);
    expect(truncated).not.toContain("\u001B");
  });
});
