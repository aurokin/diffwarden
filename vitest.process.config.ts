import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/adapter-contract.test.ts",
      "test/claude-adapter.test.ts",
      "test/cli-adapter.test.ts",
      "test/codex-app-server-adapter.test.ts",
    ],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30_000,
    globals: true,
  },
});
