# examples/lab/

## Responsibility

This directory contains two reproducible manual Kubo labs: the immutable-content baseline and a separate same-host signed-IPNS/disposable-key-transfer precursor. Together they observe deterministic immutable graphs, native Kubo signed-name continuity, complete replica retention, and bounded negative paths without defining Meshkeep protocol semantics or claiming independent-machine evidence.

File roles:

- `run-lab.sh`: fail-closed orchestration and verification.
- `run-ipns-lab.sh`: four-node private-DHT, signed-IPNS, key-transfer, and native negative-path orchestration.
- `manifest.json`: v2 input contract for the digest-pinned Kubo index, requested platform, repository version, ten import profile fields, fixture hashes, and expected root CIDs.
- `ipns-manifest.json`: IPNS-only settings, bounds, and references/expectations that are not owned by the immutable manifest.
- `README.md`: operator instructions, expected milestones, failure checks, and claim limits.
- `IPNS.md`: Phase 3 operator procedure, key-handling warning, native Kubo observations, and limitations.
- `results/immutable-cid-lab.json`: sanitized evidence from the last committed successful run.
- `results/ipns-key-transfer-lab.json`: sanitized evidence from the last successful signed-IPNS run, when present.
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

The IPNS runner validates and reuses this complete immutable contract. Its small manifest owns only the disposable key name/type, sequence/lifetime/TTL values, two-second EOL bracket tolerance, bounded resolve settings, and expected replica/publisher/block counts. Its result also hashes the runner and both manifests, but never the exported key, raw records, or temporary diagnostics.

### Docker and Kubo integration

The runner creates three temporary Kubo repositories and three containers: `publisher`, `replica1`, and `replica2`. Repository setup runs with networking disabled, applies Kubo's `test` profile followed by `unixfs-v1-2025`, binds API and gateway addresses to container loopback, leaves only swarm TCP 4001 available inside Docker, removes bootstrap peers, and disables telemetry.

The daemons run on a unique Docker `--internal` network. No host port is published. Replicas receive the publisher's peer ID and connect to its internal DNS alias explicitly. Routing is `none`, providing and mDNS are disabled, bootstrap is empty, and a bounded runtime command must return Kubo 0.42's exact `routing service is not a DHT` failure. Explicit swarm connections still permit Bitswap transfer. Fixture directories are mounted read-only, while repositories live under a mode-restricted temporary host directory.

Containers run as UID/GID 1000 with a read-only root filesystem, a bounded no-exec temporary filesystem, all capabilities dropped, `no-new-privileges`, and memory, CPU, PID, and stop-time limits. Kubo RPC and gateway listeners are not exposed between containers or to the host.

The IPNS runner creates publisher A, publisher B, and two replicas on an internal network. All four are private `dhtserver` nodes with configured peering entries and exact unique expected-active-peer-set mesh assertions: all four minus self initially, then B plus both replicas minus self after transfer. Successful swarm-peer queries are captured and parsed; duplicate, unexpected, or missing IDs fail. Public/delegated discovery and publication, custom/public Kubo DNS resolvers, providing, HTTP retrieval, gateway routing/fetching, mDNS, pubsub, NAT traversal/relays, telemetry, and host ports are disabled. Docker-internal DNS is intentionally used for `/dns4` role aliases. Successful DHT closest-peer samples must contain nonempty exact captured lab identities only; this is not routing-table membership evidence. Identities and addresses are never persisted in results.

Key export/import runs only while both publisher daemons are stopped, through run-labeled `--network none` helpers. The cleartext transfer file is temporarily persisted owner-only, never printed or hashed, mounted read-only for import, and deleted before B starts. A successful complete key listing must then omit A's named key. Ordinary deletion is explicitly not claimed as secure erasure.

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

`run-ipns-lab.sh` follows the same immutable import/completeness checks, then publishes sequence-0 v1 from A, transfers the disposable named key, and publishes sequence-1 v2 from B under the same public name. Both replicas resolve with cache bypass and bounded DHT options, retain raw records only under the owner-only temporary root, and parse Kubo 0.42's direct `Entry` and `Validation` fields. It requires exact values/sequences/names, `Validation.Valid`, one-second TTL as `1000000000` nanoseconds, and EOL bracketed by each captured publication interval plus ten minutes and a two-second tolerance. Native negatives mutate protobuf `SignatureV2`, replay valid unexpired v1 after v2, submit malformed bytes, and resolve an IPNS pointer to an unavailable `--only-hash` CID. Invalid/stale/malformed puts require status 1 and exact bounded Kubo diagnostics. Missing-pin absence requires a successful complete recursive-pin listing. Kubo 0.42's lower-level `routing put` must report exactly status zero for the mutated record, so evidence records only a post-routing-put selected-record observation: separate status plus byte-identical valid-v2 postcondition, with no rejection, storage-absence, or non-propagation claim.

