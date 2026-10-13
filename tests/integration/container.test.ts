import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliRunner, FIXTURES, V1_CID, V2_CID, waitFor } from "./cli.js";
import { containerLogs, docker, KuboCluster } from "./cluster.js";

/**
 * The published container image, built from this checkout, running the replica daemon next to
 * a Kubo node the way examples/docker/compose.yaml runs it: in Kubo's network namespace, as a
 * non-root user, with a read-only root filesystem and no capabilities.
 */

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const cluster = new KuboCluster();
const image = `meshkeep-it:${Date.now().toString(36)}`;
let scratch = "";
let siteName = "";
let sidecar = "";
const { meshkeep } = cliRunner(cluster, () => scratch);

/** The daemon's JSON-line events from the container log. */
async function events(): Promise<Record<string, unknown>[]> {
  return (await containerLogs(sidecar))
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function waitForEvent(description: string, match: (event: Record<string, unknown>) => boolean) {
  return waitFor(description, async () => (await events()).find(match), 90_000);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "meshkeep-container-"));
  await docker("build", "--quiet", "--tag", image, REPOSITORY);
  await cluster.init();
  for (const role of ["publisher", "replica", "witness"]) {
    await cluster.start(role);
  }
  siteName = String((await meshkeep("publisher", "key", "create", "site")).name);
  await meshkeep("publisher", "publish", join(FIXTURES, "site-v1"), "--key", "site");
}, 10 * 60_000);

afterAll(async () => {
  await cluster.destroy();
  await docker("image", "rm", "--force", image).catch(() => "");
  await rm(scratch, { recursive: true, force: true });
});

describe.sequential("container image", () => {
  it("runs as an unprivileged user and reaches Kubo only through the shared loopback", async () => {
    sidecar = await cluster.runAlongside(
      "replica",
      image,
      ["replica", "run", "--interval", "2"],
      ["--init", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"],
    );

    expect(await docker("exec", sidecar, "id", "-u")).toBe("1000");
    const doctor = JSON.parse(await docker("exec", sidecar, "meshkeep", "--json", "doctor"));
    expect(doctor).toMatchObject({ ok: true, kuboVersion: "0.42.0" });
  });

  it("replicates a site added with docker exec, then follows new versions on its own", async () => {
    const added = JSON.parse(
      await docker("exec", sidecar, "meshkeep", "--json", "replicate", siteName),
    );
    expect(added).toMatchObject({ cid: V1_CID, blocks: 8 });
    await waitForEvent("the daemon to check v1", (e) => e.event === "current" && e.cid === V1_CID);

    await meshkeep("publisher", "publish", join(FIXTURES, "site-v2"), "--key", "site");
    const updated = await waitForEvent(
      "the daemon to replicate v2",
      (e) => e.event === "updated" && e.cid === V2_CID,
    );
    expect(updated).toMatchObject({ name: siteName, sequence: 1, versions: 2 });
    expect(await cluster.node("replica").kubo.isPinnedRecursively(V2_CID)).toBe(true);
  });

  it("stops cleanly on docker stop", async () => {
    await docker("stop", "--time", "20", sidecar);

    expect(await docker("inspect", "--format", "{{.State.ExitCode}}", sidecar)).toBe("0");
    expect((await events()).at(-1)).toMatchObject({ event: "stopped" });
  });
});
