import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KuboClient } from "@meshkeep/kubo";
import {
  createAddressBook,
  encodeAddressBook,
  ipnsNameFromPublicKey,
  PUBLISHED_ADDRESS_BOOK_PATH,
} from "@meshkeep/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  followBook,
  readPublishedBook,
  refreshFollow,
  unfollowBook,
  wantedSites,
} from "./follows.js";
import { ReplicaStateStore } from "./state.js";
import { replicateSite, unreplicateSite } from "./workflows.js";

const name = (seed: number) => ipnsNameFromPublicKey(new Uint8Array(32).fill(seed));
const CURATOR = name(1);
const A = name(2);
const B = name(3);
const D = name(4);
const OTHER_CURATOR = name(5);
const CIDS = [
  "bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki",
  "bafybeiczekoh2tsak4wy6hhuxr7tmmaqpjfrh5yqckq4rzmnavkk6k5hwq",
  "bafybeifsqzdt4kr473cwmebrt7u3z3qkbr62vf4qt3v3ked5u5b5fvb4yy",
  "bafybeif3yaojdwgtis7nquyy5p3rli4acxgh6wpvtwedpplzme7zwmjf64",
  "bafkreihtph2xgofll5loo5h6ps2ssvpzoddbc74qxeq7uww7g27wtm3r7m",
  "bafkreihefnutrm4my32537ioxlqz7zdtesstyy2wli4aq4btudamvfi3oi",
  "bafkreig27jhbm5mhw7xdbtaa2wcrcf4jpbrlnqvwe3zs3belyotgx7jni4",
  "bafkreif7cq5hqnfyvyxfhfhxpwdjplrqseghuky6obwptfvdcug3qr6wh4",
] as const;

/**
 * A simulated Kubo node and network: every address has a current record, every version may
 * contain files, and pins are tracked per CID.
 */
class FakeNetwork {
  readonly records = new Map<string, { cid: string; sequence: number }>();
  readonly files = new Map<string, Uint8Array>();
  readonly pins = new Set<string>();
  private nextCid = 0;

  /** Publishes a new version of `address`, optionally containing a book listing `listed`. */
  publish(address: string, listed?: readonly string[]): string {
    const cid = CIDS[this.nextCid++ % CIDS.length] as string;
    const previous = this.records.get(address);
    this.records.set(address, { cid, sequence: (previous?.sequence ?? -1) + 1 });
    if (listed !== undefined) {
      const book = createAddressBook(
        listed.map((site, index) => ({ petname: `s${index}`, name: site })),
      );
      this.setFile(cid, encodeAddressBook(book));
    }
    return cid;
  }

  setFile(cid: string, contents: string | Uint8Array) {
    const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    this.files.set(`/ipfs/${cid}/${PUBLISHED_ADDRESS_BOOK_PATH}`, bytes);
  }

  kubo(): KuboClient {
    const fake = {
      getRecord: async (address: string) => new TextEncoder().encode(address),
      inspectRecord: async (record: Uint8Array) => {
        const current = this.records.get(new TextDecoder().decode(record));
        if (current === undefined) {
          throw new Error("no record");
        }
        return {
          value: `/ipfs/${current.cid}`,
          sequence: current.sequence,
          validity: "2027-01-01T00:00:00Z",
          ttlNanoseconds: 1,
        };
      },
      declaredSize: async () => 1083,
      isPinnedRecursively: async (cid: string) => this.pins.has(cid),
      pinRecursive: async (cid: string) => {
        this.pins.add(cid);
      },
      unpin: async (cid: string) => this.pins.delete(cid),
      localDagStat: async () => ({ blocks: 8, bytes: 1083 }),
      putRecord: async () => undefined,
      cat: async (path: string, options: { length?: number } = {}) => {
        const bytes = this.files.get(path);
        if (bytes === undefined) {
          const { KuboError } = await import("@meshkeep/kubo");
          throw new KuboError("cat", "no link named");
        }
        return options.length === undefined ? bytes : bytes.slice(0, options.length);
      },
    };
    return fake as unknown as KuboClient;
  }
}

