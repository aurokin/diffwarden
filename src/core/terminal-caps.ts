/**
 * Terminal capability gates for the human-facing render paths. Three independent decisions
 * (never conflated): whether a stream may host cursor motion, whether it gets color, and
 * whether glyphs may opt up from ASCII to unicode. ASCII is the default everywhere; unicode
 * is an explicit allowlist (UTF-8 locale AND a TERM that renders it), never detect-and-hope —
 * a braille spinner as tofu is worse than `-\|/`.
 */

export type Glyphs = {
  pass: string;
  fail: string;
  uncertain: string;
  pending: string;
  /** Left spine: one leading cell per run line, colored by run state. */
  spine: string;
  /** Verdict banner rule character. */
  rule: string;
  /** Field separator inside meta lines. */
  dot: string;
  ellipsis: string;
  spinner: readonly string[];
};

export const unicodeGlyphs: Glyphs = {
  pass: "✓",
  fail: "✗",
  uncertain: "?",
  pending: "•",
  spine: "▌",
  rule: "━",
  dot: "·",
  ellipsis: "…",
  spinner: ["◐", "◓", "◑", "◒"],
};

export const asciiGlyphs: Glyphs = {
  pass: "+",
  fail: "x",
  uncertain: "?",
  pending: "-",
  spine: "|",
  rule: "=",
  // Strictly 7-bit: U+00B7 encodes as two UTF-8 bytes, which is mojibake on exactly the
  // non-UTF-8 terminals this tier exists for.
  dot: "-",
  ellipsis: "...",
  spinner: ["-", "\\", "|", "/"],
};

/**
 * Unicode opt-up allowlist: a UTF-8 locale in LC_ALL/LC_CTYPE/LANG and a TERM that is not a
 * known glyph-mangler.
 */
export function supportsUnicodeGlyphs(env: NodeJS.ProcessEnv): boolean {
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  if (!/utf-?8/i.test(locale)) {
    return false;
  }
  return env.TERM !== "dumb" && env.TERM !== "linux";
}

export function glyphsFor(env: NodeJS.ProcessEnv): Glyphs {
  return supportsUnicodeGlyphs(env) ? unicodeGlyphs : asciiGlyphs;
}

export const MIN_USABLE_COLUMNS = 40;

/**
 * Motion gate: whether a stream may host the cursor-driven volatile block. Requires a real
 * TTY that reports usable columns (a PTY can report isTTY=true with columns undefined — that
 * would turn cursor math into NaN), a TERM that honors cursor movement, and no CI. Failing
 * this gate falls back to append-only lines, never to a broken redraw.
 */
export function supportsLiveMotion(
  stream: Pick<NodeJS.WriteStream, "isTTY" | "columns">,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    stream.isTTY === true &&
    typeof stream.columns === "number" &&
    stream.columns >= MIN_USABLE_COLUMNS &&
    env.TERM !== "dumb" &&
    env.CI === undefined
  );
}

/** Width for the stdout summary: clamped so banners neither wrap at 40 nor sprawl at 300. */
export function clampSummaryWidth(columns: number | undefined): number {
  const width = columns ?? 80;
  return Math.min(Math.max(width, MIN_USABLE_COLUMNS), 100);
}

/** Word-aware wrap: breaks on spaces, preserves existing newlines, prefixes every line. */
export function wrapText(text: string, width: number, indent: string): string[] {
  const usable = Math.max(width - indent.length, 20);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word === "") {
        continue;
      }
      if (current === "") {
        current = word;
      } else if (current.length + 1 + word.length <= usable) {
        current = `${current} ${word}`;
      } else {
        lines.push(`${indent}${current}`);
        current = word;
      }
    }
    if (current !== "") {
      lines.push(`${indent}${current}`);
    }
  }
  return lines;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes are exactly what this strips
const ansiPattern = /\u001B\[[0-9;]*m/g;

/** Printable width of a styled line (SGR sequences excluded). */
export function visibleLength(line: string): number {
  return line.replace(ansiPattern, "").length;
}

/**
 * Truncate one rendered line to the live terminal width, ellipsizing the tail. A line that
 * overflows is de-styled before slicing — cutting mid-escape would leak a broken sequence,
 * and an unstyled truncated row beats a corrupted one.
 */
export function truncateLine(line: string, columns: number, ellipsis: string): string {
  if (visibleLength(line) <= columns) {
    return line;
  }
  const plain = line.replace(ansiPattern, "");
  const keep = Math.max(columns - ellipsis.length, 0);
  // The final slice covers columns narrower than the ellipsis itself: even "..." must not
  // exceed the requested width, or the row wraps and breaks the volatile block's line count.
  return `${plain.slice(0, keep)}${ellipsis}`.slice(0, Math.max(columns, 0));
}
