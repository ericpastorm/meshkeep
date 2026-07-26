import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typescriptCli = fileURLToPath(import.meta.resolve("typescript/lib/tsc.js"));
const expectedVersionOutput = "0.0.0\n";
const expectedPnpmVersionOutput = "10.34.5\n";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function pathExists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runCommand(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolveResult({ signal, status, stderr, stdout });
    });
  });
}

function commandFailure(label, result) {
  const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
  return `${label} failed (status ${String(result.status)}, signal ${String(result.signal)}): ${detail}`;
}

async function requireSuccessfulCommand(command, args, options) {
  const result = await runCommand(command, args, options);
  assert(result.status === 0 && result.signal === null, commandFailure(options.label, result));
  return result;
}

async function requireExactCommand(command, args, options) {
  const result = await requireSuccessfulCommand(command, args, options);
  assert(
    result.stdout === options.stdout,
    `${options.label} stdout was ${JSON.stringify(result.stdout)}`,
  );
  assert(
    result.stderr === (options.stderr ?? ""),
    `${options.label} stderr was ${JSON.stringify(result.stderr)}`,
  );
}

async function assertPackageTarget(packageDirectory, target, label, expectedRoot) {
  assert(typeof target === "string", `${label} must be a string target`);

  const targetPath = resolve(packageDirectory, target);
  const relativeTarget = relative(packageDirectory, targetPath);
  assert(
    relativeTarget !== "" && !relativeTarget.startsWith("..") && !isAbsolute(relativeTarget),
    `${label} escapes its package: ${target}`,
  );
  assert(relativeTarget.split(sep)[0] === expectedRoot, `${label} must be under ${expectedRoot}`);
  assert(await pathExists(targetPath), `${label} does not exist: ${target}`);

  return targetPath;
}