let home: string;
let store: ReplicaStateStore;
let net: FakeNetwork;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "meshkeep-follow-test-"));
  store = new ReplicaStateStore(home);
  net = new FakeNetwork();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const siteNames = async () => (await store.load()).map((site) => site.name).sort();

describe("readPublishedBook", () => {
  it("reads and validates the book at the well-known path", async () => {
    const cid = net.publish(CURATOR, [A, B]);

    const book = await readPublishedBook(net.kubo(), cid);
    expect(book.entries.map((entry) => entry.name).sort()).toEqual([A, B].sort());
  });

  it("rejects a version without a book, an oversized book, and an invalid one", async () => {
    const missing = net.publish(CURATOR);
    await expect(readPublishedBook(net.kubo(), missing)).rejects.toThrow(
      "has no published address book",
    );

    const big = net.publish(CURATOR);
    net.setFile(big, new Uint8Array(4 * 1024 * 1024 + 10).fill(0x20));
    await expect(readPublishedBook(net.kubo(), big)).rejects.toThrow("exceeds");

    const invalid = net.publish(CURATOR);
    net.setFile(invalid, '{"format":"meshkeep-address-book-v9","entries":[]}');
    await expect(readPublishedBook(net.kubo(), invalid)).rejects.toThrow("is invalid");

    const binary = net.publish(CURATOR);
    net.setFile(binary, Uint8Array.of(0xff, 0xfe));
    await expect(readPublishedBook(net.kubo(), binary)).rejects.toThrow("is invalid");
  });
});

describe("followBook", () => {
  it("replicates the curator's site and every site its book lists", async () => {
    net.publish(CURATOR, [A, B]);
    net.publish(A);
    net.publish(B);

    const { refresh, sites } = await followBook(net.kubo(), store, CURATOR);
    expect(refresh).toMatchObject({ curator: CURATOR, added: [A, B].sort(), removed: [] });
    expect(sites.every((site) => site.ok)).toBe(true);
    expect(await siteNames()).toEqual([CURATOR, A, B].sort());
    expect((await store.load()).every((site) => !site.manual)).toBe(true);
    expect((await store.read()).follows).toMatchObject([{ curator: CURATOR, maxSites: 100 }]);
  });

  it("applies the follow's limits and retention to the sites it adds", async () => {
    net.publish(CURATOR, [A]);
    net.publish(A);

    await followBook(net.kubo(), store, CURATOR, {
      settings: { maxSites: 5, limits: { maxBytes: 4096 }, keep: 2 },
    });
    const added = (await store.load()).find((site) => site.name === A);
    expect(added).toMatchObject({ maxBytes: 4096, keep: 2, manual: false });
  });

  it("keeps the operator's own limits for a site they already replicate", async () => {
    net.publish(A);
    await replicateSite(net.kubo(), store, A, { manual: true, limits: { maxBytes: 9999 } });
    net.publish(CURATOR, [A]);

    await followBook(net.kubo(), store, CURATOR, { settings: { limits: { maxBytes: 4096 } } });
    expect((await store.load()).find((site) => site.name === A)).toMatchObject({
      maxBytes: 9999,
      manual: true,
    });
  });

  it("refuses a book listing more than --max-sites and records nothing", async () => {
    net.publish(CURATOR, [A, B, D]);

    await expect(
      followBook(net.kubo(), store, CURATOR, { settings: { maxSites: 2 } }),
    ).rejects.toThrow("lists 3 sites, over this follow's limit of 2");
    expect(await store.read()).toEqual({ sites: [], follows: [] });
    expect(net.pins.size).toBe(0);
  });

  it("records nothing when the curator's site has no book", async () => {
    net.publish(CURATOR);

    await expect(followBook(net.kubo(), store, CURATOR)).rejects.toThrow(
      "has no published address book",
    );
    expect(await store.read()).toEqual({ sites: [], follows: [] });
  });
});

