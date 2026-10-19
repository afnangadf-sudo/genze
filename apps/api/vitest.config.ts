import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
