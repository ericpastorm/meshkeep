import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const source = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export const alias = {
  "@meshkeep/protocol": source("protocol"),
  "@meshkeep/kubo": source("kubo"),
  "@meshkeep/cli": source("cli"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
  },
});
