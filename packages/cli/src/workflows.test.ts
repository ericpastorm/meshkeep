import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IpnsRecordEntry, KuboClient } from "@meshkeep/kubo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReplicaStateStore } from "./state.js";
import { replicateSite } from "./workflows.js";

const NAME = "k51qzi5uqu5dg9ufswxt229ntzdy7p4125xzv5rtyjso89ajdujg6csfxcj260";
const V1 = "bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki";
const V2 = "bafybeiczekoh2tsak4wy6hhuxr7tmmaqpjfrh5yqckq4rzmnavkk6k5hwq";

/** A stand-in for Kubo that serves one record and records what the workflow asks it to do. */
function fakeKubo(entry: Omit<IpnsRecordEntry, "validity" | "ttlNanoseconds">) {
  const calls: string[] = [];
  const kubo = {
    getRecord: async () => Uint8Array.of(1, 2, 3),
    inspectRecord: async () => ({ ...entry, validity: "2027-01-01T00:00:00Z", ttlNanoseconds: 1 }),
    pinRecursive: async (cid: string) => {
      calls.push(`pin ${cid}`);
    },
    localDagStat: async () => ({ blocks: 8, bytes: 1083 }),
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