describe("refreshFollow", () => {
  beforeEach(async () => {
    net.publish(CURATOR, [A, B]);
    net.publish(A);
    net.publish(B);
    net.publish(D);
    await followBook(net.kubo(), store, CURATOR);
  });

  it("drops sites the book no longer lists and tracks new ones", async () => {
    const aCid = (await store.load()).find((site) => site.name === A)?.cid as string;
    net.publish(CURATOR, [B, D]);

    const result = await refreshFollow(net.kubo(), store, CURATOR);
    expect(result).toMatchObject({ added: [D], removed: [A] });
    expect(result.dropped.map((drop) => drop.name)).toEqual([A]);
    expect(net.pins.has(aCid)).toBe(false);
    expect(await wantedSites(store)).toEqual([CURATOR, B, D].sort());

    // The next sync replicates the newly listed site with the follow's defaults.
    await replicateSite(net.kubo(), store, D);
    expect(await siteNames()).toEqual([CURATOR, B, D].sort());
  });

  it("keeps a dropped site that the operator replicates themselves", async () => {
    await replicateSite(net.kubo(), store, A, { manual: true });
    net.publish(CURATOR, [B]);

    const result = await refreshFollow(net.kubo(), store, CURATOR);
    expect(result.dropped).toEqual([]);
    expect(await siteNames()).toContain(A);
  });

  it("keeps a dropped site that another followed book still lists", async () => {
    net.publish(OTHER_CURATOR, [A]);
    await followBook(net.kubo(), store, OTHER_CURATOR);
    net.publish(CURATOR, [B]);

    const result = await refreshFollow(net.kubo(), store, CURATOR);
    expect(result.dropped).toEqual([]);
    expect(await siteNames()).toContain(A);
  });

  it("keeps the last known list when the new book cannot be read", async () => {
    const broken = net.publish(CURATOR);
    net.setFile(broken, "not json");

    await expect(refreshFollow(net.kubo(), store, CURATOR)).rejects.toThrow("is invalid");
    expect((await store.read()).follows[0]?.sites).toEqual([A, B].sort());
    expect(await siteNames()).toEqual([CURATOR, A, B].sort());
  });
});

describe("unreplicate and unfollow", () => {
  beforeEach(async () => {
    net.publish(CURATOR, [A, B]);
    net.publish(A);
    net.publish(B);
    await replicateSite(net.kubo(), store, B, { manual: true });
    await followBook(net.kubo(), store, CURATOR);
  });

  it("refuses to unreplicate a site a followed book lists", async () => {
    await expect(unreplicateSite(net.kubo(), store, A)).rejects.toThrow(
      `is listed by the followed book of ${CURATOR}; unfollow it instead`,
    );
  });

  it("unfollow drops the sites only that book wanted and keeps manual ones", async () => {
    const result = await unfollowBook(net.kubo(), store, CURATOR);

    expect(result.dropped.map((drop) => drop.name).sort()).toEqual([CURATOR, A].sort());
    expect(await siteNames()).toEqual([B]);
    expect((await store.read()).follows).toEqual([]);
  });

  it("unfollow --keep-pins stops replicating but leaves the pins", async () => {
    const pinsBefore = net.pins.size;
    await unfollowBook(net.kubo(), store, CURATOR, { keepPins: true });

    expect(net.pins.size).toBe(pinsBefore);
    expect(await siteNames()).toEqual([B]);
  });

  it("refuses to unfollow a book that is not followed", async () => {
    await expect(unfollowBook(net.kubo(), store, OTHER_CURATOR)).rejects.toThrow(
      "is not followed on this node",
    );
  });
});

describe("replication requests", () => {
  it("refuses a site that is neither requested nor listed by a followed book", async () => {
    net.publish(A);

    await expect(replicateSite(net.kubo(), store, A)).rejects.toThrow(
      "is neither replicated by request nor listed by a followed book",
    );
  });

  it("loads state written before follows existed as manual sites with no follows", async () => {
    await writeFile(
      join(home, "replicas.json"),
      JSON.stringify({
        format: "meshkeep-replica-state-v1",
        sites: [{ name: A, cid: CIDS[0], sequence: 0, validity: "x", versions: [CIDS[0]] }],
      }),
    );

    expect(await store.read()).toMatchObject({ sites: [{ name: A, manual: true }], follows: [] });
  });
});
