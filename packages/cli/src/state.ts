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
import { readOptionalText, withFileLock, writePrivateFile } from "./files.js";
import { MAX_SITE_BYTES } from "./site.js";

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

/** Per-site resource bounds a replica enforces while fetching a version. */
export interface ReplicaLimits {
  readonly maxBytes: number;
  readonly maxBlocks: number;
}

/** Any site `meshkeep publish` accepts (2 GiB, 100,000 files) fits within these defaults. */
export const DEFAULT_REPLICA_LIMITS: ReplicaLimits = {
  maxBytes: MAX_SITE_BYTES,
  maxBlocks: 250_000,
};

export interface ReplicatedSite extends ReplicaLimits {
  readonly name: string;
  /** CID selected by the newest record this replica has verified. */
  readonly cid: string;
  readonly sequence: number;
  /** Record expiry (EOL) reported by Kubo. */
  readonly validity: string;
  /** Versions this replica keeps, least recently current first; the last one is `cid`. */
  readonly versions: readonly string[];
  /** How many versions to keep; 0 keeps every version. */
  readonly keep: number;
  /**
   * Versions whose pin this replica created. Only these are ever unpinned, so a pin the
   * operator or `meshkeep publish` made on the same node is never removed.
   */
  readonly ownedPins: readonly string[];
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
        // Fields added after the first release of this file. Absent limits mean the defaults,
        // absent `keep` means keep everything, and absent `ownedPins` means no pin is known to
        // be ours, so nothing is ever unpinned for such a site.
        const maxBytes = site.maxBytes ?? DEFAULT_REPLICA_LIMITS.maxBytes;
        const maxBlocks = site.maxBlocks ?? DEFAULT_REPLICA_LIMITS.maxBlocks;
        const keep = site.keep ?? 0;
        const ownedPins = site.ownedPins ?? [];
        if (
          typeof site.name !== "string" ||
          typeof site.cid !== "string" ||
          typeof sequence !== "number" ||
          !Number.isSafeInteger(sequence) ||
          typeof site.validity !== "string" ||
          !Array.isArray(site.versions) ||
          !isPositiveInteger(maxBytes) ||
          !isPositiveInteger(maxBlocks) ||
          !(keep === 0 || isPositiveInteger(keep)) ||
          !Array.isArray(ownedPins)
        ) {
          throw new Error("invalid site entry");
        }
        return {
          name: parseIpnsName(site.name),
          cid: parseContentCid(site.cid),
          sequence,
          validity: site.validity,
          versions: site.versions.map((cid: unknown) => parseContentCid(String(cid))),
          maxBytes,
          maxBlocks,
          keep,
          ownedPins: ownedPins.map((cid: unknown) => parseContentCid(String(cid))),
        };
      });
    } catch (error) {
      throw new CliError(`corrupt replica state ${this.path}: ${(error as Error).message}`);
    }
  }

  /**
   * Runs a read-modify-write of the replica state while holding its lock, so a daemon and a
   * manual command never overwrite each other's changes.
   */
  async locked<T>(task: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
    return withFileLock(`${this.path}.lock`, task, options);
  }

  async save(sites: readonly ReplicatedSite[]): Promise<void> {
    const sorted = [...sites].sort((left, right) => (left.name < right.name ? -1 : 1));
    const text = JSON.stringify({ format: REPLICA_STATE_FORMAT, sites: sorted }, null, 2);
    await writePrivateFile(this.path, `${text}\n`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