## Integration

### Security boundaries

- Fixture paths from the manifest must be relative and may not contain `..`; listed inputs must be regular, non-symlink files with committed hashes.
- Temporary files default to owner-only access via `umask 077`; no user `~/.ipfs` repository is used.
- In `run-lab.sh`, node traffic is confined to one internal Docker network; API/gateway stay on loopback, routing/providing/mDNS are disabled, bootstrap is empty, telemetry is off, and no host ports are mapped.
- In `run-ipns-lab.sh`, the same host/network/listener boundary applies, but routing is the explicitly bounded private `dhtserver` mesh described above; providing, public/delegated routing, custom Kubo resolvers, mDNS, and telemetry remain disabled.
- The only image acquisition is an explicit Docker pull of the digest-pinned image when it is not already local. There is no gateway, resolver, pinning-service, or public-peer fallback for content transfer.
- Docker Engine and the local host remain trusted infrastructure. Container separation on one host is not equivalent to independent operators or machines.
- Every Kubo helper and daemon carries the unique run label. Cleanup uses captured IDs as authority and exact names/run labels only for secondary verification and fallback. Every decisive Docker listing preserves status; query, enumeration, removal, or final verification uncertainty makes successful cleanup fail and makes fallback print `INCOMPLETE`. Failure cleanup prints at most 80 recent log lines per scoped container. Successful evidence omits peer IDs, container addresses, temporary paths, local mirror names, Git state, Docker daemon identity/root/network configuration, and host-identifying data.
- The IPNS result additionally omits private-key bytes/hashes/paths, raw records, bounded semantic diagnostics, and the temporary public-peer topology. Raw records, diagnostics, and cleartext transfer artifacts are temporarily persisted in owner-only areas, then disappear with verified temporary-root cleanup before result finalization.

### Outputs

Normal stdout is a sequence of human-readable `PASS` milestones for fixtures, image, profiles, nodes, swarm, online replication, origin-offline retention, verified cleanup, optional result location, and overall lab status. Failures emit an `ERROR` or command diagnostic and return non-zero. `Cleanup: PASS` reflects explicit removal and absence checks, and `Lab: PASS` appears only after optional result finalization.

No persistent artifact is produced by default. With `--write-results PATH`, a fully cleaned run writes `meshkeep-immutable-cid-lab-result-v2` JSON containing portable image identity, local engine observations, per-role repository versions, configuration/runtime isolation, cleanup assertions, profile and v1/v2 evidence, sanitized environment/tool provenance, input hashes, date, and explicit limitations. A unique same-directory temporary file and file fsync protect the prior result until `os.replace`, which atomically makes the new result visible. Linux directory fsync follows where supported; an unexpected failure there can leave the valid replacement visible while the command remains failed and emits no result/lab pass milestone.

The IPNS runner uses the same post-cleanup atomic pattern for `meshkeep-ipns-key-transfer-lab-result-v1`. Its output adds the sanitized public name, sequence/signature/key-continuity observations, complete offline replica evidence, native negative booleans, a separate post-routing-put selected-record observation, bounded closest-peer/config isolation, transfer cleanup, three input hashes, and explicit same-host/semantic limitations.

### Immutable runner limitations

`run-lab.sh` does **not** prove:

- IPNS publication or resolution, signed update creation or validation, publisher identity, or publishing-key transfer;
- stale, malformed, unsupported, or invalid signed-record rejection;
- independent physical hosts, operators, or failure domains;
- public-network discovery, DHT behavior, gateway/HTTP behavior, or availability after all willing replicas leave;
- anonymity, censorship resistance, permanent availability, deletion, content safety, freshness, or a canonical HTTP origin;
- the complete Meshkeep hard MVP, protocol/CLI interoperability, or production scalability and performance.

It proves only the bounded immutable UnixFS import, transfer, recursive retention, and origin-offline read checks performed by its one-host Docker run. Fixture prose that mentions signing or IPNS does not expand that claim.

### IPNS precursor limitations

`run-ipns-lab.sh` does observe native Kubo signed IPNS publication/resolution, same-name disposable key transfer, two complete retained graphs after both publishers stop, and bounded invalid-signature/stale/malformed/unavailable-target paths. It does **not** prove independent physical hosts/operators/failure domains, public-DHT routing-table membership or propagation, secure key erasure/custody, gateway HTTP access, interrupted synchronization, Meshkeep freshness/rollback/version policy, protocol/CLI interoperability, or the complete hard MVP.
