import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliRunner, FIXTURES, V1_CID, V2_CID } from "./cli.js";
import { KuboCluster } from "./cluster.js";

/**
 * Replica resource limits and interrupted fetches on a private three-node network. The witness
 * holds no content; it keeps the DHT (and so the signed record) available while the publisher
 * is offline.
 */

const cluster = new KuboCluster();
let scratch = "";
let siteName = "";
const { cli, meshkeep } = cliRunner(cluster, () => scratch);

/** The replica must end each refusal with no pin and nothing recorded. */
async function expectNothingReplicated(cid: string) {
  expect(await cluster.node("replica").kubo.isPinnedRecursively(cid)).toBe(false);
  expect(await meshkeep("replica", "sync")).toEqual({ follows: [], sites: [] });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "meshkeep-limits-"));
  await cluster.init();
  for (const role of ["publisher", "replica", "witness"]) {
    await cluster.start(role);
  }
  siteName = String((await meshkeep("publisher", "key", "create", "site")).name);
  await meshkeep("publisher", "publish", join(FIXTURES, "site-v1"), "--key", "site");
});

afterAll(async () => {
  await cluster.destroy();
  await rm(scratch, { recursive: true, force: true });
});

describe.sequential("replica limits", () => {
  it("refuses a version whose root declares more than --max-size, before fetching it", async () => {
    const result = await cli("replica", "replicate", siteName, "--max-size", "1KiB");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `version ${V1_CID} declares 1083 bytes, over this replica's limit of 1024 bytes`,
    );
    await expectNothingReplicated(V1_CID);
  });

  it("refuses a version with more blocks than --max-blocks and leaves no pin", async () => {
    const result = await cli("replica", "replicate", siteName, "--max-blocks", "4");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/blocks.*over this replica's limit of \d+ bytes \/ 4 blocks/);
    await expectNothingReplicated(V1_CID);
  });

  it("records nothing when a fetch is interrupted, and resumes on the next run", async () => {
    const published = await meshkeep(
      "publisher",
      "publish",
      join(FIXTURES, "site-v2"),
      "--key",
      "site",
    );
    expect(published).toMatchObject({ cid: V2_CID, sequence: 1 });

    // Fetch part of v2 (the root and one file), then lose the only provider.
    const replica = cluster.node("replica").kubo;
    await replica.cat(`/ipfs/${V2_CID}/index.html`);
    await cluster.stop("publisher");

    const started = Date.now();
    const interrupted = await cli("replica", "replicate", siteName, "--fetch-timeout", "5");
    expect(interrupted.exitCode).toBe(1);
    expect(interrupted.stderr).toContain(`fetching ${V2_CID} timed out after 5s`);
    expect(Date.now() - started).toBeLessThan(60_000);

    const verify = await cli("replica", "verify", V2_CID);
    expect(verify.exitCode).toBe(1);
    expect(JSON.parse(verify.stdout)).toMatchObject({ complete: false });
    await expectNothingReplicated(V2_CID);

    await cluster.restart("publisher");
    expect(await meshkeep("replica", "replicate", siteName)).toMatchObject({
      cid: V2_CID,
      sequence: 1,
      blocks: 8,
      versions: [V2_CID],
    });
    expect(await meshkeep("replica", "verify", V2_CID)).toMatchObject({ complete: true });
  });
});
