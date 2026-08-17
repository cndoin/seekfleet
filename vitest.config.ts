import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"],
      thresholds: {
        statements: 45,
        branches: 40,
        functions: 45,
        lines: 50,
      },
    },
    environment: "node",
    testTimeout: 10000,
  },
});
