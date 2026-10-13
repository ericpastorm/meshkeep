import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type IpnsRecordEntry, type KuboClient, KuboError, type PinProgress } from "@meshkeep/kubo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_REPLICA_LIMITS, ReplicaStateStore } from "./state.js";
import { replicateSite, unreplicateSite } from "./workflows.js";

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
  /** The record's version is already pinned before the workflow runs. */
  pinned?: boolean;
  /** Recursive pins on the simulated node; share one set to simulate several runs on it. */
  pins?: Set<string>;
  pinFailure?: KuboError;
  unpinFailure?: KuboError;
  putFailure?: KuboError;
}

/** A stand-in for Kubo that serves one record and records what the workflow asks it to do. */
function fakeKubo(entry: Pick<IpnsRecordEntry, "value" | "sequence">, fake: FakeOptions = {}) {
  const calls: string[] = [];
  const pins = fake.pins ?? new Set<string>();
  if (fake.pinned === true) {
    pins.add(entry.value.replace("/ipfs/", ""));
  }
  const kubo = {
    getRecord: async () => Uint8Array.of(1, 2, 3),
    inspectRecord: async () => ({ ...entry, validity: "2027-01-01T00:00:00Z", ttlNanoseconds: 1 }),
    declaredSize: async () => fake.declared ?? 1083,
    isPinnedRecursively: async (cid: string) => pins.has(cid),
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
      pins.add(cid);
    },
    unpin: async (cid: string) => {
      calls.push(`unpin ${cid}`);
      if (fake.unpinFailure !== undefined) {
        throw fake.unpinFailure;
      }
      return pins.delete(cid);
    },
    localDagStat: async () => fake.stat ?? { blocks: 8, bytes: 1083 },
    putRecord: async () => {
      calls.push("put");
      if (fake.putFailure !== undefined) {
        throw fake.putFailure;
      }
    },
  };
  return { kubo: kubo as unknown as KuboClient, calls, pins };
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

describe("pin ownership and retention", () => {
  const NAME_B = "k51qzi5uqu5dhlgajymjxratoeu244ymvjb2z3f9jrmsgaqyj09k60o5diyr2s";
  const v1 = { value: `/ipfs/${V1}`, sequence: 0 };
  const v2 = { value: `/ipfs/${V2}`, sequence: 1 };

  it("owns only the pins it creates", async () => {
    expect(await replicateSite(fakeKubo(v1).kubo, state, NAME)).toMatchObject({
      ownedPins: [V1],
    });
    expect(await replicateSite(fakeKubo(v1, { pinned: true }).kubo, state, NAME_B)).toMatchObject({
      ownedPins: [],
    });
  });

  it("keeps every version by default", async () => {
    const pins = new Set<string>();
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    const result = await replicateSite(fakeKubo(v2, { pins }).kubo, state, NAME);

    expect(result).toMatchObject({ keep: 0, versions: [V1, V2], pruned: [] });
    expect([...pins]).toEqual([V1, V2]);
  });

  it("prunes versions beyond --keep only after the new one is complete", async () => {
    const pins = new Set<string>();
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    const second = fakeKubo(v2, { pins });
    const result = await replicateSite(second.kubo, state, NAME, { keep: 1 });

    expect(result).toMatchObject({ keep: 1, versions: [V2], ownedPins: [V2], pruned: [V1] });
    expect(second.calls).toEqual([`pin ${V2}`, "put", `unpin ${V1}`]);
    expect([...pins]).toEqual([V2]);
    expect((await state.load())[0]).toMatchObject({ keep: 1, versions: [V2] });
  });

  it("never unpins a version this replica did not pin", async () => {
    const pins = new Set<string>([V1]);
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    const second = fakeKubo(v2, { pins });
    const result = await replicateSite(second.kubo, state, NAME, { keep: 1 });

    expect(result).toMatchObject({ versions: [V2], pruned: [] });
    expect(second.calls).not.toContain(`unpin ${V1}`);
    expect(pins.has(V1)).toBe(true);
  });

  it("never unpins a version another replicated site still uses", async () => {
    const pins = new Set<string>();
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME_B);
    const result = await replicateSite(fakeKubo(v2, { pins }).kubo, state, NAME, { keep: 1 });

    expect(result.pruned).toEqual([]);
    expect(pins.has(V1)).toBe(true);
  });

  it("keeps the current version even when the publisher points back to an old one", async () => {
    const pins = new Set<string>();
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    await replicateSite(fakeKubo(v2, { pins }).kubo, state, NAME);
    const rollback = { value: `/ipfs/${V1}`, sequence: 2 };
    const result = await replicateSite(fakeKubo(rollback, { pins }).kubo, state, NAME, { keep: 1 });

    expect(result).toMatchObject({ cid: V1, versions: [V1], pruned: [V2] });
    expect([...pins]).toEqual([V1]);
  });

  it("records the new version and retries later when an old one cannot be unpinned", async () => {
    const pins = new Set<string>();
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    const failing = fakeKubo(v2, { pins, unpinFailure: new KuboError("pin/rm", "busy") });
    const result = await replicateSite(failing.kubo, state, NAME, { keep: 1 });

    expect(result).toMatchObject({ cid: V2, versions: [V1, V2], ownedPins: [V1, V2], pruned: [] });
    const retried = await replicateSite(fakeKubo(v2, { pins }).kubo, state, NAME);
    expect(retried).toMatchObject({ versions: [V2], pruned: [V1] });
  });

  it("records a complete version even when re-putting its record fails", async () => {
    const failing = fakeKubo(v1, { putFailure: new KuboError("name/put", "no peers") });

    await expect(replicateSite(failing.kubo, state, NAME)).rejects.toThrow(
      `replicated ${V1}, but could not re-put its record`,
    );
    expect((await state.load())[0]).toMatchObject({ cid: V1, ownedPins: [V1] });
  });
});

