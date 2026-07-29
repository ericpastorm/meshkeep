# examples/lab/

## Responsibility

This directory is a reproducible manual integration lab for Meshkeep's immutable-content subset. It establishes that two fixed static directory graphs have deterministic CIDs under one pinned Kubo/import configuration, can be recursively transferred to two replicas, and remain complete and readable there after the publisher stops.

File roles:

- `run-lab.sh`: fail-closed orchestration and verification.
- `manifest.json`: v2 input contract for the digest-pinned Kubo index, requested platform, repository version, ten import profile fields, fixture hashes, and expected root CIDs.
- `README.md`: operator instructions, expected milestones, failure checks, and claim limits.
- `results/immutable-cid-lab.json`: sanitized evidence from the last committed successful run.
- `../lab-fixtures/{v1,v2}/`: exact immutable input trees; each contains `index.html`, CSS, JavaScript, and a text asset.

## Design

### Determinism and evidence coupling

The lab has no build step and adds each fixture version directory directly, without an extra wrapper or legacy import overrides. Before any node starts, the runner requires exactly the eight manifest-listed regular, non-symlink files and checks their SHA-256 values. It then applies `unixfs-v1-2025` to every repository and compares the active Kubo `Import` fields with the manifest.

Determinism is checked at several levels:

- the OCI index digest, `linux/amd64` platform, Kubo version, and repository version are committed inputs; complete local image inspection and sorted `RepoDigests` validate the expected digest, but result v2 persists only the expected public reference/digest; actual platform, binary version, each repository's version file, Docker `.Id`, and neutral descriptor status/data are observed;
- the profile commits CIDv1, SHA2-256, raw leaves, 1 MiB chunks, balanced layout, zero fixed directory links, file-link limits, and HAMT settings through ten required fields;
- v1 must match its expected root CID on a repeated publisher import and an independent replica `--only-hash` import;
- v2 must match its expected root CID and an independent replica `--only-hash` import;
- each replica's sorted, unique reachable CID set must equal the publisher's set;
- content fetched through each root must match all manifest file hashes.

The coupling is therefore:

`fixture paths + bytes` → `manifest hashes + import/Kubo identity` → `expected root CIDs` → `runtime graph and content checks` → `optional result evidence`.

The optional result includes a wall-clock verification date, but that date does not participate in fixture import or CID identity.

### Docker and Kubo integration

The runner creates three temporary Kubo repositories and three containers: `publisher`, `replica1`, and `replica2`. Repository setup runs with networking disabled, applies Kubo's `test` profile followed by `unixfs-v1-2025`, binds API and gateway addresses to container loopback, leaves only swarm TCP 4001 available inside Docker, removes bootstrap peers, and disables telemetry.

The daemons run on a unique Docker `--internal` network. No host port is published. Replicas receive the publisher's peer ID and connect to its internal DNS alias explicitly. Routing is `none`, providing and mDNS are disabled, bootstrap is empty, and a bounded runtime command must return Kubo 0.42's exact `routing service is not a DHT` failure. Explicit swarm connections still permit Bitswap transfer. Fixture directories are mounted read-only, while repositories live under a mode-restricted temporary host directory.

Containers run as UID/GID 1000 with a read-only root filesystem, a bounded no-exec temporary filesystem, all capabilities dropped, `no-new-privileges`, and memory, CPU, PID, and stop-time limits. Kubo RPC and gateway listeners are not exposed between containers or to the host.

## Flow

`run-lab.sh` executes these ordered phases under `set -euo pipefail`; any failed assertion exits non-zero and triggers cleanup:

