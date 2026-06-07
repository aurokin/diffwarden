import { describe, expect, it } from "vitest";
import {
  executableSearchNames,
  shouldUseWindowsCommandShell,
} from "../src/adapters/cli-process.js";

describe("cli process helpers", () => {
  it("detects Windows command shims that need shell execution", () => {
    expect(shouldUseWindowsCommandShell("grok.cmd", "win32")).toBe(true);
    expect(shouldUseWindowsCommandShell("C:\\tools\\grok.BAT", "win32")).toBe(true);
    expect(shouldUseWindowsCommandShell("grok.exe", "win32")).toBe(false);
    expect(shouldUseWindowsCommandShell("grok.cmd", "darwin")).toBe(false);
  });

  it("expands PATHEXT candidates for Windows executable lookup", () => {
    expect(executableSearchNames("grok", { PATHEXT: ".EXE;.CMD" }, "win32")).toEqual([
      "grok",
      "grok.EXE",
      "grok.CMD",
    ]);
    expect(executableSearchNames("grok.cmd", { PATHEXT: ".EXE;.CMD" }, "win32")).toEqual([
      "grok.cmd",
    ]);
    expect(executableSearchNames("grok", { PATHEXT: ".EXE;.CMD" }, "darwin")).toEqual(["grok"]);
  });
});
