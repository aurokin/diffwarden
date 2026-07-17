import type { ReviewEvent, ReviewReviewerArtifact, ReviewTargetResolved } from "./schema.js";
import { type Glyphs, truncateLine } from "./terminal-caps.js";

/**
 * Live review progress for human mode: one row per reviewer, cradle to grave
 * (preflight → reviewing → committed with its verdict), animated in a bounded volatile block
 * on stderr. Strictly line-based — a cursor-up redraw over N rows, never alt-screen — so
 * scrollback, tmux, and resize behave.
 *
 * Single-writer invariant: event handlers only mutate the in-memory model; ALL terminal
 * writes (committing finished rows above the block, erasing, redrawing) happen inside one
 * timer tick or the final `finish()`. Nothing else may touch the cursor.
 */

export type LiveProgressStream = Pick<NodeJS.WriteStream, "write" | "columns" | "rows">;

export type LiveProgressOptions = {
  stream: LiveProgressStream;
  color: boolean;
  glyphs: Glyphs;
  /** Clock seam so demo replay and tests control elapsed time. */
  now?: () => number;
  intervalMs?: number;
};

export type LiveReviewProgress = {
  handleEvent(event: ReviewEvent): void;
  /** Idempotent. Erases the volatile block, commits final states, stops the timer. */
  finish(): void;
};

type RowState = "waiting" | "preflight" | "reviewing";

type Row = {
  key: string;
  name: string;
  state: RowState;
  startedAt: number | undefined;
};

// Ordered by severity: escalate() only ever moves rightward, so a flagged (red) run can never
// be softened back to uncertain (yellow) by a later uncertain reviewer.
const runStates = ["live", "correct", "uncertain", "flagged", "failed"] as const;
type RunState = (typeof runStates)[number];

/** Cap the volatile block so a huge reviewer set cannot outgrow a small pane. */
const maxVolatileRows = 12;

