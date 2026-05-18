export type LineRange = {
  start: number;
  end: number;
};

export type ChangedLineRanges = Record<string, LineRange[]>;

const hunkHeaderPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseChangedLineRanges(diff: string): ChangedLineRanges {
  const ranges: ChangedLineRanges = {};
  let currentFile: string | undefined;
  let newLine = 0;
  let activeRange: LineRange | undefined;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishRange();
      currentFile = undefined;
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ ")) {
      finishRange();
      currentFile = parseNewFilePath(line);
      continue;
    }

    const hunkMatch = hunkHeaderPattern.exec(line);
    if (hunkMatch) {
      finishRange();
      newLine = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }

    if (!inHunk || currentFile === undefined) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      extendRange(currentFile, newLine);
      newLine += 1;
      continue;
    }

    finishRange();

    if (line.startsWith(" ") || line.length === 0) {
      newLine += 1;
    }
  }

  finishRange();
  return ranges;

  function extendRange(file: string, lineNumber: number) {
    if (activeRange === undefined) {
      activeRange = {
        start: lineNumber,
        end: lineNumber,
      };
      return;
    }

    activeRange.end = lineNumber;
  }

  function finishRange() {
    if (activeRange === undefined || currentFile === undefined) {
      activeRange = undefined;
      return;
    }

    const fileRanges = ranges[currentFile] ?? [];
    fileRanges.push(activeRange);
    ranges[currentFile] = fileRanges;
    activeRange = undefined;
  }
}

function parseNewFilePath(line: string): string | undefined {
  const rawPath = line.slice("+++ ".length).trim();
  if (rawPath === "/dev/null") {
    return undefined;
  }
  if (rawPath.startsWith("b/")) {
    return rawPath.slice(2);
  }
  return rawPath;
}
