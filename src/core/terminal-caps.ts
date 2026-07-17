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

/**
 * Word-aware wrap: preserves existing newlines and leading indentation, prefixes every line.
 * Lines that already fit pass through untouched so spacing-sensitive content (code snippets,
 * aligned commands) keeps its internal whitespace; only overlong lines are re-broken on spaces.
 */
export function wrapText(text: string, width: number, indent: string): string[] {
  const usable = Math.max(width - indent.length, 20);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    if (paragraph.length <= usable) {
      lines.push(`${indent}${paragraph}`);
      continue;
    }
    const lead = /^[ \t]*/.exec(paragraph)?.[0] ?? "";
    const prefix = `${indent}${lead}`;
    const usableBody = Math.max(width - prefix.length, 20);
    let current = "";
    for (const word of paragraph.slice(lead.length).split(/\s+/)) {
      if (word === "") {
        continue;
      }
      if (current === "") {
        current = word;
      } else if (current.length + 1 + word.length <= usableBody) {
        current = `${current} ${word}`;
      } else {
        lines.push(`${prefix}${current}`);
        current = word;
      }
    }
    if (current !== "") {
      lines.push(`${prefix}${current}`);
    }
  }
  return lines;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes are exactly what this strips
const ansiPattern = /\u001B\[[0-9;]*m/g;

/**
 * Terminal cells for one code point: 2 for East Asian wide/fullwidth ranges and emoji,
 * 1 otherwise. Approximate on purpose — enough to keep the live renderer's one-physical-line
 * invariant for CJK reviewer ids without a full wcwidth table.
 */
function codePointCells(codePoint: number): number {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ? 2
    : 1;
}

/** Printable width of a styled line in terminal cells (SGR sequences excluded). */
export function visibleLength(line: string): number {
  let cells = 0;
  for (const char of line.replace(ansiPattern, "")) {
    cells += codePointCells(char.codePointAt(0) ?? 0);
  }
  return cells;
}

/**
 * Truncate one rendered line to the live terminal width, ellipsizing the tail. A line that
 * overflows is de-styled before slicing — cutting mid-escape would leak a broken sequence,
 * and an unstyled truncated row beats a corrupted one. Width is measured in terminal cells
 * so wide characters cannot smuggle a second physical line past the volatile-block math.
 */
export function truncateLine(line: string, columns: number, ellipsis: string): string {
  if (visibleLength(line) <= columns) {
    return line;
  }
  const plain = line.replace(ansiPattern, "");
  const keep = Math.max(columns - ellipsis.length, 0);
  let kept = "";
  let cells = 0;
  for (const char of plain) {
    const width = codePointCells(char.codePointAt(0) ?? 0);
    if (cells + width > keep) {
      break;
    }
    kept += char;
    cells += width;
  }
  // The final slice covers columns narrower than the ellipsis itself: even "..." must not
  // exceed the requested width, or the row wraps and breaks the volatile block's line count.
  return `${kept}${ellipsis}`.slice(0, Math.max(columns, 0));
}