export function createLiveReviewProgress(options: LiveProgressOptions): LiveReviewProgress {
  const { stream, glyphs } = options;
  const now = options.now ?? Date.now;
  const style = makeStyle(options.color);

  const rows = new Map<string, Row>();
  const committedQueue: string[] = [];
  // The worst outcome seen so far: it colors the spine, so the frame's mood degrades
  // monotonically (live → correct stays green only until something flags or fails).
  let runState: RunState = "live";
  let volatileLines = 0;
  let spinnerPhase = 0;
  let dirty = false;
  let finished = false;

  const spineFor = (state: RunState): string => {
    const glyph = glyphs.spine;
    switch (state) {
      case "correct":
        return style.green(glyph);
      case "flagged":
      case "failed":
        return style.red(glyph);
      case "uncertain":
        return style.yellow(glyph);
      default:
        return style.cyan(glyph);
    }
  };

  const escalate = (state: RunState): void => {
    if (runStates.indexOf(state) > runStates.indexOf(runState)) {
      runState = state;
    }
  };

  const columns = (): number => (typeof stream.columns === "number" ? stream.columns : 80);

  const eraseVolatile = (): void => {
    if (volatileLines > 0) {
      stream.write(`\u001B[${volatileLines}A\u001B[0J`);
      volatileLines = 0;
    }
  };

  const renderVolatileRow = (row: Row): string => {
    const spinner = glyphs.spinner[spinnerPhase % glyphs.spinner.length] ?? "-";
    const name = padName(row.name);
    const detail =
      row.state === "reviewing" && row.startedAt !== undefined
        ? `reviewing ${glyphs.dot} ${formatElapsed(now() - row.startedAt)}`
        : row.state === "preflight"
          ? "preflight"
          : "waiting";
    return `${spineFor("live")}  ${style.cyan(spinner)} ${name} ${style.dim(detail)}`;
  };

  const draw = (): void => {
    eraseVolatile();
    while (committedQueue.length > 0) {
      const line = committedQueue.shift();
      if (line !== undefined) {
        stream.write(`${truncateLine(line, columns(), glyphs.ellipsis)}\n`);
      }
    }
    const pending = [...rows.values()];
    // Also bounded by the live pane height: a block taller than the screen clamps cursor-up
    // at the top and later redraws can no longer erase what scrolled — leave headroom for
    // the committed line being written above plus the shell prompt.
    const paneCap =
      typeof stream.rows === "number" ? Math.max(stream.rows - 4, 1) : maxVolatileRows;
    const cap = Math.min(maxVolatileRows, paneCap);
    const shown = pending.slice(0, cap);
    const hidden = pending.length - shown.length;
    const lines = shown.map(renderVolatileRow);
    if (hidden > 0) {
      lines.push(`${spineFor("live")}  ${style.dim(`+${hidden} more`)}`);
    }
    for (const line of lines) {
      stream.write(`${truncateLine(line, columns(), glyphs.ellipsis)}\n`);
    }
    volatileLines = lines.length;
    dirty = false;
  };

  const commit = (line: string): void => {
    committedQueue.push(line);
    dirty = true;
  };

  const commitReviewerRow = (
    key: string,
    verdict: "correct" | "flagged" | "uncertain" | "failed",
    detailParts: string[],
  ): void => {
    const row = rows.get(key);
    rows.delete(key);
    const name = padName(row?.name ?? key);
    const paint =
      verdict === "correct"
        ? style.green
        : verdict === "flagged" || verdict === "failed"
          ? style.red
          : style.yellow;
    const glyph =
      verdict === "correct"
        ? glyphs.pass
        : verdict === "uncertain"
          ? glyphs.uncertain
          : glyphs.fail;
    const detail = detailParts.join(` ${glyphs.dot} `);
    escalate(verdict === "failed" ? "failed" : verdict);
    commit(
      `${spineFor(verdict === "failed" ? "failed" : verdict)}  ${paint(glyph)} ${name} ${paint(verdict)}   ${style.dim(detail)}`,
    );
  };

  const rowKey = (laneId: string | undefined, reviewerId: string): string =>
    laneId === undefined ? reviewerId : `${laneId}:${reviewerId}`;

  const rowName = (laneId: string | undefined, reviewerId: string): string =>
    laneId === undefined ? reviewerId : `${laneId}/${reviewerId}`;

  const header = (target: ReviewTargetResolved, reviewerCount: number): void => {
    const sep = ` ${glyphs.dot} `;
    const targetLabel =
      target.kind === "base" && target.base_ref !== undefined
        ? `base:${target.base_ref}`
        : target.kind === "commit" && target.commit_sha !== undefined
          ? `commit:${target.commit_sha.slice(0, 12)}`
          : target.kind;
    const files = target.changed_files?.length;
    commit(
      `${spineFor("live")} ${style.bold("diffwarden")}${style.cyan(sep)}review${style.cyan(sep)}${targetLabel}${style.cyan(sep)}${reviewerCount} reviewer${reviewerCount === 1 ? "" : "s"}${
        files !== undefined ? style.dim(`${sep}${files} file${files === 1 ? "" : "s"}`) : ""
      }`,
    );
    commit(spineFor("live"));
  };

  const handleEvent = (event: ReviewEvent): void => {
    if (finished) {
      return;
    }
    switch (event.type) {
      case "batch_started": {
        header(event.target, event.reviewers.length);
        break;
      }
      case "run_started": {
        // In a batch, each lane emits its own run_started; only the standalone run draws the header.
        if (event.lane_id === undefined) {
          header(event.target, event.reviewers.length);
        }
        for (const reviewer of event.reviewers) {
          const key = rowKey(event.lane_id, reviewer.id);
          if (!rows.has(key)) {
            rows.set(key, {
              key,
              name: rowName(event.lane_id, reviewer.id),
              state: "waiting",
              startedAt: undefined,
            });
          }
        }
        dirty = true;
        break;
      }
      case "preflight_started": {
        const row = rows.get(rowKey(event.lane_id, event.reviewer_id));
        if (row !== undefined) {
          row.state = "preflight";
          dirty = true;
        }
        break;
      }
      case "preflight_finished": {
        // A failed preflight does NOT commit here: the runner always follows with a
        // reviewer_failed for the same reviewer (runner.ts preflight gate), and that event
        // carries the error message — committing on both would print the reviewer twice.
        break;
      }
      case "reviewer_started": {
        const row = rows.get(rowKey(event.lane_id, event.reviewer_id));
        if (row !== undefined) {
          row.state = "reviewing";
          // Self-timed: reviewer_started carries no timing, and per-reviewer clocks are what
          // make the rows visibly independent.
          row.startedAt = now();
          dirty = true;
        }
        break;
      }
      case "reviewer_result": {
        const { verdict, detail } = reviewerOutcome(event.artifact, glyphs);
        commitReviewerRow(rowKey(event.lane_id, event.reviewer_id), verdict, detail);
        break;
      }
      case "reviewer_failed": {
        commitReviewerRow(rowKey(event.lane_id, event.reviewer_id), "failed", [
          formatElapsed(event.timing_ms),
          firstLine(event.error.message),
        ]);
        break;
      }
      case "lane_finished": {
        commit(
          `${spineFor(runState)}  ${style.dim(`lane ${event.lane_id} finished ${glyphs.dot} ${formatElapsed(event.timing_ms)}`)}`,
        );
        break;
      }
      case "lane_failed": {
        escalate("failed");
        commit(
          `${spineFor("failed")}  ${style.red(`${glyphs.fail} lane ${event.lane_id} failed`)}   ${style.dim(firstLine(event.error.message))}`,
        );
        break;
      }
      case "reviewer_debug_output":
      case "final_result":
      case "error":
        // The stdout summary (or the thrown error path) owns these; the live block only
        // needs to stop, which finish() does.
        break;
    }
  };

  const tick = (): void => {
    spinnerPhase += 1;
    draw();
  };

  const timer = setInterval(tick, options.intervalMs ?? 250);
  // Never hold the process open for an animation.
  timer.unref?.();

  const onResize = (): void => {
    // A narrowing resize can reflow already-painted rows onto extra physical lines, so the
    // logical `volatileLines` count no longer matches what cursor-up must cross — erasing
    // would clobber the wrong region. Abandon the old block instead (it scrolls into history
    // as a stale snapshot) and let the next tick paint a fresh one at the new width. No
    // terminal write happens here: writes stay single-writer, inside the tick.
    volatileLines = 0;
    dirty = true;
  };
  process.on("SIGWINCH", onResize);

  return {
    handleEvent(event) {
      if (finished) {
        return;
      }
      handleEvent(event);
      if (dirty) {
        // Mutations only; the actual paint waits for the tick. Exception: the very first
        // events would otherwise leave the terminal blank for up to a full interval.
        if (volatileLines === 0) {
          draw();
        }
      }
    },
    finish() {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(timer);
      process.removeListener("SIGWINCH", onResize);
      eraseVolatile();
      while (committedQueue.length > 0) {
        const line = committedQueue.shift();
        if (line !== undefined) {
          stream.write(`${truncateLine(line, columns(), glyphs.ellipsis)}\n`);
        }
      }
      // Anything still volatile at teardown (an error path mid-run) commits as-is so the
      // scrollback tells the truth about where the run stopped.
      for (const row of rows.values()) {
        stream.write(
          `${truncateLine(`${spineFor(runState)}  ${style.dim(`${glyphs.pending} ${padName(row.name)} ${row.state}`)}`, columns(), glyphs.ellipsis)}\n`,
        );
      }
      rows.clear();
    },
  };
}

