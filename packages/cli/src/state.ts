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
  /**
   * The operator asked for this site with `replicate`. A site that is neither manual nor
   * tracked by a followed book is no longer wanted (ADR 0003).
   */
  readonly manual: boolean;
}

/** A followed address book (ADR 0003): replicate its curator's site and every listed site. */
export interface FollowedBook extends ReplicaLimits {
  /** The curator's address; the book is published inside this site. */
  readonly curator: string;
  /** A book listing more sites than this is refused as a whole. */
  readonly maxSites: number;
  /** Retention for sites this follow adds. */
  readonly keep: number;
  /** Version of the curator's site the book was last read from. */
  readonly bookCid: string;
  /** Addresses the book listed when it was last read successfully. */
  readonly sites: readonly string[];
}

export interface ReplicaState {
  readonly sites: readonly ReplicatedSite[];
  readonly follows: readonly FollowedBook[];
}

/** Every address a follow keeps replicated: its curator's site and what its book lists. */
export function trackedBy(follow: FollowedBook): readonly string[] {
  return [...new Set([follow.curator, ...follow.sites])];
}

/** The follows that keep `name` replicated, in a stable order. */
export function followsTracking(state: ReplicaState, name: string): FollowedBook[] {
  return state.follows
    .filter((follow) => trackedBy(follow).includes(name))
    .sort((left, right) => (left.curator < right.curator ? -1 : 1));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseLimits(entry: Record<string, unknown>): ReplicaLimits & { keep: number } {
  // Fields added after the first release of this file. Absent limits mean the defaults, and
  // absent `keep` means keep everything.
  const maxBytes = entry.maxBytes ?? DEFAULT_REPLICA_LIMITS.maxBytes;
  const maxBlocks = entry.maxBlocks ?? DEFAULT_REPLICA_LIMITS.maxBlocks;
  const keep = entry.keep ?? 0;
  if (!isPositiveInteger(maxBytes) || !isPositiveInteger(maxBlocks)) {
    throw new Error("invalid limits");
  }
  if (!(keep === 0 || isPositiveInteger(keep))) {
    throw new Error("invalid keep");
  }
  return { maxBytes, maxBlocks, keep };
}

function parseSite(site: Record<string, unknown>): ReplicatedSite {
  const sequence = site.sequence;
  // Absent `ownedPins` means no pin is known to be ours, so nothing is ever unpinned for such
  // a site. Sites recorded before follows existed were all asked for manually.
  const ownedPins = site.ownedPins ?? [];
  const manual = site.manual ?? true;
  if (
    typeof site.name !== "string" ||
    typeof site.cid !== "string" ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    typeof site.validity !== "string" ||
    !Array.isArray(site.versions) ||
    !Array.isArray(ownedPins) ||
    typeof manual !== "boolean"
  ) {
    throw new Error("invalid site entry");
  }
  return {
    name: parseIpnsName(site.name),
    cid: parseContentCid(site.cid),
    sequence,
    validity: site.validity,
    versions: site.versions.map((cid: unknown) => parseContentCid(String(cid))),
    ...parseLimits(site),
    ownedPins: ownedPins.map((cid: unknown) => parseContentCid(String(cid))),
    manual,
  };
}

function parseFollow(follow: Record<string, unknown>): FollowedBook {
  if (
    typeof follow.curator !== "string" ||
    !isPositiveInteger(follow.maxSites) ||
    typeof follow.bookCid !== "string" ||
    !Array.isArray(follow.sites)
  ) {
    throw new Error("invalid follow entry");
  }
  return {
    curator: parseIpnsName(follow.curator),
    maxSites: follow.maxSites,
    ...parseLimits(follow),
    bookCid: parseContentCid(follow.bookCid),
    sites: follow.sites.map((name: unknown) => parseIpnsName(String(name))),
  };
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name < right.name ? -1 : 1;

/** Local, non-protocol bookkeeping for the sites this node replicates and the books it follows. */
export class ReplicaStateStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, "replicas.json");
  }

  async read(): Promise<ReplicaState> {
    const text = await readOptionalText(this.path, MAX_STATE_BYTES);
    if (text === undefined) {
      return { sites: [], follows: [] };
    }
    try {
      const value = JSON.parse(text) as { format?: unknown; sites?: unknown; follows?: unknown };
      const follows = value.follows ?? [];
      if (
        value.format !== REPLICA_STATE_FORMAT ||
        !Array.isArray(value.sites) ||
        !Array.isArray(follows)
      ) {
        throw new Error("unexpected format");
      }
      return { sites: value.sites.map(parseSite), follows: follows.map(parseFollow) };
    } catch (error) {
      throw new CliError(`corrupt replica state ${this.path}: ${(error as Error).message}`);
    }
  }

  /** The replicated sites only. */
  async load(): Promise<readonly ReplicatedSite[]> {
    return (await this.read()).sites;
  }

  /**
   * Runs a read-modify-write of the replica state while holding its lock, so a daemon and a
   * manual command never overwrite each other's changes.
   */
  async locked<T>(task: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
    return withFileLock(`${this.path}.lock`, task, options);
  }

  async write(state: ReplicaState): Promise<void> {
    const sites = [...state.sites].sort(byName);
    const follows = [...state.follows].sort((left, right) =>
      left.curator < right.curator ? -1 : 1,
    );
    const text = JSON.stringify({ format: REPLICA_STATE_FORMAT, sites, follows }, null, 2);
    await writePrivateFile(this.path, `${text}\n`);
  }
}
