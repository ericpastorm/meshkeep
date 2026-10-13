import { type IpnsRecordEntry, type KuboClient, KuboError } from "@meshkeep/kubo";
import { parseContentCid, UNIXFS_PROFILE, UNIXFS_PROFILE_IMPORT_CONFIG } from "@meshkeep/protocol";

import { CliError } from "./errors.js";
import type { StoredKey } from "./keystore.js";
import { readSite } from "./site.js";
import {
  DEFAULT_REPLICA_LIMITS,
  type ReplicaLimits,
  type ReplicaStateStore,
  type ReplicatedSite,
} from "./state.js";

export const DEFAULT_RECORD_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30 * 60_000;
/** Kubo names its keys; Meshkeep prefixes its own so it never touches the operator's. */
const KUBO_KEY_PREFIX = "meshkeep-";

export type Log = (message: string) => void;

/** Fails unless the node imports with exactly the `unixfs-v1-2025` profile. */
export async function requireImportProfile(kubo: KuboClient): Promise<void> {
  const config = (await kubo.getConfig("Import")) as Record<string, unknown> | null;
  const mismatched = Object.entries(UNIXFS_PROFILE_IMPORT_CONFIG)
    .filter(([key, expected]) => config?.[key] !== expected)
    .map(([key]) => key);
  if (mismatched.length > 0) {
    throw new CliError(
      `Kubo Import config does not match ${UNIXFS_PROFILE} (${mismatched.join(", ")}); ` +
        `run \`ipfs config profile apply ${UNIXFS_PROFILE}\` and restart the daemon`,
    );
  }
}

/** Ensures Kubo holds the site key and returns Kubo's name for it. */
async function ensureKuboKey(kubo: KuboClient, key: StoredKey): Promise<string> {
  const keys = await kubo.listKeys();
  const existing = keys.find((candidate) => candidate.id === key.name);
  if (existing !== undefined) {
    return existing.name;
  }
  const kuboName = `${KUBO_KEY_PREFIX}${key.label}`;
  if (keys.some((candidate) => candidate.name === kuboName)) {
    throw new CliError(`Kubo already has a different key named ${kuboName}`);
  }
  const imported = await kubo.importKey(kuboName, key.privateKey);
  if (imported !== key.name) {
    throw new CliError(`Kubo imported key ${key.label} as ${imported}, expected ${key.name}`);
  }
  return kuboName;
}

/** Looks up and verifies the newest signed record for a name, if the network has one. */
async function findRecord(
  kubo: KuboClient,
  name: string,
  timeoutMs: number,
): Promise<{ record: Uint8Array; entry: IpnsRecordEntry } | undefined> {
  let record: Uint8Array;
  try {
    record = await kubo.getRecord(name, { timeoutMs });
  } catch (error) {
    if (error instanceof KuboError) {
      return undefined;
    }
    throw error;
  }
  return { record, entry: await kubo.inspectRecord(record, name) };
}

export interface PublishResult {
  readonly name: string;
  readonly cid: string;
  readonly sequence: number;
  readonly validity: string;
  readonly files: number;
  readonly blocks: number;
  readonly bytes: number;
}

export async function publishSite(
  kubo: KuboClient,
  key: StoredKey,
  options: { directory: string; lifetime: string; ttl: string; includeHidden: boolean; log: Log },
): Promise<PublishResult> {
  await requireImportProfile(kubo);
  const site = await readSite(options.directory, { includeHidden: options.includeHidden });
  const cid = parseContentCid(await kubo.addDirectory("site", site.entries));
  await kubo.pinRecursive(cid);
  const stat = await kubo.localDagStat(cid);
  const kuboKey = await ensureKuboKey(kubo, key);

  // A key moved from another machine has no local history, so continue the sequence from the
  // newest record the network knows about. Equal or lower sequences would lose to it.
  const previous = await findRecord(kubo, key.name, DEFAULT_RECORD_TIMEOUT_MS);
  if (previous === undefined) {
    options.log(`no existing record found for ${key.name}; publishing a new name`);
  }
  const sequence = previous === undefined ? undefined : previous.entry.sequence + 1;
  const published = await kubo.publishName(cid, {
    key: kuboKey,
    lifetime: options.lifetime,
    ttl: options.ttl,
    ...(sequence === undefined ? {} : { sequence }),
  });
  if (published !== key.name) {
    throw new CliError(`Kubo published ${published}, expected ${key.name}`);
  }
  const current = await findRecord(kubo, key.name, DEFAULT_RECORD_TIMEOUT_MS);
  if (current === undefined || current.entry.value !== `/ipfs/${cid}`) {
    throw new CliError(`published record for ${key.name} could not be read back`);
  }
  return {
    name: key.name,
    cid,
    sequence: current.entry.sequence,
    validity: current.entry.validity,
    files: site.files,
    blocks: stat.blocks,
    bytes: stat.bytes,
  };
}

export interface ReplicateResult extends ReplicatedSite {
  readonly updated: boolean;
  readonly blocks: number;
  readonly bytes: number;
}

