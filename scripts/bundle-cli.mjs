// Bundles the meshkeep CLI and its dependencies into one self-contained ES module for the
// container image, so the runtime image needs Node.js and nothing else.
import { build } from "esbuild";

const outfile = process.argv[2] ?? "dist/meshkeep.mjs";

await build({
  entryPoints: ["packages/cli/src/bin.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Resolve workspace packages from their TypeScript sources, as tests and typecheck do.
  conditions: ["development"],
  // commander is CommonJS; give its `require` calls a real require inside the ES module.
  banner: {
    js: 'import { createRequire as __meshkeepCreateRequire } from "node:module";\nconst require = __meshkeepCreateRequire(import.meta.url);',
  },
  legalComments: "linked",
  logLevel: "warning",
});
process.stdout.write(`bundled ${outfile}\n`);
