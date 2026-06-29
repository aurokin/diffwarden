import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { PublicReviewerEntry } from "../src/core/config.js";
import type { ReviewerDiscoveryResult } from "../src/core/discovery.js";
import {
  type Prompter,
  confirmEditReviewer,
  confirmRemoveReviewer,
  confirmScaffold,
  confirmWriteEntry,
  createReadlinePrompter,
  isInteractiveAvailable,
  promptSelectConfiguredReviewer,
  promptSelectReviewerEntry,
  selectScaffoldReviewers,
  shouldRunInteractiveSetup,
} from "../src/core/interactive.js";

type RecordingPrompter = Prompter & {
  calls: { confirm: { question: string; defaultYes: boolean }[]; select: string[][] };
};

function recordingPrompter(answers: {
  selectIndex?: number;
  confirm?: boolean;
}): RecordingPrompter {
  const calls: RecordingPrompter["calls"] = { confirm: [], select: [] };
  return {
    calls,
    async confirm(question, defaultYes) {
      calls.confirm.push({ question, defaultYes });
      return answers.confirm ?? true;
    },
    async select(_question, choices) {
      calls.select.push(choices);
      return answers.selectIndex ?? 0;
    },
    close() {},
  };
}

function discoveryResult(
  candidates: ReviewerDiscoveryResult["candidates"],
): ReviewerDiscoveryResult {
  return {
    schema_version: 1,
    cwd: "/repo",
    deep: false,
    candidates,
    summary: { available: [], needsAttention: [], missing: [] },
  };
}

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

describe("promptSelectConfiguredReviewer", () => {
  it("returns the id the user picked and labels disabled reviewers", async () => {
    const prompter = recordingPrompter({ selectIndex: 1 });
    const id = await promptSelectConfiguredReviewer(
      prompter,
      [
        { id: "codex", engine: "codex", enabled: true },
        { id: "cursor", engine: "cursor", enabled: false },
      ],
      "remove",
    );

    expect(id).toBe("cursor");
    expect(prompter.calls.select[0]).toEqual(["codex (codex)", "cursor (cursor) [disabled]"]);
  });

  it("returns undefined when there are no configured reviewers", async () => {
    expect(await promptSelectConfiguredReviewer(recordingPrompter({}), [], "edit")).toBeUndefined();
  });
});

describe("promptSelectReviewerEntry", () => {
  it("returns the selected addable reviewer entry", async () => {
    const result = discoveryResult([
      {
        engine: "codex",
        transport: "cli",
        status: "available",
        authState: "verified",
        detail: "ready",
        recommended: { id: "codex", engine: "codex" },
      },
      {
        engine: "cursor",
        transport: "cli",
        status: "missing_executable",
        authState: "missing",
        detail: "absent",
      },
    ]);
    const prompter = recordingPrompter({ selectIndex: 0 });

    const entry = await promptSelectReviewerEntry(prompter, result);

    expect(entry).toEqual({ id: "codex", engine: "codex" });
    // Only addable candidates are offered.
    expect(prompter.calls.select[0]).toHaveLength(1);
  });

  it("returns undefined when nothing is addable", async () => {
    const result = discoveryResult([
      {
        engine: "cursor",
        transport: "cli",
        status: "missing_executable",
        authState: "missing",
        detail: "absent",
      },
    ]);

    expect(await promptSelectReviewerEntry(recordingPrompter({}), result)).toBeUndefined();
  });
});

describe("confirm helpers", () => {
  it("confirmWriteEntry asks with a yes default", async () => {
    const prompter = recordingPrompter({ confirm: false });
    const entry: PublicReviewerEntry = { id: "codex", engine: "codex" };

    expect(await confirmWriteEntry(prompter, entry, "/tmp/config.json")).toBe(false);
    expect(prompter.calls.confirm[0]?.defaultYes).toBe(true);
    expect(prompter.calls.confirm[0]?.question).toContain("codex");
  });

  it("confirmScaffold lists reviewer ids and defaults to yes", async () => {
    const prompter = recordingPrompter({ confirm: true });
    const reviewers: PublicReviewerEntry[] = [
      { id: "codex", engine: "codex" },
      { id: "cursor", engine: "cursor" },
    ];

    expect(await confirmScaffold(prompter, reviewers, "/tmp/config.json")).toBe(true);
    expect(prompter.calls.confirm[0]?.question).toContain("codex, cursor");
    expect(prompter.calls.confirm[0]?.defaultYes).toBe(true);
  });

  it("confirmRemoveReviewer defaults to no because removal is destructive", async () => {
    const prompter = recordingPrompter({ confirm: false });

    expect(await confirmRemoveReviewer(prompter, "codex", "/tmp/config.json")).toBe(false);
    expect(prompter.calls.confirm[0]?.defaultYes).toBe(false);
    expect(prompter.calls.confirm[0]?.question).toContain("codex");
  });

  it("confirmEditReviewer asks with a yes default", async () => {
    const prompter = recordingPrompter({ confirm: true });

    expect(await confirmEditReviewer(prompter, "codex", "/tmp/config.json")).toBe(true);
    expect(prompter.calls.confirm[0]?.defaultYes).toBe(true);
    expect(prompter.calls.confirm[0]?.question).toContain("codex");
  });
});

describe("selectScaffoldReviewers", () => {
  it("returns only the reviewers the user includes", async () => {
    const answers = [true, false, true];
    let index = 0;
    const prompter: Prompter = {
      async confirm() {
        return answers[index++] ?? true;
      },
      async select() {
        return 0;
      },
      close() {},
    };
    const reviewers: PublicReviewerEntry[] = [
      { id: "codex", engine: "codex" },
      { id: "cursor", engine: "cursor" },
      { id: "claude", engine: "claude" },
    ];

    const selected = await selectScaffoldReviewers(prompter, reviewers);

    expect(selected.map((reviewer) => reviewer.id)).toEqual(["codex", "claude"]);
  });
});

describe("createReadlinePrompter", () => {
  function prompterOn(): { prompter: Prompter; input: PassThrough; output: PassThrough } {
    const input = new PassThrough();
    const output = new PassThrough();
    return { prompter: createReadlinePrompter({ input, output }), input, output };
  }

  it("confirm returns true for yes, false for no, and the default for empty input", async () => {
    const yes = prompterOn();
    const yesPromise = yes.prompter.confirm("ok?", false);
    yes.input.write("y\n");
    expect(await yesPromise).toBe(true);
    yes.prompter.close();

    const no = prompterOn();
    const noPromise = no.prompter.confirm("ok?", true);
    no.input.write("n\n");
    expect(await noPromise).toBe(false);
    no.prompter.close();

    const def = prompterOn();
    const defPromise = def.prompter.confirm("ok?", true);
    def.input.write("\n");
    expect(await defPromise).toBe(true);
    def.prompter.close();
  });

  it("select returns the chosen zero-based index", async () => {
    const { prompter, input } = prompterOn();
    const selection = prompter.select("pick", ["a", "b", "c"]);
    input.write("2\n");
    expect(await selection).toBe(1);
    prompter.close();
  });

  it("select re-prompts on an out-of-range answer", async () => {
    const { prompter, input, output } = prompterOn();
    // Answer the second prompt only once the re-prompt message confirms the first was rejected,
    // deferring a tick so readline has registered the next question.
    output.on("data", (chunk) => {
      if (String(chunk).includes("between 1 and 2")) {
        setImmediate(() => input.write("1\n"));
      }
    });
    const selection = prompter.select("pick", ["a", "b"]);
    input.write("9\n");
    expect(await selection).toBe(0);
    prompter.close();
  });
});