export interface ReplicateOptions {
  readonly recordTimeoutMs?: number;
  readonly fetchTimeoutMs?: number;
  /** Overrides, then remembers, this site's limits; otherwise stored limits or defaults apply. */
  readonly limits?: Partial<ReplicaLimits>;
}

class LimitExceeded extends CliError {}

function describeLimits(limits: ReplicaLimits): string {
  return `${limits.maxBytes} bytes / ${limits.maxBlocks} blocks`;
}

/** Turns a fetch deadline into an operator message; other failures pass through. */
function fetchFailure(error: unknown, name: string, cid: string, timeoutMs: number): unknown {
  if (error instanceof KuboError && error.timedOut) {
    return new CliError(
      `${name}: fetching ${cid} timed out after ${Math.round(timeoutMs / 1000)}s; nothing was ` +
        "recorded, and blocks fetched so far are kept so the next run resumes",
    );
  }
  return error;
}

/**
 * Makes this node a complete replica of a site's current version: verify the signed record,
 * refuse rollbacks, fetch the whole graph within the site's limits, then re-put the record so
 * the name stays resolvable without the publisher. Nothing is recorded unless every step passes.
 */
export async function replicateSite(
  kubo: KuboClient,
  state: ReplicaStateStore,
  name: string,
  options: ReplicateOptions = {},
): Promise<ReplicateResult> {
  const found = await findRecord(kubo, name, options.recordTimeoutMs ?? DEFAULT_RECORD_TIMEOUT_MS);
  if (found === undefined) {
    throw new CliError(`no valid record found for ${name}`);
  }
  const { record, entry } = found;
  if (!entry.value.startsWith("/ipfs/")) {
    throw new CliError(`record for ${name} points to ${entry.value}, not an immutable /ipfs/ CID`);
  }
  const cid = parseContentCid(entry.value);

  const sites = await state.load();
  const known = sites.find((site) => site.name === name);
  if (known !== undefined && entry.sequence < known.sequence) {
    throw new CliError(
      `stale record for ${name}: sequence ${entry.sequence} is older than verified ${known.sequence}`,
    );
  }

  const limits: ReplicaLimits = {
    maxBytes: options.limits?.maxBytes ?? known?.maxBytes ?? DEFAULT_REPLICA_LIMITS.maxBytes,
    maxBlocks: options.limits?.maxBlocks ?? known?.maxBlocks ?? DEFAULT_REPLICA_LIMITS.maxBlocks,
  };
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const overLimit = (detail: string) =>
    new LimitExceeded(
      `${name}: version ${cid} ${detail}, over this replica's limit of ${describeLimits(limits)}; ` +
        "not replicated",
    );

  // 1. Cheap early filter: the root's own claim about the DAG size. Only the root is fetched.
  let declared: number;
  try {
    declared = await kubo.declaredSize(cid, { timeoutMs: fetchTimeoutMs });
  } catch (error) {
    throw fetchFailure(error, name, cid, fetchTimeoutMs);
  }
  if (declared > limits.maxBytes) {
    throw overLimit(`declares ${declared} bytes`);
  }

  // 2. Enforce the limits while fetching, since the declared size can lie; 3. check exactly after.
  const alreadyPinned = await kubo.isPinnedRecursively(cid);
  let stat: { blocks: number; bytes: number };
  try {
    try {
      await kubo.pinRecursive(cid, {
        timeoutMs: fetchTimeoutMs,
        onProgress: ({ blocks, bytes }) => {
          if (blocks > limits.maxBlocks || bytes > limits.maxBytes) {
            throw overLimit(`reached ${bytes} bytes / ${blocks} blocks while fetching`);
          }
        },
      });
    } catch (error) {
      throw fetchFailure(error, name, cid, fetchTimeoutMs);
    }
    stat = await kubo.localDagStat(cid);
    if (stat.bytes > limits.maxBytes || stat.blocks > limits.maxBlocks) {
      throw overLimit(`has ${stat.bytes} bytes / ${stat.blocks} blocks`);
    }
  } catch (error) {
    // Never leave behind a pin this call created for a version it refused. An abort can race
    // with Kubo finishing the pin, so check rather than assume.
    if (error instanceof LimitExceeded && !alreadyPinned && (await kubo.isPinnedRecursively(cid))) {
      await kubo.unpin(cid);
    }
    throw error;
  }

  await kubo.putRecord(name, record);

  const versions = known === undefined ? [cid] : [...new Set([...known.versions, cid])];
  const site: ReplicatedSite = {
    name,
    cid,
    sequence: entry.sequence,
    validity: entry.validity,
    versions,
    ...limits,
  };
  await state.save([...sites.filter((candidate) => candidate.name !== name), site]);
  return { ...site, updated: known?.cid !== cid, blocks: stat.blocks, bytes: stat.bytes };
}

export async function verifyComplete(
  kubo: KuboClient,
  cid: string,
): Promise<{ complete: boolean; blocks?: number; bytes?: number; reason?: string }> {
  try {
    const stat = await kubo.localDagStat(cid);
    return { complete: true, ...stat };
  } catch (error) {
    if (error instanceof KuboError) {
      return { complete: false, reason: error.message };
    }
    throw error;
  }
}
