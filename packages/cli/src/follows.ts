import { type KuboClient, KuboError } from "@meshkeep/kubo";
import {
  type AddressBook,
  decodeAddressBook,
  MAX_ADDRESS_BOOK_BYTES,
  ProtocolError,
  PUBLISHED_ADDRESS_BOOK_PATH,
} from "@meshkeep/protocol";

import { CliError } from "./errors.js";
import {
  DEFAULT_REPLICA_LIMITS,
  type FollowedBook,
  type ReplicaLimits,
  type ReplicaStateStore,
  trackedBy,
} from "./state.js";
import {
  dropUnwantedLocked,
  type ReplicateOptions,
  type ReplicateResult,
  replicateSite,
  type UnreplicateResult,
} from "./workflows.js";

export const DEFAULT_MAX_SITES = 100;

/**
 * Reads the address book a site publishes (ADR 0003) from local blocks only, so it comes from
 * the version this replica has just verified and stored completely.
 */
export async function readPublishedBook(kubo: KuboClient, cid: string): Promise<AddressBook> {
  let bytes: Uint8Array;
  try {
    bytes = await kubo.cat(`/ipfs/${cid}/${PUBLISHED_ADDRESS_BOOK_PATH}`, {
      offline: true,
      length: MAX_ADDRESS_BOOK_BYTES + 1,
    });
  } catch (error) {
    if (error instanceof KuboError) {
      throw new CliError(`${cid} has no published address book at ${PUBLISHED_ADDRESS_BOOK_PATH}`);
    }
    throw error;
  }
  if (bytes.length > MAX_ADDRESS_BOOK_BYTES) {
    throw new CliError(
      `the published address book in ${cid} exceeds ${MAX_ADDRESS_BOOK_BYTES} bytes`,
    );
  }
  try {
    return decodeAddressBook(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ProtocolError || error instanceof TypeError) {
      throw new CliError(`the published address book in ${cid} is invalid: ${error.message}`);
    }
    throw error;
  }
}

export interface FollowSettings {
  readonly maxSites?: number;
  readonly limits?: Partial<ReplicaLimits>;
  readonly keep?: number;
}

export interface RefreshResult {
  readonly curator: string;
  readonly bookCid: string;
  readonly sites: readonly string[];
  /** Addresses the book lists now and did not list before. */
  readonly added: readonly string[];
  /** Addresses the book no longer lists. */
  readonly removed: readonly string[];
  /** Sites dropped from this replica as a result. */
  readonly dropped: readonly UnreplicateResult[];
}

/**
 * Re-reads a followed book: replicate the curator's site, read its book from the verified
 * version, and update what the follow tracks. Sites the book stopped listing are dropped when
 * nothing else wants them. On any failure the follow keeps its last known list, so an outage
 * or a withheld book never makes a replica drop sites (ADR 0003).
 */