describe("unreplicateSite", () => {
  const v1 = { value: `/ipfs/${V1}`, sequence: 0 };
  const v2 = { value: `/ipfs/${V2}`, sequence: 1 };

  it("forgets the site and unpins only what it owns", async () => {
    const pins = new Set<string>([V1]);
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    await replicateSite(fakeKubo(v2, { pins }).kubo, state, NAME);

    const result = await unreplicateSite(fakeKubo(v2, { pins }).kubo, state, NAME);
    expect(result).toEqual({ name: NAME, released: [V2], kept: [V1], failed: [] });
    expect([...pins]).toEqual([V1]);
    expect(await state.load()).toEqual([]);
  });

  it("leaves every pin in place with keepPins", async () => {
    const pins = new Set<string>();
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    const result = await unreplicateSite(fakeKubo(v1, { pins }).kubo, state, NAME, {
      keepPins: true,
    });

    expect(result).toMatchObject({ released: [], kept: [V1] });
    expect(pins.has(V1)).toBe(true);
    expect(await state.load()).toEqual([]);
  });

  it("keeps the site recorded when an unpin fails, so it can be retried", async () => {
    const pins = new Set<string>();
    await replicateSite(fakeKubo(v1, { pins }).kubo, state, NAME);
    const failing = fakeKubo(v1, { pins, unpinFailure: new KuboError("pin/rm", "busy") });

    await expect(unreplicateSite(failing.kubo, state, NAME)).rejects.toThrow(
      "is still recorded, run again",
    );
    expect(await state.load()).toHaveLength(1);
    await expect(unreplicateSite(fakeKubo(v1, { pins }).kubo, state, NAME)).resolves.toMatchObject({
      released: [V1],
    });
  });

  it("refuses a site that is not replicated", async () => {
    await expect(unreplicateSite(fakeKubo(v1).kubo, state, NAME)).rejects.toThrow(
      "is not replicated on this node",
    );
  });
});

describe("replica state compatibility", () => {
  it("loads state written before retention existed as keep-all with no owned pins", async () => {
    await writeFile(
      join(home, "replicas.json"),
      JSON.stringify({
        format: "meshkeep-replica-state-v1",
        sites: [{ name: NAME, cid: V1, sequence: 0, validity: "x", versions: [V1] }],
      }),
    );

    expect((await state.load())[0]).toMatchObject({
      keep: 0,
      ownedPins: [],
      ...DEFAULT_REPLICA_LIMITS,
    });
  });
});
