import { describe, expect, it } from "vitest";

import { type DeploymentManifestV1, SCHEMA_ID, UNIXFS_PROFILE, VERSION } from "./index.js";

describe("protocol constants", () => {
  it("describes the initial deployment manifest", () => {
    const manifest: DeploymentManifestV1 = {
      schema: SCHEMA_ID,
      siteId: "demo-site",
      sequence: 0,
      contentCid: "example-content-cid",
      previousManifestCid: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      unixfsProfile: UNIXFS_PROFILE,
      stats: { files: 1, bytes: 128 },
    };

    expect(VERSION).toBe("0.0.0");
    expect(manifest.schema).toBe(SCHEMA_ID);
    expect(manifest.unixfsProfile).toBe("unixfs-v1-2025");
  });
});