function reviewerOutcome(
  artifact: ReviewReviewerArtifact,
  glyphs: Glyphs,
): { verdict: "correct" | "flagged" | "uncertain"; detail: string[] } {
  const findings = artifact.result?.findings.length ?? 0;
  const correctness = artifact.result?.overall_correctness;
  const verdict =
    correctness === "patch is correct"
      ? "correct"
      : correctness === "patch is incorrect"
        ? "flagged"
        : "uncertain";
  const detail = [
    ...(artifact.timing_ms !== undefined ? [formatElapsed(artifact.timing_ms)] : []),
    `${findings} finding${findings === 1 ? "" : "s"}`,
    ...(artifact.result !== undefined
      ? [`conf ${artifact.result.overall_confidence_score.toFixed(2)}`]
      : []),
  ];
  return { verdict, detail };
}

const nameColumnWidth = 12;

function padName(name: string): string {
  // "+" not the glyph ellipsis: the pad width must be constant across glyph sets.
  return name.length > nameColumnWidth
    ? `${name.slice(0, nameColumnWidth - 1)}+`
    : name.padEnd(nameColumnWidth);
}

function formatElapsed(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function makeStyle(enabled: boolean) {
  const paint =
    (code: number) =>
    (value: string): string =>
      enabled ? `\u001B[${code}m${value}\u001B[0m` : value;
  return {
    bold: paint(1),
    dim: paint(2),
    red: paint(31),
    green: paint(32),
    yellow: paint(33),
    cyan: paint(36),
  };
}
