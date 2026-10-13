import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type IpnsRecordEntry, type KuboClient, KuboError, type PinProgress } from "@meshkeep/kubo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_REPLICA_LIMITS, ReplicaStateStore } from "./state.js";
import { replicateSite } from "./workflows.js";

const NAME = "k51qzi5uqu5dg9ufswxt229ntzdy7p4125xzv5rtyjso89ajdujg6csfxcj260";
const V1 = "bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki";
const V2 = "bafybeiczekoh2tsak4wy6hhuxr7tmmaqpjfrh5yqckq4rzmnavkk6k5hwq";

interface FakeOptions {
  /** What the root claims about the DAG size. */
  declared?: number;
  /** Progress updates Kubo streams before finishing. */
  progress?: PinProgress[];
  /** What a complete local walk reports. */
  stat?: { blocks: number; bytes: number };
  pinned?: boolean;
  pinFailure?: KuboError;
}

/** A stand-in for Kubo that serves one record and records what the workflow asks it to do. */
function fakeKubo(entry: Pick<IpnsRecordEntry, "value" | "sequence">, fake: FakeOptions = {}) {
  const calls: string[] = [];
  let pinned = fake.pinned ?? false;
  const kubo = {
    getRecord: async () => Uint8Array.of(1, 2, 3),
    inspectRecord: async () => ({ ...entry, validity: "2027-01-01T00:00:00Z", ttlNanoseconds: 1 }),
    declaredSize: async () => fake.declared ?? 1083,
    isPinnedRecursively: async () => pinned,
    pinRecursive: async (
      cid: string,
      options: { onProgress?: (progress: PinProgress) => void } = {},
    ) => {
      calls.push(`pin ${cid}`);
      if (fake.pinFailure !== undefined) {
        throw fake.pinFailure;
      }
      for (const update of fake.progress ?? []) {
        options.onProgress?.(update);
      }
      pinned = true;
    },
    unpin: async (cid: string) => {
      calls.push(`unpin ${cid}`);
      pinned = false;
    },
    localDagStat: async () => fake.stat ?? { blocks: 8, bytes: 1083 },
    putRecord: async () => {
      calls.push("put");
    },
  };
  return { kubo: kubo as unknown as KuboClient, calls };
}

let home: string;
let state: ReplicaStateStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "meshkeep-workflow-test-"));
  state = new ReplicaStateStore(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("replicateSite", () => {
  it("pins, verifies, re-puts the record, and remembers every version", async () => {
    const first = fakeKubo({ value: `/ipfs/${V1}`, sequence: 0 });
    expect(await replicateSite(first.kubo, state, NAME)).toMatchObject({
      cid: V1,
      updated: true,
      versions: [V1],
      ...DEFAULT_REPLICA_LIMITS,
    });
    expect(first.calls).toEqual([`pin ${V1}`, "put"]);

    const second = fakeKubo({ value: `/ipfs/${V2}`, sequence: 1 });
    expect(await replicateSite(second.kubo, state, NAME)).toMatchObject({
      cid: V2,
      sequence: 1,
      updated: true,
      versions: [V1, V2],
    });
    expect(await state.load()).toHaveLength(1);
  });

  it("refuses a record older than one it has already verified", async () => {
    await replicateSite(fakeKubo({ value: `/ipfs/${V2}`, sequence: 5 }).kubo, state, NAME);
    const stale = fakeKubo({ value: `/ipfs/${V1}`, sequence: 4 });

    await expect(replicateSite(stale.kubo, state, NAME)).rejects.toThrow(
      "stale record for k51qzi5uqu5dg9ufswxt229ntzdy7p4125xzv5rtyjso89ajdujg6csfxcj260: sequence 4 is older than verified 5",
    );
    expect(stale.calls).toEqual([]);
    expect((await state.load())[0]?.cid).toBe(V2);
  });

  it("refuses records that do not point at an immutable CID", async () => {
    const mutable = fakeKubo({ value: `/ipns/${NAME}`, sequence: 0 });

    await expect(replicateSite(mutable.kubo, state, NAME)).rejects.toThrow("not an immutable");
    expect(mutable.calls).toEqual([]);
  });
});

describe("replicateSite limits", () => {
  const record = { value: `/ipfs/${V1}`, sequence: 0 };

  it("refuses a version whose root declares more than the limit, before fetching", async () => {
    const { kubo, calls } = fakeKubo(record, { declared: 5000 });

    await expect(replicateSite(kubo, state, NAME, { limits: { maxBytes: 4096 } })).rejects.toThrow(
      "declares 5000 bytes, over this replica's limit of 4096 bytes",
    );
    expect(calls).toEqual([]);
    expect(await state.load()).toEqual([]);
  });

  it("aborts a fetch that grows past the limit and drops the pin it created", async () => {
    const { kubo, calls } = fakeKubo(record, {
      progress: [
        { blocks: 4, bytes: 100 },
        { blocks: 9, bytes: 200 },
      ],
    });

    await expect(replicateSite(kubo, state, NAME, { limits: { maxBlocks: 8 } })).rejects.toThrow(
      "reached 200 bytes / 9 blocks while fetching",
    );
    expect(calls).toEqual([`pin ${V1}`]);
    expect(await state.load()).toEqual([]);
  });

  it("checks the exact size after fetching, since the root can understate it", async () => {
    const { kubo, calls } = fakeKubo(record, {
      declared: 10,
      stat: { blocks: 8, bytes: 9000 },
    });

    await expect(replicateSite(kubo, state, NAME, { limits: { maxBytes: 4096 } })).rejects.toThrow(
      "has 9000 bytes / 8 blocks",
    );
    expect(calls).toEqual([`pin ${V1}`, `unpin ${V1}`]);
  });

  it("never unpins a version that was pinned before this call", async () => {
    const { kubo, calls } = fakeKubo(record, { pinned: true, stat: { blocks: 8, bytes: 9000 } });

    await expect(replicateSite(kubo, state, NAME, { limits: { maxBytes: 4096 } })).rejects.toThrow(
      "not replicated",
    );
    expect(calls).toEqual([`pin ${V1}`]);
  });

  it("reports a fetch timeout as resumable and records nothing", async () => {
    const { kubo } = fakeKubo(record, {
      pinFailure: new KuboError("pin/add", "timed out", { timedOut: true }),
    });

    await expect(replicateSite(kubo, state, NAME, { fetchTimeoutMs: 5000 })).rejects.toThrow(
      `fetching ${V1} timed out after 5s; nothing was recorded`,
    );
    expect(await state.load()).toEqual([]);
  });

  it("remembers explicit limits so later syncs apply them", async () => {
    await replicateSite(fakeKubo(record).kubo, state, NAME, { limits: { maxBytes: 4096 } });
    expect((await state.load())[0]).toMatchObject({
      maxBytes: 4096,
      maxBlocks: DEFAULT_REPLICA_LIMITS.maxBlocks,
    });

    const grown = fakeKubo({ value: `/ipfs/${V2}`, sequence: 1 }, { declared: 5000 });
    await expect(replicateSite(grown.kubo, state, NAME)).rejects.toThrow("limit of 4096 bytes");
    expect((await state.load())[0]?.cid).toBe(V1);
  });
});
