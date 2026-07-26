# examples/lab/

## Responsibility

This directory is a reproducible manual integration lab for Meshkeep's immutable-content subset. It establishes that two fixed static directory graphs have deterministic CIDs under one pinned Kubo/import configuration, can be recursively transferred to two replicas, and remain complete and readable there after the publisher stops.

File roles:

- `run-lab.sh`: fail-closed orchestration and verification.
- `manifest.json`: committed input contract for Kubo identity, repository version, import profile fields, fixture hashes, and expected root CIDs.
- `README.md`: operator instructions, expected milestones, failure checks, and claim limits.
- `results/immutable-cid-lab.json`: sanitized evidence from the last committed successful run.
- `../lab-fixtures/{v1,v2}/`: exact immutable input trees; each contains `index.html`, CSS, JavaScript, and a text asset.

## Design

### Determinism and evidence coupling

The lab has no build step and adds each fixture version directory directly, without an extra wrapper or legacy import overrides. Before any node starts, the runner requires exactly the eight manifest-listed regular, non-symlink files and checks their SHA-256 values. It then applies `unixfs-v1-2025` to every repository and compares the active Kubo `Import` fields with the manifest.

Determinism is checked at several levels:

- the Docker image digest, expected image ID, Kubo version, and repository version are committed inputs; the script verifies the image ID and Kubo version but currently copies the expected repository version into results without observing each initialized repository;
- the profile commits CIDv1, SHA2-256, raw leaves, 1 MiB chunks, balanced layout, file-link limits, and HAMT settings;
- v1 must match its expected root CID on a repeated publisher import and an independent replica `--only-hash` import;
- v2 must match its expected root CID and an independent replica `--only-hash` import;
- each replica's sorted, unique reachable CID set must equal the publisher's set;
- content fetched through each root must match all manifest file hashes.

The coupling is therefore:

`fixture paths + bytes` → `manifest hashes + import/Kubo identity` → `expected root CIDs` → `runtime graph and content checks` → `optional result evidence`.

The optional result includes a wall-clock verification date, but that date does not participate in fixture import or CID identity.

### Docker and Kubo integration

The runner creates three temporary Kubo repositories and three containers: `publisher`, `replica1`, and `replica2`. Repository setup runs with networking disabled, applies Kubo's `test` profile followed by `unixfs-v1-2025`, binds API and gateway addresses to container loopback, leaves only swarm TCP 4001 available inside Docker, removes bootstrap peers, and disables telemetry.

The daemons run on a unique Docker `--internal` network. No host port is published. Replicas receive the publisher's peer ID and connect to its internal DNS alias explicitly. Bootstrap is empty and the internal network blocks public routing, although Kubo's internal DHT mode is not explicitly disabled or inspected. Fixture directories are mounted read-only, while repositories live under a mode-restricted temporary host directory and are targeted for deletion on exit.

Containers run as UID/GID 1000 with a read-only root filesystem, a bounded no-exec temporary filesystem, all capabilities dropped, `no-new-privileges`, and memory, CPU, PID, and stop-time limits. Kubo RPC and gateway listeners are not exposed between containers or to the host.

## Flow

`run-lab.sh` executes these ordered phases under `set -euo pipefail`; any failed assertion exits non-zero and triggers cleanup:

1. Parse the sole optional `--write-results` argument and require local tools.
2. Parse and validate the manifest format, expected CID shapes, and required metadata.
3. Create a private temporary root, unique resource names, and an EXIT cleanup trap.
4. Enumerate safe relative fixture paths, require exactly eight records, and verify every file hash before starting Docker nodes.
5. Pull the digest-pinned Kubo image only when absent, then verify its image ID and reported Kubo version.
6. Initialize and configure three isolated repositories with networking disabled; verify import settings and empty bootstrap lists.
7. Create the internal network, start hardened containers, and wait for all daemons to answer `ipfs id`.
8. Explicitly swarm-connect both replicas to the publisher and verify each connection.
9. Import v1, prove repeat and independent CID agreement, recursively pin it on all nodes, compare reachable block sets, and verify all files.
10. Stop the publisher; re-verify both replicas' recursive pin, complete reachable set, and file bytes.
11. Restart and reconnect the publisher; import and replicate v2 with an independent CID check.
12. Stop the publisher again; verify that both replicas retain complete v1 and v2 graphs and content.
13. If requested, create a result JSON through a fixed `.partial` file and rename it into place after content checks pass but before cleanup runs.
14. Print the final pass milestone and attempt to remove containers, the internal network, and temporary repositories through the EXIT trap. Cleanup errors are currently suppressed and do not invalidate passing evidence.

The publisher pins before replicas fetch. Replicas use recursive `pin add`; root-pin presence, `pin verify`, complete reachable-CID equality, and file hashes together guard against treating a root-only pin as complete replication.

## Integration

### Security boundaries

- Fixture paths from the manifest must be relative and may not contain `..`; listed inputs must be regular, non-symlink files with committed hashes.
- Temporary files default to owner-only access via `umask 077`; no user `~/.ipfs` repository is used.
- Node traffic is confined to one internal Docker network. API and gateway remain on each container's loopback, bootstrap is empty, telemetry is off, and no host ports are mapped.
- The only image acquisition is an explicit Docker pull of the digest-pinned image when it is not already local. There is no gateway, resolver, pinning-service, or public-peer fallback for content transfer.
- Docker Engine and the local host remain trusted infrastructure. Container separation on one host is not equivalent to independent operators or machines.
- Failure cleanup prints up to 80 recent log lines per started container, then removes resources scoped to the unique run. Successful evidence omits peer IDs, container addresses, temporary paths, and host-identifying data.

### Outputs

Normal stdout is a sequence of human-readable `PASS` milestones for fixtures, image, profiles, nodes, swarm, online replication, origin-offline retention, optional result location, overall lab status, and cleanup. Content-check failures emit an `ERROR` and recent Kubo logs to stderr and return non-zero. Cleanup failures are not currently propagated and can still print `Cleanup: PASS`.

No persistent artifact is produced by default. With `--write-results PATH`, passing content checks write `meshkeep-immutable-cid-lab-result-v1` JSON containing the expected Kubo repository version, verified binary/image checks, isolation summary, profile, v1/v2 CIDs and reachable-block counts, replica checks, date, and explicit limitations. The runner attempts to remove containers, the network, and temporary repositories regardless of success, but does not verify or propagate cleanup failure.

### What this lab does not prove

This lab does **not** prove:

- IPNS publication or resolution, signed update creation or validation, publisher identity, or publishing-key transfer;
- stale, malformed, unsupported, or invalid signed-record rejection;
- independent physical hosts, operators, or failure domains;
- public-network discovery, DHT behavior, gateway/HTTP behavior, or availability after all willing replicas leave;
- anonymity, censorship resistance, permanent availability, deletion, content safety, freshness, or a canonical HTTP origin;
- the complete Meshkeep hard MVP, protocol/CLI interoperability, or production scalability and performance.

It proves only the bounded immutable UnixFS import, transfer, recursive retention, and origin-offline read checks performed by this one-host Docker run. Fixture prose that mentions signing or IPNS does not expand that claim.
