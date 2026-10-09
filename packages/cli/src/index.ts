import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_API_URL, KuboClient, KuboError } from "@meshkeep/kubo";
import {
  DEFAULT_RECORD_LIFETIME,
  DEFAULT_RECORD_TTL,
  decodeAddressBook,
  encodeAddressBook,
  ProtocolError,
  parseContentCid,
  parseIpnsName,
  parsePetname,
  removeEntry,
  setEntry,
  VERSION,
} from "@meshkeep/protocol";
import { Command, CommanderError, Option } from "commander";

import { CliError } from "./errors.js";
import { readLimitedFile } from "./files.js";
import { Keystore } from "./keystore.js";
import { AddressBookStore, ReplicaStateStore } from "./state.js";
import { publishSite, replicateSite, requireImportProfile, verifyComplete } from "./workflows.js";

export { CliError } from "./errors.js";

export const MINIMUM_NODE_MAJOR = 22;

export interface CliOptions {
  /** Environment used for MESHKEEP_HOME, MESHKEEP_API, and XDG_CONFIG_HOME. */
  env?: Record<string, string | undefined>;
  /** Receives machine-readable or primary human output. */
  stdout?: (text: string) => void;
  /** Receives diagnostics and errors. */
  stderr?: (text: string) => void;
  setExitCode?: (exitCode: number) => void;
}

interface GlobalOptions {
  api?: string;
  allowRemoteApi?: boolean;
  json?: boolean;
}

export function resolveHome(env: Record<string, string | undefined>): string {
  if (env.MESHKEEP_HOME !== undefined && env.MESHKEEP_HOME !== "") {
    return env.MESHKEEP_HOME;
  }
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "meshkeep");
}

