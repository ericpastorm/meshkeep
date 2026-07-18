export const VERSION = "0.0.0" as const;

export const SCHEMA_ID = "https://meshkeep.dev/spec/manifest-v1.schema.json" as const;

export const UNIXFS_PROFILE = "unixfs-v1-2025" as const;

export interface DeploymentStatsV1 {
  files: number;
  bytes: number;
}

/**
 * Initial unsigned deployment manifest. Signature semantics will be defined by a future ADR.
 */
export interface DeploymentManifestV1 {
  schema: typeof SCHEMA_ID;
  siteId: string;
  sequence: number;
  contentCid: string;
  previousManifestCid: string | null;
  createdAt: string;
  unixfsProfile: typeof UNIXFS_PROFILE;
  stats: DeploymentStatsV1;
}
