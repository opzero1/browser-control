import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 10000,
    globalSetup: ["tests/server/support/global-setup.ts"]
  }
});