export function isSupportedNode(version: string): boolean {
  const major = Number(/^(\d+)\./.exec(version)?.[1]);
  return Number.isSafeInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

export function createProgram(options: CliOptions = {}): Command {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const setExitCode =
    options.setExitCode ??
    ((exitCode: number) => {
      process.exitCode = exitCode;
    });
  const home = resolveHome(env);
  const keystore = new Keystore(home);
  const book = new AddressBookStore(home);
  const replicas = new ReplicaStateStore(home);

  const program = new Command()
    .name("meshkeep")
    .description("Publish static sites to IPFS under free key-based addresses and replicate them.")
    .version(VERSION)
    .option("--api <url>", `Kubo RPC URL (env MESHKEEP_API, default ${DEFAULT_API_URL})`)
    .option("--allow-remote-api", "allow a non-loopback Kubo RPC URL you have secured yourself")
    .option("--json", "print machine-readable JSON on stdout")
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr });

  const globals = () => program.opts<GlobalOptions>();
  const kubo = () =>
    new KuboClient({
      apiUrl: globals().api ?? env.MESHKEEP_API ?? DEFAULT_API_URL,
      allowRemote: globals().allowRemoteApi === true,
    });
  const log = (message: string) => stderr(`${message}\n`);

  /** Prints a result as JSON or as human-readable lines. */
  function emit(result: object, human: readonly string[]) {
    stdout(globals().json === true ? `${JSON.stringify(result)}\n` : `${human.join("\n")}\n`);
  }

  /** Wraps an action so expected failures print one line and set exit code 1. */
  function action<Args extends unknown[]>(run: (...args: Args) => Promise<void>) {
    return async (...args: Args) => {
      try {
        await run(...args);
      } catch (error) {
        if (
          error instanceof CliError ||
          error instanceof KuboError ||
          error instanceof ProtocolError
        ) {
          stderr(`meshkeep: ${error.message}\n`);
          setExitCode(1);
          return;
        }
        throw error;
      }
    };
  }

  program
    .command("version")
    .description("print the Meshkeep version")
    .action(() => stdout(`${VERSION}\n`));

  program
    .command("doctor")
    .description("check Node.js, Kubo reachability, and the import profile")
    .action(
      action(async () => {
        const node = process.versions.node;
        const nodeOk = isSupportedNode(node);
        let kuboVersion: string | undefined;
        let kuboProblem: string | undefined;
        try {
          const client = kubo();
          kuboVersion = await client.version();
          await requireImportProfile(client);
        } catch (error) {
          if (!(error instanceof KuboError || error instanceof CliError)) {
            throw error;
          }
          kuboProblem = error.message;
        }
        const ok = nodeOk && kuboProblem === undefined;
        emit(
          { ok, node, nodeOk, kuboVersion: kuboVersion ?? null, kuboProblem: kuboProblem ?? null },
          [
            `Node ${node}: ${nodeOk ? "OK" : `requires Node >=${MINIMUM_NODE_MAJOR}`}`,
            kuboProblem === undefined ? `Kubo ${kuboVersion}: OK` : `Kubo: ${kuboProblem}`,
          ],
        );
        if (!ok) {
          setExitCode(1);
        }
      }),
    );

  const key = program.command("key").description("manage site keys (a key is a site address)");

  key
    .command("create <label>")
    .description("generate a new site key and print its address")
    .action(
      action(async (label: string) => {
        const created = await keystore.create(label);
        emit({ label: created.label, name: created.name }, [created.name]);
        log(`key stored in ${keystore.directory}; back it up, it cannot be recovered`);
      }),
    );

  key
    .command("list")
    .description("list local site keys")
    .action(
      action(async () => {
        const keys = await keystore.list();
        emit(
          { keys: keys.map(({ label, name }) => ({ label, name })) },
          keys.map(({ label, name }) => `${label}\t${name}`),
        );
      }),
    );

  key
    .command("export <label> <file>")
    .description("write a key to a new private file, to move it to another publisher machine")
    .action(
      action(async (label: string, file: string) => {
        const exported = await keystore.exportFile(label, file);
        emit({ label, name: exported.name, file }, [exported.name]);
        log(
          "the file contains an unencrypted private key; move it over a secure channel and delete it",
        );
      }),
    );

  key
    .command("import <label> <file>")
    .description("import a key exported by `meshkeep key export` or `ipfs key export`")
    .action(
      action(async (label: string, file: string) => {
        const imported = await keystore.importFile(label, file);
        emit({ label, name: imported.name }, [imported.name]);
      }),
    );

  program
    .command("publish <directory>")
    .description("import a static directory and point the site address at it")
    .requiredOption("-k, --key <label>", "site key to publish under")
    .option(
      "--lifetime <duration>",
      "how long the signed record stays valid",
      DEFAULT_RECORD_LIFETIME,
    )
    .option("--ttl <duration>", "how long resolvers may cache the record", DEFAULT_RECORD_TTL)
    .option("--include-hidden", "publish dotfiles other than .well-known")
    .action(
      action(
        async (
          directory: string,
          opts: { key: string; lifetime: string; ttl: string; includeHidden?: boolean },
        ) => {
          const siteKey = await keystore.load(opts.key);
          const result = await publishSite(kubo(), siteKey, {
            directory,
            lifetime: opts.lifetime,
            ttl: opts.ttl,
            includeHidden: opts.includeHidden === true,
            log,
          });
          emit(result, [
            `name:     ${result.name}`,
            `cid:      ${result.cid}`,
            `sequence: ${result.sequence}`,
            `expires:  ${result.validity}`,
            `files:    ${result.files} (${result.blocks} blocks, ${result.bytes} bytes)`,
          ]);
        },
      ),
    );

  program
    .command("resolve <target>")
    .description("resolve a site address or petname to its current content CID")
    .action(
      action(async (target: string) => {
        const { name, petname } = await book.resolveTarget(target);
        const path = await kubo().resolveName(name);
        if (!path.startsWith("/ipfs/")) {
          throw new CliError(`${name} resolves to ${path}, not an immutable /ipfs/ path`);
        }
        const cid = parseContentCid(path);
        emit({ name, cid, ...(petname === undefined ? {} : { petname }) }, [cid]);
      }),
    );

  program
    .command("replicate <target>")
    .description("keep a complete copy of a site and keep its address alive")
    .addOption(new Option("--timeout <seconds>", "record lookup timeout").argParser(Number))
    .action(
      action(async (target: string, opts: { timeout?: number }) => {
        const { name } = await book.resolveTarget(target);
        const timeoutMs = opts.timeout === undefined ? undefined : opts.timeout * 1000;
        const result = await replicateSite(
          kubo(),
          replicas,
          name,
          timeoutMs === undefined ? {} : { timeoutMs },
        );
        emit(result, [
          `${result.updated ? "updated" : "current"} ${name}`,
          `cid:      ${result.cid} (${result.blocks} blocks, ${result.bytes} bytes, complete)`,
          `sequence: ${result.sequence}`,
          `versions: ${result.versions.length} pinned`,
        ]);
      }),
    );

  program
    .command("sync")
    .description("re-run replicate for every site this node replicates")
    .action(
      action(async () => {
        const sites = await replicas.load();
        const client = kubo();
        const results: object[] = [];
        const lines: string[] = [];
        let failed = 0;
        for (const site of sites) {
          try {
            const result = await replicateSite(client, replicas, site.name);
            results.push({ ok: true, ...result });
            lines.push(`${result.updated ? "updated" : "current"} ${site.name} ${result.cid}`);
          } catch (error) {
            if (
              !(
                error instanceof CliError ||
                error instanceof KuboError ||
                error instanceof ProtocolError
              )
            ) {
              throw error;
            }
            failed += 1;
            results.push({ ok: false, name: site.name, error: error.message });
            lines.push(`failed  ${site.name}: ${error.message}`);
          }
        }
        emit({ sites: results }, lines.length > 0 ? lines : ["no replicated sites"]);
        if (failed > 0) {
          setExitCode(1);
        }
      }),
    );

  program
    .command("verify <cid>")
    .description("check that every block of a version is stored on this node")
    .action(
      action(async (input: string) => {
        const cid = parseContentCid(input);
        const result = await verifyComplete(kubo(), cid);
        emit({ cid, ...result }, [
          result.complete
            ? `complete ${cid} (${result.blocks} blocks, ${result.bytes} bytes)`
            : `incomplete ${cid}: ${result.reason}`,
        ]);
        if (!result.complete) {
          setExitCode(1);
        }
      }),
    );

  const bookCommand = program
    .command("book")
    .description("manage your address book of petnames for site addresses");

  bookCommand
    .command("add <petname> <name>")
    .description("give a site address a local petname")
    .option("--note <text>", "short description")
    .option("--replace", "overwrite an existing petname")
    .action(
      action(async (petname: string, name: string, opts: { note?: string; replace?: boolean }) => {
        const entry = {
          petname: parsePetname(petname),
          name: parseIpnsName(name),
          ...(opts.note === undefined ? {} : { note: opts.note }),
        };
        await book.save(setEntry(await book.load(), entry, { replace: opts.replace === true }));
        emit(entry, [`${entry.petname} -> ${entry.name}`]);
      }),
    );

  bookCommand
    .command("remove <petname>")
    .description("remove a petname")
    .action(
      action(async (petname: string) => {
        await book.save(removeEntry(await book.load(), parsePetname(petname)));
        emit({ petname }, [`removed ${petname}`]);
      }),
    );

  bookCommand
    .command("list")
    .description("list petnames")
    .action(
      action(async () => {
        const { entries } = await book.load();
        emit(
          { entries },
          entries.length === 0
            ? ["address book is empty"]
            : entries.map(
                (e) => `${e.petname}\t${e.name}${e.note === undefined ? "" : `\t${e.note}`}`,
              ),
        );
      }),
    );

  bookCommand
    .command("export")
    .description("print the address book in its canonical shareable format")
    .action(
      action(async () => {
        stdout(encodeAddressBook(await book.load()));
      }),
    );

  bookCommand
    .command("import <file>")
    .description("merge entries from a shared address book file")
    .option("--replace", "overwrite petnames that already exist")
    .action(
      action(async (file: string, opts: { replace?: boolean }) => {
        const incoming = decodeAddressBook(
          (await readLimitedFile(file, 4 * 1024 * 1024)).toString("utf8"),
        );
        let merged = await book.load();
        for (const entry of incoming.entries) {
          merged = setEntry(merged, entry, { replace: opts.replace === true });
        }
        await book.save(merged);
        emit({ imported: incoming.entries.length }, [
          `imported ${incoming.entries.length} entries`,
        ]);
      }),
    );

  return program;
}

export async function runCli(argv = process.argv, options: CliOptions = {}): Promise<void> {
  const setExitCode =
    options.setExitCode ??
    ((exitCode: number) => {
      process.exitCode = exitCode;
    });
  try {
    await createProgram(options).parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      setExitCode(error.exitCode);
      return;
    }
    throw error;
  }
}
