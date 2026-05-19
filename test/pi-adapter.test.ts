import { describe, expect, it } from "vitest";
import { createPiAdapter } from "../src/adapters/pi.js";
import type { ReviewAdapterInput } from "../src/adapters/types.js";
import { missingRequirement } from "../src/core/errors.js";

describe("piAdapter", () => {
  it("fails preflight clearly when no Pi models are authenticated", async () => {
    const adapter = createMockPiAdapter([]);

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_auth",
      exitCode: 3,
    });
  });

  it("preflights available Pi models without requiring live credentials in tests", async () => {
    const adapter = createMockPiAdapter([{ provider: "test", id: "test-model" }]);

    const preflight = await adapter.preflight?.({
      cwd: process.cwd(),
      reviewer: {
        id: "pi",
        sdk: "pi",
        readonly: true,
      },
      readonly: true,
      env: {},
    });

    expect(preflight?.checks.map((check) => check.name)).toEqual([
      "sdk",
      "auth",
      "model",
      "readonly",
    ]);
    expect(preflight?.metadata).toMatchObject({
      readonlyCapability: "tool-restricted",
      preferredCaptureMode: "tool-call",
      availableModelCount: 1,
    });
  });

  it("fails clearly when the Pi SDK package is not installed", async () => {
    const adapter = createPiAdapter({
      async loadSdk() {
        throw missingRequirement("Failed to load @earendil-works/pi-coding-agent: missing");
      },
    });

    await expect(
      adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
        },
        readonly: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "missing_requirement",
      exitCode: 3,
    });
  });

  it("isolates Pi model availability to the supplied env", async () => {
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    const adapter = createEnvSensitiveMockPiAdapter();

    try {
      await expect(
        adapter.preflight?.({
          cwd: process.cwd(),
          reviewer: {
            id: "pi",
            sdk: "pi",
            readonly: true,
          },
          readonly: true,
          env: {},
        }),
      ).rejects.toMatchObject({
        code: "missing_auth",
        exitCode: 3,
      });

      const preflight = await adapter.preflight?.({
        cwd: process.cwd(),
        reviewer: {
          id: "pi",
          sdk: "pi",
          readonly: true,
        },
        readonly: true,
        env: {
          ANTHROPIC_API_KEY: "scoped-key",
        },
      });

      expect(preflight?.metadata?.availableModelCount).toBe(1);
    } finally {
      if (originalAnthropicKey === undefined) {
        Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      }
    }
  });

  it("fails execution clearly while the structured tool path is scaffolded", async () => {
    const adapter = createMockPiAdapter([{ provider: "test", id: "test-model" }]);

    await expect(adapter.run(input())).rejects.toMatchObject({
      code: "reviewer_failed",
      exitCode: 3,
    });
  });
});

function createMockPiAdapter(availableModels: unknown[]) {
  return createPiAdapter({
    async loadSdk() {
      return {
        AuthStorage: {
          inMemory() {
            return {};
          },
        },
        ModelRegistry: {
          inMemory() {
            return {
              getAvailable() {
                return availableModels;
              },
            };
          },
        },
      };
    },
  });
}

function createEnvSensitiveMockPiAdapter() {
  return createPiAdapter({
    async loadSdk() {
      return {
        AuthStorage: {
          inMemory() {
            return {};
          },
        },
        ModelRegistry: {
          inMemory() {
            return {
              getAvailable() {
                return process.env.ANTHROPIC_API_KEY
                  ? [{ provider: "anthropic", id: "claude-test" }]
                  : [];
              },
            };
          },
        },
      };
    },
  });
}

function input(): ReviewAdapterInput {
  return {
    cwd: process.cwd(),
    reviewer: {
      id: "pi",
      sdk: "pi",
      readonly: true,
    },
    target: {
      kind: "uncommitted",
      repo_root: process.cwd(),
      diff_command: "git diff",
      changed_files: [],
    },
    diff: "",
    changedFiles: [],
    prompt: "Return a minimal review result.",
    readonly: true,
    env: {},
  };
}
