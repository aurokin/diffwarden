import { describe, expect, it } from "vitest";
import { parseChangedLineRanges } from "../src/core/diff.js";

describe("parseChangedLineRanges", () => {
  it("parses added file ranges", () => {
    const ranges = parseChangedLineRanges(`diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`);

    expect(ranges).toEqual({
      "new.ts": [{ start: 1, end: 2 }],
    });
  });

  it("parses modified file ranges across multiple hunks", () => {
    const ranges = parseChangedLineRanges(`diff --git a/src/client.ts b/src/client.ts
index 1111111..2222222 100644
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,4 +1,4 @@
 context
-old
+new
 context
@@ -10,3 +10,4 @@
 context
+added
 context
`);

    expect(ranges).toEqual({
      "src/client.ts": [
        { start: 2, end: 2 },
        { start: 11, end: 11 },
      ],
    });
  });

  it("uses the new path for renamed files", () => {
    const ranges = parseChangedLineRanges(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-old
+new
`);

    expect(ranges).toEqual({
      "new.ts": [{ start: 1, end: 1 }],
    });
  });
});
