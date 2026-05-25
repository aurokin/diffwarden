import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/git.test.ts"],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30_000,
    globals: true,
  },
});
