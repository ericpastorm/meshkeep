import { join } from "node:path";

import {
  type AddressBook,
  createAddressBook,
  decodeAddressBook,
  encodeAddressBook,
  findEntry,
  isIpnsName,
  MAX_ADDRESS_BOOK_BYTES,
  parseContentCid,
  parseIpnsName,
  parsePetname,
} from "@meshkeep/protocol";

import { CliError } from "./errors.js";
import { readOptionalText, writePrivateFile } from "./files.js";

const REPLICA_STATE_FORMAT = "meshkeep-replica-state-v1";
const MAX_STATE_BYTES = 16 * 1024 * 1024;

export class AddressBookStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, "address-book.json");
  }

  async load(): Promise<AddressBook> {
    const text = await readOptionalText(this.path, MAX_ADDRESS_BOOK_BYTES);
    return text === undefined ? createAddressBook() : decodeAddressBook(text);
  }

  async save(book: AddressBook): Promise<void> {
    await writePrivateFile(this.path, encodeAddressBook(book));
  }

  /** Resolves a user-supplied target, which is either an IPNS name or a known petname. */
  async resolveTarget(target: string): Promise<{ name: string; petname?: string }> {
    if (isIpnsName(target)) {
      return { name: parseIpnsName(target) };
    }
    const petname = parsePetname(target);
    const entry = findEntry(await this.load(), petname);
    if (entry === undefined) {
      throw new CliError(`unknown petname ${petname}; add it with \`meshkeep book add\``);
    }
    return { name: entry.name, petname };
  }
}

export interface ReplicatedSite {
  readonly name: string;
  /** CID selected by the newest record this replica has verified. */
  readonly cid: string;
  readonly sequence: number;
  /** Record expiry (EOL) reported by Kubo. */
  readonly validity: string;
  /** Every version this replica keeps pinned, oldest first. */
  readonly versions: readonly string[];
}

/** Local, non-protocol bookkeeping for the sites this node replicates. */
export class ReplicaStateStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, "replicas.json");
  }

  async load(): Promise<ReplicatedSite[]> {
    const text = await readOptionalText(this.path, MAX_STATE_BYTES);
    if (text === undefined) {
      return [];
    }
    try {
      const value = JSON.parse(text) as { format?: unknown; sites?: unknown };
      if (value.format !== REPLICA_STATE_FORMAT || !Array.isArray(value.sites)) {
        throw new Error("unexpected format");
      }
      return value.sites.map((site: Record<string, unknown>) => {
        const sequence = site.sequence;
        if (
          typeof site.name !== "string" ||
          typeof site.cid !== "string" ||
          typeof sequence !== "number" ||
          !Number.isSafeInteger(sequence) ||
          typeof site.validity !== "string" ||
          !Array.isArray(site.versions)
        ) {
          throw new Error("invalid site entry");
        }
        return {
          name: parseIpnsName(site.name),
          cid: parseContentCid(site.cid),
          sequence,
          validity: site.validity,
          versions: site.versions.map((cid: unknown) => parseContentCid(String(cid))),
        };
      });
    } catch (error) {
      throw new CliError(`corrupt replica state ${this.path}: ${(error as Error).message}`);
    }
  }

  async save(sites: readonly ReplicatedSite[]): Promise<void> {
    const sorted = [...sites].sort((left, right) => (left.name < right.name ? -1 : 1));
    const text = JSON.stringify({ format: REPLICA_STATE_FORMAT, sites: sorted }, null, 2);
    await writePrivateFile(this.path, `${text}\n`);
  }
}
