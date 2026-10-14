// Builds the unpacked extension into dist/: one bundled script per entry point, the static pages,
// the manifest stamped with the package version, and the licenses of everything bundled.
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "dist"));
const pkg = JSON.parse(await readFile(join(here, "package.json"), "utf8"));

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "licenses"), { recursive: true });

const result = await build({
  entryPoints: ["background", "popup", "book"].map((name) => join(here, "src", `${name}.ts`)),
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  // Resolve workspace packages from their TypeScript sources, as tests and typecheck do.
  conditions: ["development"],
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});

await cp(join(here, "static"), out, { recursive: true });

// Chrome wants up to four dot-separated integers; a prerelease goes in version_name.
const manifest = JSON.parse(await readFile(join(here, "manifest.json"), "utf8"));
manifest.version = pkg.version.replace(/-.*$/, "");
if (manifest.version !== pkg.version) {
  manifest.version_name = pkg.version;
}
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// The license of every third-party package that ended up in a bundle, plus Meshkeep's own.
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match !== null) {
    packageRoots.add(resolve(match[1]));
  }
}
await copyFile(join(here, "..", "..", "LICENSE"), join(out, "licenses", "meshkeep.txt"));
for (const root of packageRoots) {
  const { name } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const license = (await readdir(root)).find((file) => /^licen[cs]e/i.test(file));
  if (license === undefined) {
    throw new Error(`no license file in ${root}`);
  }
  await copyFile(join(root, license), join(out, "licenses", `${name.replace("/", "__")}.txt`));
}

process.stdout.write(`built extension ${pkg.version} in ${out}\n`);
