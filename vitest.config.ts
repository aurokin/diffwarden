import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**/*.test.ts", "test/live/**/*.test.ts"],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
    },
    globals: true,
  },
});
