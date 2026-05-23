import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultReviewerModel,
  defaultReviewerTransport,
  reviewerCapabilities,
  reviewerSdkValues,
} from "../src/adapters/capabilities.js";

const featureDoc = readFileSync(path.join(process.cwd(), "docs/features.md"), "utf8");

describe("feature matrix docs", () => {
  it("keeps reviewer selection rows aligned with capability defaults", () => {
    const rows = parseTable("## Reviewer Selection");

    for (const sdk of reviewerSdkValues) {
      const row = rows.get(`\`${sdk}\``);
      expect(row, `missing reviewer selection row for ${sdk}`).toBeDefined();
      if (row === undefined) {
        continue;
      }

      expect(row["Default transport"]).toBe(documentedDefaultTransport(sdk));
      expect(row["Default model"]).toBe(documentedDefaultModel(sdk));

      const supportedTransports = Object.values(reviewerCapabilities[sdk].transports)
        .filter((capability) => capability?.supported)
        .map((capability) => capability.transport);
      const defaultTransport =
        defaultReviewerTransport(sdk) ?? (sdk === "fake" ? undefined : "sdk");
      const alternateTransports = supportedTransports.filter(
        (transport) => transport !== defaultTransport,
      );
      expect(row["Alternate transport"]).toBe(
        documentedAlternateTransport(sdk, alternateTransports),
      );
      expect(row["Default executable"]).toBe(documentedDefaultExecutable(sdk));
    }
  });

  it("keeps capability rows aligned with supported adapter paths", () => {
    const rows = parseTable("## Capability Matrix");

    expect(rows.get("`fake`")).toMatchObject({
      "Model override": "no",
      "Effort override": "no",
      "Read-only capability": "enforced",
    });

    for (const sdk of reviewerSdkValues) {
      if (sdk === "fake") {
        continue;
      }

      for (const capability of Object.values(reviewerCapabilities[sdk].transports)) {
        if (capability === undefined || !capability.supported) {
          continue;
        }

        const adapterPath = `\`${sdk}\` ${capability.transport.toUpperCase()}`;
        const row = rows.get(adapterPath);
        expect(row, `missing capability row for ${adapterPath}`).toBeDefined();
        if (row === undefined) {
          continue;
        }

        expect(row["Model override"]).toBe(capability.supportsModel ? "yes" : "no");
        expect(row["Effort override"]).toBe(
          sdk === "cursor" && capability.transport === "sdk"
            ? "ignored"
            : capability.supportsEffort
              ? "yes"
              : "no",
        );
        expect(row["Read-only capability"]).toBe(capability.readonlyCapability);
        expect(row["Capture mode"]).toContain(documentedCaptureModeNeedle(capability.captureMode));
      }
    }
  });

  it("does not document stale adapter paths that are unsupported by capabilities", () => {
    const rows = parseTable("## Capability Matrix");
    const expectedPaths = new Set(["`fake`"]);

    for (const sdk of reviewerSdkValues) {
      if (sdk === "fake") {
        continue;
      }
      for (const capability of Object.values(reviewerCapabilities[sdk].transports)) {
        if (capability?.supported) {
          expectedPaths.add(`\`${sdk}\` ${capability.transport.toUpperCase()}`);
        }
      }
    }

    expect([...rows.keys()].sort()).toEqual([...expectedPaths].sort());
  });
});

function parseTable(heading: string): Map<string, Record<string, string>> {
  const tableStart = featureDoc.indexOf(heading);
  if (tableStart === -1) {
    throw new Error(`Missing feature docs heading: ${heading}`);
  }

  const nextHeading = featureDoc.indexOf("\n## ", tableStart + heading.length);
  const tableText = featureDoc.slice(
    tableStart,
    nextHeading === -1 ? featureDoc.length : nextHeading,
  );
  const lines = tableText
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.startsWith("|"));
  const header = parseTableRow(lines[0] ?? "");
  const rows = new Map<string, Record<string, string>>();

  for (const line of lines.slice(2)) {
    const cells = parseTableRow(line);
    if (cells.length !== header.length) {
      throw new Error(`Malformed feature docs row: ${line}`);
    }
    rows.set(
      cells[0] ?? "",
      Object.fromEntries(header.map((column, index) => [column, cells[index] ?? ""])),
    );
  }

  return rows;
}

function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function documentedDefaultTransport(sdk: (typeof reviewerSdkValues)[number]): string {
  if (sdk === "fake") {
    return "n/a";
  }
  const transport = defaultReviewerTransport(sdk);
  return (transport ?? "sdk").toUpperCase();
}

function documentedDefaultModel(sdk: (typeof reviewerSdkValues)[number]): string {
  const defaultModel = defaultReviewerModel(sdk);
  if (defaultModel !== undefined) {
    return `\`${defaultModel}\``;
  }

  if (sdk === "fake") {
    return "n/a";
  }
  if (sdk === "pi") {
    return "first authenticated Pi model";
  }
  if (sdk === "droid") {
    return "Droid default";
  }
  return "CLI default";
}

function documentedAlternateTransport(
  sdk: (typeof reviewerSdkValues)[number],
  transports: string[],
): string {
  if (!transports.length) {
    return sdk === "fake" ? "n/a" : "no";
  }
  return transports.map((transport) => transport.toUpperCase()).join(", ");
}

function documentedDefaultExecutable(sdk: (typeof reviewerSdkValues)[number]): string {
  if (sdk === "fake") {
    return "n/a";
  }
  if (sdk === "claude") {
    return "`claude` for CLI/local auth";
  }
  if (sdk === "cursor") {
    return "`cursor-agent` for CLI";
  }
  if (sdk === "pi") {
    return "`pi` for CLI";
  }

  const executables = new Set(
    Object.values(reviewerCapabilities[sdk].transports)
      .map((capability) => capability?.defaultExecutable)
      .filter((executable): executable is string => executable !== undefined),
  );
  if (executables.size === 0) {
    return "n/a";
  }
  return [...executables].map((executable) => `\`${executable}\``).join(", ");
}

function documentedCaptureModeNeedle(captureMode: string): string {
  if (captureMode === "native-structured") {
    return "native structured";
  }
  if (captureMode === "tool-call") {
    return "tool call";
  }
  return captureMode;
}