1. Parse the sole optional `--write-results` argument and require local tools.
2. Parse and validate the manifest format, expected CID shapes, and required metadata.
3. Create a private temporary root, unique resource names, and an EXIT cleanup trap.
4. Enumerate safe relative fixture paths, require exactly eight records, and verify every file hash before starting Docker nodes.
5. Reuse or platform-pull the digest-pinned Kubo image, require its index digest in local `RepoDigests`, verify platform/version, and capture only engine-local image observations.
6. Initialize three isolated repositories, safely observe version 18 from each version file, apply all ten required import fields, and verify routing/providing/bootstrap/mDNS/telemetry policy.
7. Create and capture the internal network ID, start and capture three hardened container IDs, wait for readiness, and prove no active DHT.
8. Explicitly swarm-connect both replicas to the publisher and verify each connection.
9. Import v1, prove repeat and independent CID agreement, recursively pin it on all nodes, compare reachable block sets, and verify all files.
10. Stop the publisher; re-verify both replicas' recursive pin, complete reachable set, and file bytes.
11. Restart and reconnect the publisher; import and replicate v2 with an independent CID check.
12. Stop the publisher again; verify that both replicas retain complete v1 and v2 graphs and content.
13. Explicitly remove all captured container and network IDs plus the temporary root, then require successful global/name/label Docker listings proving exact IDs, names, unique run labels, and the root are absent.
14. If requested, fsync and atomically replace result v2 through a unique same-directory temporary file; `os.replace` is the visibility commit point, followed by directory fsync where supported. Only complete success prints `Lab: PASS`. An EXIT fallback remains for failures and interruption.

The publisher pins before replicas fetch. Replicas use recursive `pin add`; root-pin presence, `pin verify`, complete reachable-CID equality, and file hashes together guard against treating a root-only pin as complete replication.

## Integration

### Security boundaries

- Fixture paths from the manifest must be relative and may not contain `..`; listed inputs must be regular, non-symlink files with committed hashes.
- Temporary files default to owner-only access via `umask 077`; no user `~/.ipfs` repository is used.
- Node traffic is confined to one internal Docker network. API and gateway remain on each container's loopback, routing/providing/mDNS are disabled, bootstrap is empty, telemetry is off, and no host ports are mapped.
- The only image acquisition is an explicit Docker pull of the digest-pinned image when it is not already local. There is no gateway, resolver, pinning-service, or public-peer fallback for content transfer.
- Docker Engine and the local host remain trusted infrastructure. Container separation on one host is not equivalent to independent operators or machines.
- Every Kubo helper and daemon carries the unique run label. Cleanup uses captured IDs as authority and exact names/run labels only for secondary verification and fallback. Every decisive Docker listing preserves status; query, enumeration, removal, or final verification uncertainty makes successful cleanup fail and makes fallback print `INCOMPLETE`. Failure cleanup prints at most 80 recent log lines per scoped container. Successful evidence omits peer IDs, container addresses, temporary paths, local mirror names, Git state, Docker daemon identity/root/network configuration, and host-identifying data.

### Outputs

Normal stdout is a sequence of human-readable `PASS` milestones for fixtures, image, profiles, nodes, swarm, online replication, origin-offline retention, verified cleanup, optional result location, and overall lab status. Failures emit an `ERROR` or command diagnostic and return non-zero. `Cleanup: PASS` reflects explicit removal and absence checks, and `Lab: PASS` appears only after optional result finalization.

No persistent artifact is produced by default. With `--write-results PATH`, a fully cleaned run writes `meshkeep-immutable-cid-lab-result-v2` JSON containing portable image identity, local engine observations, per-role repository versions, configuration/runtime isolation, cleanup assertions, profile and v1/v2 evidence, sanitized environment/tool provenance, input hashes, date, and explicit limitations. A unique same-directory temporary file and file fsync protect the prior result until `os.replace`, which atomically makes the new result visible. Linux directory fsync follows where supported; an unexpected failure there can leave the valid replacement visible while the command remains failed and emits no result/lab pass milestone.

### What this lab does not prove

This lab does **not** prove:

- IPNS publication or resolution, signed update creation or validation, publisher identity, or publishing-key transfer;
- stale, malformed, unsupported, or invalid signed-record rejection;
- independent physical hosts, operators, or failure domains;
- public-network discovery, DHT behavior, gateway/HTTP behavior, or availability after all willing replicas leave;
- anonymity, censorship resistance, permanent availability, deletion, content safety, freshness, or a canonical HTTP origin;
- the complete Meshkeep hard MVP, protocol/CLI interoperability, or production scalability and performance.

It proves only the bounded immutable UnixFS import, transfer, recursive retention, and origin-offline read checks performed by this one-host Docker run. Fixture prose that mentions signing or IPNS does not expand that claim.
