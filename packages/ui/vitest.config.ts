import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.*", "src/test-setup.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // §5.12: packages/ui ≥ 80 % line coverage. check-coverage.mjs re-asserts this
      // when aggregating, so CI fails even if a package skips its own run.
      thresholds: { lines: 80 },
    },
  },
});