async function packPackage(pnpmCli, packageDirectory, destination, label) {
  const before = new Set(await readdir(destination));
  await requireSuccessfulCommand(
    process.execPath,
    [pnpmCli, "--reporter=silent", "pack", "--pack-destination", destination],
    { cwd: packageDirectory, label: `pack ${label}` },
  );
  const tarballs = (await readdir(destination)).filter(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  assert(tarballs.length === 1, `pack ${label} produced ${tarballs.length} new tarballs`);
  return join(destination, tarballs[0]);
}

function localTarballSpec(consumerDirectory, tarball) {
  return `file:${relative(consumerDirectory, tarball).split(sep).join("/")}`;
}

function normalizedTrace(output) {
  return output.split(sep).join("/");
}

async function assertTypeScriptResolution(consumerDirectory, configFile, expectedTargets, label) {
  const result = await requireSuccessfulCommand(
    process.execPath,
    [typescriptCli, "--project", configFile, "--traceResolution", "--pretty", "false"],
    { cwd: consumerDirectory, label },
  );
  const trace = normalizedTrace(result.stdout);
  for (const target of expectedTargets) {
    assert(trace.includes(target), `${label} did not resolve ${target}`);
  }
}

async function main() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "meshkeep-artifact-smoke-"));

  try {
    const pnpmCli = process.env.npm_execpath;
    assert(pnpmCli, "artifact smoke must run through the pinned pnpm package script");
    assert(await pathExists(pnpmCli), `currently executing pnpm CLI does not exist: ${pnpmCli}`);
    await requireExactCommand(process.execPath, [pnpmCli, "--version"], {
      cwd: repositoryRoot,
      label: "pinned pnpm version",
      stdout: expectedPnpmVersionOutput,
    });

    const protocolDirectory = join(repositoryRoot, "packages", "protocol");
    const cliDirectory = join(repositoryRoot, "packages", "cli");
    const protocolManifest = await readJson(join(protocolDirectory, "package.json"));
    const cliManifest = await readJson(join(cliDirectory, "package.json"));
    const protocolExport = protocolManifest.exports?.["."];
    const cliExport = cliManifest.exports?.["."];
    const cliBinTarget = cliManifest.bin?.meshkeep;

    assert(
      JSON.stringify([...protocolManifest.files].sort()) ===
        JSON.stringify(["dist", "src/index.ts"]),
      `protocol files payload was ${JSON.stringify(protocolManifest.files)}`,
    );
    assert(
      JSON.stringify(cliManifest.files) === JSON.stringify(["dist"]),
      `CLI files payload was ${JSON.stringify(cliManifest.files)}`,
    );

    await assertPackageTarget(
      protocolDirectory,
      protocolExport?.types,
      "protocol types export",
      "dist",
    );
    const protocolRuntimeTarget = await assertPackageTarget(
      protocolDirectory,
      protocolExport?.import,
      "protocol runtime export",
      "dist",
    );
    await assertPackageTarget(
      protocolDirectory,
      protocolExport?.development?.types,
      "protocol development types export",
      "src",
    );
    await assertPackageTarget(
      protocolDirectory,
      protocolExport?.development?.import,
      "protocol development runtime export",
      "dist",
    );
    await assertPackageTarget(cliDirectory, cliExport?.types, "CLI types export", "dist");
    const cliRuntimeTarget = await assertPackageTarget(
      cliDirectory,
      cliExport?.import,
      "CLI runtime export",
      "dist",
    );
    const cliEntryPoint = await assertPackageTarget(
      cliDirectory,
      cliBinTarget,
      "CLI bin target",
      "dist",
    );

    const protocolModule = await import(pathToFileURL(protocolRuntimeTarget).href);
    const cliModule = await import(pathToFileURL(cliRuntimeTarget).href);
    assert(protocolModule.VERSION === "0.0.0", "protocol runtime export has the wrong version");
    assert(typeof cliModule.createProgram === "function", "CLI runtime export lacks createProgram");
    assert(
      typeof cliModule.getDoctorReport === "function",
      "CLI runtime export lacks getDoctorReport",
    );
    assert(typeof cliModule.runCli === "function", "CLI runtime export lacks runCli");

    const firstLine = (await readFile(cliEntryPoint, "utf8")).split(/\r?\n/, 1)[0];
    assert(firstLine === "#!/usr/bin/env node", "CLI bin target is missing its Node shebang");

    await requireExactCommand(process.execPath, [cliEntryPoint, "version"], {
      cwd: temporaryDirectory,
      label: "direct built CLI",
      stdout: expectedVersionOutput,
    });
    const symlinkPath = join(temporaryDirectory, "meshkeep-symlink.js");
    await symlink(cliEntryPoint, symlinkPath, "file");
    await requireExactCommand(process.execPath, [symlinkPath, "version"], {
      cwd: temporaryDirectory,
      label: "symlinked built CLI",
      stdout: expectedVersionOutput,
    });

    const artifactDirectory = join(temporaryDirectory, "artifacts");
    const consumerDirectory = join(temporaryDirectory, "consumer");
    await mkdir(artifactDirectory);
    await mkdir(consumerDirectory);
    const protocolTarball = await packPackage(
      pnpmCli,
      protocolDirectory,
      artifactDirectory,
      "protocol",
    );
    const cliTarball = await packPackage(pnpmCli, cliDirectory, artifactDirectory, "CLI");
    const protocolTarballSpec = localTarballSpec(consumerDirectory, protocolTarball);

    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "meshkeep-artifact-consumer",
          version: "0.0.0",
          private: true,
          type: "module",
          packageManager: "pnpm@10.34.5",
          dependencies: {
            "@meshkeep/cli": localTarballSpec(consumerDirectory, cliTarball),
            "@meshkeep/protocol": protocolTarballSpec,
          },
          pnpm: {
            overrides: {
              "@meshkeep/protocol": protocolTarballSpec,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const installEnvironment = { ...process.env, CI: "true", NO_COLOR: "1" };
    await requireSuccessfulCommand(
      process.execPath,
      [
        pnpmCli,
        "install",
        "--lockfile-only",
        "--offline",
        "--ignore-scripts",
        "--config.engine-strict=true",
      ],
      { cwd: consumerDirectory, env: installEnvironment, label: "offline consumer lock" },
    );
    await requireSuccessfulCommand(
      process.execPath,
      [
        pnpmCli,
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.engine-strict=true",
      ],
      { cwd: consumerDirectory, env: installEnvironment, label: "frozen offline consumer install" },
    );

    const installedProtocolDirectory = join(
      consumerDirectory,
      "node_modules",
      "@meshkeep",
      "protocol",
    );
    const installedCliDirectory = join(consumerDirectory, "node_modules", "@meshkeep", "cli");
    const installedProtocolManifest = await readJson(
      join(installedProtocolDirectory, "package.json"),
    );
    const installedCliManifest = await readJson(join(installedCliDirectory, "package.json"));
    const installedProtocolExport = installedProtocolManifest.exports?.["."];
    const installedCliExport = installedCliManifest.exports?.["."];

    await assertPackageTarget(
      installedProtocolDirectory,
      installedProtocolExport?.types,
      "installed protocol types export",
      "dist",
    );
    await assertPackageTarget(
      installedProtocolDirectory,
      installedProtocolExport?.import,
      "installed protocol runtime export",
      "dist",
    );
    await assertPackageTarget(
      installedProtocolDirectory,
      installedProtocolExport?.development?.types,
      "installed protocol development types export",
      "src",
    );
    await assertPackageTarget(
      installedProtocolDirectory,
      installedProtocolExport?.development?.import,
      "installed protocol development runtime export",
      "dist",
    );
    await assertPackageTarget(
      installedCliDirectory,
      installedCliExport?.types,
      "installed CLI types export",
      "dist",
    );
    await assertPackageTarget(
      installedCliDirectory,
      installedCliExport?.import,
      "installed CLI runtime export",
      "dist",
    );
    await assertPackageTarget(
      installedCliDirectory,
      installedCliManifest.bin?.meshkeep,
      "installed CLI bin target",
      "dist",
    );

    const installedProtocolSourceEntries = await readdir(join(installedProtocolDirectory, "src"));
    assert(
      installedProtocolSourceEntries.length === 1 &&
        installedProtocolSourceEntries[0] === "index.ts",
      `protocol source payload was ${JSON.stringify(installedProtocolSourceEntries)}`,
    );
    assert(
      !(await pathExists(join(installedProtocolDirectory, "codemap.md"))),
      "protocol artifact unexpectedly contains its codemap",
    );

    const defaultImportScript = join(consumerDirectory, "default-imports.mjs");
    await writeFile(
      defaultImportScript,
      `import { VERSION as protocolVersion } from "@meshkeep/protocol";\nimport { createProgram, getDoctorReport, runCli } from "@meshkeep/cli";\nif (!import.meta.resolve("@meshkeep/protocol").endsWith("/dist/index.js")) throw new Error("protocol default condition did not resolve dist");\nif (!import.meta.resolve("@meshkeep/cli").endsWith("/dist/index.js")) throw new Error("CLI default condition did not resolve dist");\nif (protocolVersion !== "0.0.0" || typeof createProgram !== "function" || typeof getDoctorReport !== "function" || typeof runCli !== "function") throw new Error("default package exports are incomplete");\nprocess.stdout.write("Default package imports: PASS\\n");\n`,
      "utf8",
    );
    await requireExactCommand(process.execPath, [defaultImportScript], {
      cwd: consumerDirectory,
      label: "installed default package imports",
      stdout: "Default package imports: PASS\n",
    });

    const developmentImportScript = join(consumerDirectory, "development-import.mjs");
    await writeFile(
      developmentImportScript,
      `import { VERSION } from "@meshkeep/protocol";\nif (!import.meta.resolve("@meshkeep/protocol").endsWith("/dist/index.js")) throw new Error("protocol development runtime did not resolve built JS");\nif (VERSION !== "0.0.0") throw new Error("protocol development export has the wrong version");\nprocess.stdout.write("Protocol development import: PASS\\n");\n`,
      "utf8",
    );
    await requireExactCommand(
      process.execPath,
      ["--conditions=development", developmentImportScript],
      {
        cwd: consumerDirectory,
        label: "installed protocol development import",
        stdout: "Protocol development import: PASS\n",
      },
    );

    const hostileImportScript = join(consumerDirectory, "hostile-cli-import.mjs");
    await writeFile(
      hostileImportScript,
      `import { fileURLToPath } from "node:url";\nconst runtimeEntry = fileURLToPath(import.meta.resolve("@meshkeep/cli"));\nprocess.argv.splice(0, process.argv.length, process.execPath, runtimeEntry, "--hostile-argument");\nconst cli = await import("@meshkeep/cli");\nif (typeof cli.runCli !== "function") throw new Error("CLI import is incomplete");\nprocess.stdout.write("CLI side-effect import: PASS\\n");\n`,
      "utf8",
    );
    await requireExactCommand(process.execPath, [hostileImportScript], {
      cwd: consumerDirectory,
      label: "hostile installed CLI import",
      stdout: "CLI side-effect import: PASS\n",
    });

    const typeConsumerFile = join(consumerDirectory, "consumer.ts");
    await writeFile(
      typeConsumerFile,
      `import { type CliOptions } from "@meshkeep/cli";\nimport { type DeploymentManifestV1, SCHEMA_ID, UNIXFS_PROFILE } from "@meshkeep/protocol";\nconst options: CliOptions = {};\nconst manifest: DeploymentManifestV1 = { schema: SCHEMA_ID, siteId: "smoke", sequence: 0, contentCid: "cid", previousManifestCid: null, createdAt: "2026-07-26T00:00:00.000Z", unixfsProfile: UNIXFS_PROFILE, stats: { files: 1, bytes: 1 } };\nvoid options;\nvoid manifest;\n`,
      "utf8",
    );
    const baseTypeScriptConfig = {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2023",
      },
      files: ["consumer.ts"],
    };
    const normalTypeScriptConfig = join(consumerDirectory, "tsconfig.normal.json");
    await writeFile(
      normalTypeScriptConfig,
      `${JSON.stringify(baseTypeScriptConfig, null, 2)}\n`,
      "utf8",
    );
    const developmentTypeScriptConfig = join(consumerDirectory, "tsconfig.development.json");
    await writeFile(
      developmentTypeScriptConfig,
      `${JSON.stringify(
        {
          ...baseTypeScriptConfig,
          compilerOptions: {
            ...baseTypeScriptConfig.compilerOptions,
            customConditions: ["development"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await assertTypeScriptResolution(
      consumerDirectory,
      normalTypeScriptConfig,
      ["@meshkeep/cli/dist/index.d.ts", "@meshkeep/protocol/dist/index.d.ts"],
      "normal TypeScript package resolution",
    );
    await assertTypeScriptResolution(
      consumerDirectory,
      developmentTypeScriptConfig,
      ["@meshkeep/cli/dist/index.d.ts", "@meshkeep/protocol/src/index.ts"],
      "development TypeScript package resolution",
    );

    const installedBinShim = join(consumerDirectory, "node_modules", ".bin", "meshkeep");
    assert(await pathExists(installedBinShim), "installed meshkeep bin shim does not exist");
    await requireExactCommand(installedBinShim, ["version"], {
      cwd: consumerDirectory,
      label: "installed meshkeep bin shim",
      stdout: expectedVersionOutput,
    });

    process.stdout.write("Artifact smoke check: PASS\n");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Artifact smoke check: FAIL: ${message}\n`);
  process.exitCode = 1;
});