export async function refreshFollow(
  kubo: KuboClient,
  store: ReplicaStateStore,
  curator: string,
  options: Omit<ReplicateOptions, "manual" | "requestedBy" | "limits" | "keep"> & {
    settings?: FollowSettings;
  } = {},
): Promise<RefreshResult> {
  const { settings = {}, ...replicateBase } = options;
  const existing = (await store.read()).follows.find((follow) => follow.curator === curator);
  const draft: FollowedBook = {
    curator,
    maxSites: settings.maxSites ?? existing?.maxSites ?? DEFAULT_MAX_SITES,
    maxBytes: settings.limits?.maxBytes ?? existing?.maxBytes ?? DEFAULT_REPLICA_LIMITS.maxBytes,
    maxBlocks:
      settings.limits?.maxBlocks ?? existing?.maxBlocks ?? DEFAULT_REPLICA_LIMITS.maxBlocks,
    keep: settings.keep ?? existing?.keep ?? 0,
    bookCid: existing?.bookCid ?? "",
    sites: existing?.sites ?? [],
  };
  const curatorSite = await replicateSite(kubo, store, curator, {
    ...replicateBase,
    requestedBy: draft,
  });
  const book = await readPublishedBook(kubo, curatorSite.cid);
  const sites = [...new Set(book.entries.map((entry) => entry.name))].sort();
  if (sites.length > draft.maxSites) {
    throw new CliError(
      `the book of ${curator} lists ${sites.length} sites, over this follow's limit of ` +
        `${draft.maxSites}; nothing changed (raise --max-sites to accept it)`,
    );
  }

  return store.locked(async () => {
    const state = await store.read();
    const previous = state.follows.find((follow) => follow.curator === curator)?.sites ?? [];
    const follow: FollowedBook = { ...draft, bookCid: curatorSite.cid, sites };
    await store.write({
      ...state,
      follows: [...state.follows.filter((candidate) => candidate.curator !== curator), follow],
    });
    const dropped = await dropUnwantedLocked(kubo, store);
    return {
      curator,
      bookCid: curatorSite.cid,
      sites,
      added: sites.filter((name) => !previous.includes(name)),
      removed: previous.filter((name) => !sites.includes(name)),
      dropped,
    };
  });
}

export interface SiteOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly result?: ReplicateResult;
  readonly error?: string;
}

function isOperationalError(error: unknown): error is Error {
  return error instanceof CliError || error instanceof KuboError || error instanceof ProtocolError;
}

/**
 * Starts (or updates) following a curator's book and replicates every site it lists now. A
 * listed site that fails is reported and retried by later syncs; it does not fail the follow.
 * If the book cannot be read the first time, nothing is recorded.
 */
export async function followBook(
  kubo: KuboClient,
  store: ReplicaStateStore,
  curator: string,
  options: Omit<ReplicateOptions, "manual" | "requestedBy" | "limits" | "keep"> & {
    settings?: FollowSettings;
  } = {},
): Promise<{ refresh: RefreshResult; sites: SiteOutcome[] }> {
  const { settings: _settings, ...replicateOptions } = options;
  let refresh: RefreshResult;
  try {
    refresh = await refreshFollow(kubo, store, curator, options);
  } catch (error) {
    // A first follow that fails leaves the curator's site behind, wanted by nobody.
    await store.locked(() => dropUnwantedLocked(kubo, store));
    throw error;
  }
  const state = await store.read();
  const follow = state.follows.find((candidate) => candidate.curator === curator);
  const sites: SiteOutcome[] = [];
  for (const name of follow === undefined ? [] : trackedBy(follow)) {
    if (name === curator) {
      continue;
    }
    try {
      const result = await replicateSite(kubo, store, name, replicateOptions);
      sites.push({ name, ok: true, result });
    } catch (error) {
      if (!isOperationalError(error)) {
        throw error;
      }
      sites.push({ name, ok: false, error: error.message });
    }
  }
  return { refresh, sites };
}

/** Stops following a book and drops the sites only it wanted. */
export async function unfollowBook(
  kubo: KuboClient,
  store: ReplicaStateStore,
  curator: string,
  options: { keepPins?: boolean } = {},
): Promise<{ curator: string; dropped: readonly UnreplicateResult[] }> {
  return store.locked(async () => {
    const state = await store.read();
    if (!state.follows.some((follow) => follow.curator === curator)) {
      throw new CliError(`${curator} is not followed on this node`);
    }
    await store.write({
      ...state,
      follows: state.follows.filter((follow) => follow.curator !== curator),
    });
    return { curator, dropped: await dropUnwantedLocked(kubo, store, options) };
  });
}

/** Every address this replica should keep current: its sites and what its follows track. */
export async function wantedSites(store: ReplicaStateStore): Promise<string[]> {
  const state = await store.read();
  return [
    ...new Set([
      ...state.sites.map((site) => site.name),
      ...state.follows.flatMap((follow) => trackedBy(follow)),
    ]),
  ].sort();
}
