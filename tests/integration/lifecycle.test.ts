import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "@meshkeep/cli";
import { KuboError } from "@meshkeep/kubo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KuboCluster } from "./cluster.js";

/**
 * The whole Meshkeep lifecycle on a private five-node network:
 * publish v1 → replicate → publisher offline → key moves to a new machine → publish v2 →
 * replicas sync → every publisher offline → a fresh visitor still resolves and loads the site.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
// Root CIDs are part of the fixture contract: the same bytes and profile must give the same CID.
const V1_CID = "bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki";
const V2_CID = "bafybeiczekoh2tsak4wy6hhuxr7tmmaqpjfrh5yqckq4rzmnavkk6k5hwq";
const FILES = ["index.html", "css/style.css", "js/app.js", "img/asset.txt"];
const REPLICAS = ["replica-1", "replica-2"] as const;

const cluster = new KuboCluster();
const homes = new Map<string, string>();
let scratch = "";
let siteName = "";
let v1Record: Uint8Array;

/** Runs the CLI in-process as a given role, with its own state directory and Kubo node. */
async function cli(role: string, ...args: string[]) {
  let home = homes.get(role);
  if (home === undefined) {
    home = await mkdtemp(join(scratch, `${role}-`));
    homes.set(role, home);
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  await runCli(["node", "meshkeep", "--json", ...args], {
    env: { MESHKEEP_HOME: home, MESHKEEP_API: cluster.node(role).apiUrl },
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    setExitCode: (code: number) => {
      exitCode = code;
    },
  });
  return { exitCode, stdout, stderr };
}

/** Like `cli`, but requires success and returns the parsed JSON result. */
async function meshkeep(role: string, ...args: string[]) {
  const result = await cli(role, ...args);
  if (result.exitCode !== 0) {
    throw new Error(`meshkeep ${args.join(" ")} failed on ${role}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Fetches every fixture file through a node's own HTTP gateway and compares hashes. */
async function expectServed(role: string, root: string, version: "site-v1" | "site-v2") {
  for (const file of FILES) {
    const response = await fetch(`${cluster.node(role).gatewayUrl}${root}/${file}`, {
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    expect(response.status, `${role} ${root}/${file}`).toBe(200);
    const served = new Uint8Array(await response.arrayBuffer());
    const expected = await readFile(join(FIXTURES, version, file));
    expect(sha256(served), `${role} ${root}/${file}`).toBe(sha256(expected));
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "meshkeep-lifecycle-"));
  await cluster.init();
  for (const role of ["publisher-a", "publisher-b", ...REPLICAS]) {
    await cluster.start(role);
  }
});

afterAll(async () => {
  await cluster.destroy();
  await rm(scratch, { recursive: true, force: true });
});

describe.sequential("site lifecycle", () => {
  it("publisher A creates a free key-based address and publishes v1", async () => {
    siteName = String((await meshkeep("publisher-a", "key", "create", "site")).name);
    const published = await meshkeep(
      "publisher-a",
      "publish",
      join(FIXTURES, "site-v1"),
      "--key",
      "site",
    );

    expect(published).toMatchObject({ name: siteName, cid: V1_CID, sequence: 0, files: 4 });
    expect(published.blocks).toBe(8);
  });

  it("both replicas resolve v1 by petname and keep the complete graph", async () => {
    for (const role of REPLICAS) {
      await meshkeep(role, "book", "add", "my-site", siteName);
      expect(await meshkeep(role, "resolve", "my-site")).toEqual({
        name: siteName,
        cid: V1_CID,
        petname: "my-site",
      });
      const replicated = await meshkeep(role, "replicate", "my-site");
      expect(replicated).toMatchObject({ cid: V1_CID, sequence: 0, blocks: 8, updated: true });
      expect(await meshkeep(role, "verify", V1_CID)).toMatchObject({ complete: true, blocks: 8 });
    }
    v1Record = await cluster.node("replica-1").kubo.getRecord(siteName);
  });

  it("v1 is served by both replicas after publisher A shuts down", async () => {
    await meshkeep("publisher-a", "key", "export", "site", join(scratch, "site.key"));
    await cluster.stop("publisher-a");

    for (const role of REPLICAS) {
      await expectServed(role, `/ipfs/${V1_CID}`, "site-v1");
      await expectServed(role, `/ipns/${siteName}`, "site-v1");
    }
  });

  it("publisher B takes over the moved key and publishes v2 under the same address", async () => {
    const imported = await meshkeep(
      "publisher-b",
      "key",
      "import",
      "site",
      join(scratch, "site.key"),
    );
    expect(imported.name).toBe(siteName);

    const published = await meshkeep(
      "publisher-b",
      "publish",
      join(FIXTURES, "site-v2"),
      "--key",
      "site",
    );
    expect(published).toMatchObject({ name: siteName, cid: V2_CID, sequence: 1 });
  });

  it("replicas sync to v2 and keep v1", async () => {
    for (const role of REPLICAS) {
      const synced = (await meshkeep(role, "sync")) as { sites: Record<string, unknown>[] };
      expect(synced.sites).toHaveLength(1);
      expect(synced.sites[0]).toMatchObject({
        ok: true,
        cid: V2_CID,
        sequence: 1,
        updated: true,
        versions: [V1_CID, V2_CID],
      });
      expect(await meshkeep(role, "verify", V1_CID)).toMatchObject({ complete: true });
      expect(await meshkeep(role, "verify", V2_CID)).toMatchObject({ complete: true });
    }
  });

  it("a fresh visitor loads the site from replicas alone with every publisher offline", async () => {
    await cluster.stop("publisher-b");
    await cluster.start("visitor", { peers: REPLICAS });

    expect(await meshkeep("visitor", "resolve", siteName)).toMatchObject({ cid: V2_CID });
    await expectServed("visitor", `/ipns/${siteName}`, "site-v2");
    await expectServed("visitor", `/ipfs/${V1_CID}`, "site-v1");
  });

  it("replicas reject a record with a broken signature", async () => {
    const kubo = cluster.node("replica-2").kubo;
    const tampered = Uint8Array.from(v1Record);
    // The record starts with the signed /ipfs/ value; change one character of the CID.
    tampered[10] = (tampered[10] ?? 0) ^ 0x01;

    await expect(kubo.inspectRecord(tampered, siteName)).rejects.toThrow(KuboError);
    await expect(kubo.putRecord(siteName, tampered)).rejects.toThrow(KuboError);
  });

  it("replicas refuse to roll back to the older v1 record", async () => {
    const kubo = cluster.node("replica-2").kubo;

    await expect(kubo.putRecord(siteName, v1Record)).rejects.toThrow(/sequence/);
    expect(await meshkeep("replica-2", "resolve", siteName)).toMatchObject({ cid: V2_CID });
  });

  it("verify fails closed for a version this node does not fully hold", async () => {
    // Publisher A left before v2 existed; bring it back isolated so it cannot fetch v2.
    await cluster.restart("publisher-a", { peers: [] });

    const result = await cli("publisher-a", "verify", V2_CID);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ cid: V2_CID, complete: false });
  });
});
