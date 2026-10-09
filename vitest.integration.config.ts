import { defineConfig } from "vitest/config";

import { alias } from "./vitest.config.js";

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
