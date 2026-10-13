import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliRunner, FIXTURES, V1_CID, V2_CID, waitFor } from "./cli.js";
import { KuboCluster } from "./cluster.js";

/**
 * `meshkeep replica run` on a private three-node network: the daemon notices a new version on
 * its own, coexists with manual commands through the state lock, and stops cleanly.
 */

const cluster = new KuboCluster();
let scratch = "";
let siteName = "";
const { meshkeep, start, home } = cliRunner(cluster, () => scratch);

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "meshkeep-daemon-"));
  await cluster.init();
  for (const role of ["publisher", "replica", "witness"]) {
    await cluster.start(role);
  }
  siteName = String((await meshkeep("publisher", "key", "create", "site")).name);
  await meshkeep("publisher", "publish", join(FIXTURES, "site-v1"), "--key", "site");
  await meshkeep("replica", "replicate", siteName);
});

afterAll(async () => {
  await cluster.destroy();
  await rm(scratch, { recursive: true, force: true });
});

describe.sequential("replica daemon", () => {
  it("picks up a new version by itself, alongside manual commands, and stops cleanly", async () => {
    const daemon = await start("replica", "replica", "run", "--interval", "2");
    const eventFor = (event: string, cid: string) => () =>
      daemon.events().find((entry) => entry.event === event && entry.cid === cid);

    await waitFor("the daemon's first check of v1", eventFor("current", V1_CID));

    const published = await meshkeep(
      "publisher",
      "publish",
      join(FIXTURES, "site-v2"),
      "--key",
      "site",
    );
    expect(published).toMatchObject({ cid: V2_CID, sequence: 1 });
    const updated = await waitFor("the daemon to replicate v2", eventFor("updated", V2_CID));
    expect(updated).toMatchObject({ level: "info", name: siteName, sequence: 1, versions: 2 });
    expect(await cluster.node("replica").kubo.isPinnedRecursively(V2_CID)).toBe(true);

    // A manual command while the daemon runs: the state lock serializes them.
    const manual = await meshkeep("replica", "replicate", siteName, "--keep", "1");
    expect(manual).toMatchObject({ cid: V2_CID, versions: [V2_CID], pruned: [V1_CID] });
    await waitFor("the daemon to apply the stored --keep", () =>
      daemon
        .events()
        .find((entry) => entry.event === "current" && entry.cid === V2_CID && entry.versions === 1),
    );

    const stopped = await daemon.stop();
    expect(stopped.exitCode).toBe(0);
    expect(daemon.events().at(-1)).toEqual(expect.objectContaining({ event: "stopped" }));
    expect(daemon.events().filter((entry) => entry.level !== "info")).toEqual([]);
    expect(stopped.stdout).toBe("");
    await expect(access(join(await home("replica"), "replicas.json.lock"))).rejects.toThrow();
  });
});
