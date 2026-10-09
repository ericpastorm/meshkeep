/** UnixFS import profile that defines a site version's identity. See ADR 0002. */
export const UNIXFS_PROFILE = "unixfs-v1-2025";

/** Kubo `Import` config values that `unixfs-v1-2025` sets. A publisher must match all of them. */
export const UNIXFS_PROFILE_IMPORT_CONFIG = {
  CidVersion: 1,
  HashFunction: "sha2-256",
  UnixFSChunker: "size-1048576",
  UnixFSDAGLayout: "balanced",
  UnixFSDirectoryMaxLinks: 0,
  UnixFSFileMaxLinks: 1024,
  UnixFSHAMTDirectoryMaxFanout: 256,
  UnixFSHAMTDirectorySizeEstimation: "block",
  UnixFSHAMTDirectorySizeThreshold: "256KiB",
  UnixFSRawLeaves: true,
} as const;

/**
 * Default IPNS record lifetime. Long, so that replicas can keep a name resolvable for a year
 * after the publisher disappears by re-putting the last signed record.
 */
export const DEFAULT_RECORD_LIFETIME = "8760h";

/** Default cache hint for resolvers. Short, so updates propagate quickly. */
export const DEFAULT_RECORD_TTL = "5m";

/**
 * DHT nodes drop stored records after roughly 48 hours, so replicas should re-put the latest
 * record at least this often.
 */
export const RECOMMENDED_REPUBLISH_INTERVAL_HOURS = 12;
