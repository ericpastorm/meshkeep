import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliRunner, FIXTURES, V1_CID, V2_CID } from "./cli.js";
import { KuboCluster } from "./cluster.js";

/**
 * Following a published address book (ADR 0003) on a private three-node network: a publisher
 * with three sites, a curator who publishes a book listing some of them, and a replica that
 * follows the book as the curator changes it.
 */

const cluster = new KuboCluster();
let scratch = "";
const sites: Record<"a" | "b" | "d", { name: string; cid: string }> = {
  a: { name: "", cid: "" },
  b: { name: "", cid: "" },
  d: { name: "", cid: "" },
};
let curator = "";
const { cli, meshkeep } = cliRunner(cluster, () => scratch);

const pinned = (cid: string) => cluster.node("replica").kubo.isPinnedRecursively(cid);

async function publishBook() {
  return meshkeep("curator", "book", "publish", "--key", "book");
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "meshkeep-follow-"));
  await cluster.init();
  for (const role of ["publisher", "curator", "replica"]) {
    await cluster.start(role);
  }
  const third = join(scratch, "site-d");
  await mkdir(third);
  await writeFile(join(third, "index.html"), "<!doctype html><title>d</title><p>site d</p>\n");
  const directories = { a: join(FIXTURES, "site-v1"), b: join(FIXTURES, "site-v2"), d: third };
  for (const key of ["a", "b", "d"] as const) {
    sites[key].name = String((await meshkeep("publisher", "key", "create", key)).name);
    const published = await meshkeep("publisher", "publish", directories[key], "--key", key);
    sites[key].cid = String(published.cid);
  }
  expect([sites.a.cid, sites.b.cid]).toEqual([V1_CID, V2_CID]);
  curator = String((await meshkeep("curator", "key", "create", "book")).name);
});

afterAll(async () => {
  await cluster.destroy();
  await rm(scratch, { recursive: true, force: true });
});

describe.sequential("published address books", () => {
  it("a curator publishes a book listing two sites", async () => {
    await meshkeep("curator", "book", "add", "site-a", sites.a.name);
    await meshkeep("curator", "book", "add", "site-b", sites.b.name);
    const published = await publishBook();
    expect(published).toMatchObject({ name: curator, sequence: 0, files: 1 });
  });

  it("a replica that follows the book replicates the curator's site and both listed sites", async () => {
    const followed = await meshkeep("replica", "follow", curator, "--max-sites", "10");
    expect(followed).toMatchObject({ curator, sites: [sites.a.name, sites.b.name].sort() });
    expect((followed.replicated as { ok: boolean }[]).every((site) => site.ok)).toBe(true);
    expect(await pinned(sites.a.cid)).toBe(true);
    expect(await pinned(sites.b.cid)).toBe(true);
    expect(await meshkeep("replica", "follows")).toMatchObject({
      follows: [{ curator, maxSites: 10, sites: [sites.a.name, sites.b.name].sort() }],
    });
  });

  it("sync follows the curator's changes: drops the removed site, adds the new one", async () => {
    await meshkeep("curator", "book", "remove", "site-a");
    await meshkeep("curator", "book", "add", "site-d", sites.d.name);
    expect(await publishBook()).toMatchObject({ sequence: 1 });

    const synced = (await meshkeep("replica", "sync")) as {
      follows: Record<string, unknown>[];
      sites: { name: string; ok: boolean }[];
    };
    expect(synced.follows[0]).toMatchObject({
      ok: true,
      curator,
      added: [sites.d.name],
      removed: [sites.a.name],
    });
    expect(synced.sites.map((site) => site.name).sort()).toEqual(
      [curator, sites.b.name, sites.d.name].sort(),
    );
    expect(synced.sites.every((site) => site.ok)).toBe(true);
    expect(await pinned(sites.a.cid)).toBe(false);
    expect(await pinned(sites.b.cid)).toBe(true);
    expect(await pinned(sites.d.cid)).toBe(true);
  });

  it("refuses to unreplicate a site the followed book lists", async () => {
    const result = await cli("replica", "unreplicate", sites.b.name);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unfollow it instead");
  });

  it("unfollow stops replicating everything that only the book wanted", async () => {
    const result = (await meshkeep("replica", "unfollow", curator)) as {
      dropped: { name: string }[];
    };
    expect(result.dropped.map((drop) => drop.name).sort()).toEqual(
      [curator, sites.b.name, sites.d.name].sort(),
    );
    expect(await pinned(sites.b.cid)).toBe(false);
    expect(await pinned(sites.d.cid)).toBe(false);
    expect(await meshkeep("replica", "sync")).toEqual({ follows: [], sites: [] });
  });
});
