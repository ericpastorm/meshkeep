# Signed IPNS and disposable key-transfer lab

This is a separate Phase 3 precursor to the immutable-CID lab. It exercises native Kubo 0.42.0 IPNS records, cleartext named-key export/import, replica-local gateway serving, and same-network no-HTTP RPC failure—connection refusal or bounded inner timeout—across four hardened containers on one Docker host. It does not define Meshkeep protocol semantics and does not satisfy the independent-machine hard MVP criteria.

## What a passing run observes

1. The runner validates and reuses `manifest.json` as the sole owner of the pinned Kubo image/platform/repository version, ten-field `unixfs-v1-2025` profile, fixture hashes, and immutable v1/v2 CIDs.
2. Four repositories (`publisher-a`, `publisher-b`, `replica1`, and `replica2`) run on a Docker-internal network with exact loopback API/gateway listeners, status-checked empty `docker port` output, read-only container roots, dropped capabilities, and resource limits. Each replica immediately completes a local BusyBox POST to its own Kubo ID API and streams the response to a host validator that checks the captured identity, documented object fields, and `kubo/0.42.0` without persisting or printing the response. The other replica resolves the target's Docker alias but receives no HTTP response from port 5001; BusyBox status 1 must be uniquely classified as connection refusal or bounded inner timeout after the target's local probe and running-state checks succeed.
3. Each node is a `dhtserver` in a four-peer private LAN DHT. Bootstrap, custom/public Kubo DNS resolvers, delegated HTTP routing/publishing, autoconf, autotls, mDNS, IPNS pubsub, NAT mapping, hole punching, relays, HTTP retrieval, gateway fetching/DNSLink/routing exposure, bandwidth metrics, telemetry, and providing are disabled. Docker-internal DNS is intentionally used for the configured `/dns4/{role}` swarm aliases. Successful swarm-peer queries must parse to unique IDs whose exact set is all four active roles minus self initially and B plus both replicas minus self after transfer; any duplicate, unexpected, or missing ID fails. Successful closest-peer samples must contain one to four nonempty exact captured lab peer IDs and do not prove routing-table membership.
4. Publisher A creates a disposable named Ed25519 key and publishes v1 at sequence 0 with a 10-minute lifetime and one-second TTL. Both replicas resolve with cache bypass and bounded DHT settings, then inspect Kubo 0.42's direct `Entry` and `Validation` JSON fields. The runner requires `Validation.Valid=true`, the exact verification name/value/sequence, `Entry.TTL=1000000000`, and EOL within the publication start/end interval plus the 10-minute lifetime and a two-second scheduling/clock-sampling tolerance. It recursively pins all eight reachable blocks and retains/reads v1 after A stops.
5. While both publisher daemons are stopped, a network-disabled helper exports the key as `libp2p-protobuf-cleartext` into a mode-700 temporary directory and mode-600 file. Another network-disabled helper imports it into B. The runner proves name continuity and distinct Kubo node identities, removes A's named key, requires a successful complete key listing that omits it, and deletes the transfer artifact before continuing.
6. B observes v1, imports v2, and publishes sequence 1 under the same IPNS name. After TTL expiry, both replicas resolve and verify v2, recursively pin its eight-block graph, retain v1, and read both versions after both publishers stop.
7. Native negative observations cover a mutated `SignatureV2`, local stale-v1 replay, malformed protobuf, and a separately signed IPNS record whose `--only-hash` target has no available block. The mutated structured inspect must itself complete and report the expected name with `Validation.Valid=false`. Invalid-signature, stale-sequence, and malformed `name put` commands must complete with status 1 and exact bounded Kubo 0.42 diagnostics; timeout, signal, or Docker invocation failure is a lab failure. Immediately before stale replay, v1 is directly re-inspected as valid and unexpired; afterward the selected raw record must remain byte-identical valid v2. Missing-target pin absence comes only from a successful complete recursive-pin listing that omits the CID.
8. After both publishers are verifiably stopped and both replicas' complete graphs/files are rechecked, each replica serves all four files from v1 and v2 through local `/ipfs` paths and all four v2 files through the local `/ipns` path with `Gateway.NoFetch=true`. Every path gets one completed BusyBox `-S` request with exactly one HTTP 200 and no redirects, followed by a second body stream into host `sha256sum`; bodies are never stored. The valid sequence-1 record is recaptured, re-inspected, and byte-compared before `/ipns` serving. For the absent target, each local gateway must first return exactly one HTTP 200 for `?format=ipns-record`; only then may `Cache-Control: only-if-cached` produce BusyBox status 1 with final HTTP 412.

In the recorded run, invalid-signature `name put` returned status 1 with `Error: record validation failed: signature verification failed`; stale replay returned status 1 with `Error: existing IPNS record has sequence 1 >= new record sequence 0, use 'ipfs name put --force' to skip this check`; malformed put reported `Error: invalid IPNS record: record is malformed` followed by `proto: cannot parse invalid wire-format data`. Kubo 0.42.0's lower-level `routing put` returned status zero for the mutated record, and the runner requires exactly that status; a timeout, invocation error, or nonzero status fails the lab. This is recorded only as a **post-routing-put selected-record observation**: the command status is separate, and a subsequent raw read must remain byte-identical valid sequence-1 v2. The lab does not infer validator rejection, storage absence, or non-propagation from that observation.

## Requirements and run

Requirements are Bash, Docker Engine, Python 3, GNU `timeout`, `sha256sum`, `sort`, `cmp`, and capacity for four 384 MiB-bounded Kubo containers. HTTP probes use only `/bin/busybox wget` already present in the pinned Kubo image; no helper image or new dependency is used. Run from the repository root:

```bash
./examples/lab/run-ipns-lab.sh
```

Regenerate passing evidence only through a complete run:

```bash
./examples/lab/run-ipns-lab.sh \
  --write-results examples/lab/results/ipns-key-transfer-lab.json
```

Expected final milestones include:

```text
RPC boundary: PASS (2 local loopback POSTs; 2 same-network no-HTTP failures: 2 refused, 0 inner-timeout)
IPNS v1: PASS (sequence 0, signatures/EOL/TTL, 8 blocks, A offline, 2 replicas)
Key transfer: PASS (same public name, distinct node identity, A key query complete, owner-only cleartext artifact deleted)
IPNS v2: PASS (same name, sequence 1, signatures valid, 8 blocks, v1 retained)
Post-routing-put selected-record observation: PASS (routing put status 0; selected record byte-identical valid v2)
Negative observations: PASS (invalid signature, stale replay, malformed record, missing graph)
Publishers offline: PASS (both replicas retain/read complete v1 and v2 graphs)
Replica gateways: PASS (per replica: 4 /ipfs v1, 4 /ipfs v2, 4 /ipns v2 HTTP-200/hash checks; absent record 200 then target 412; publishers offline, NoFetch)
Cleanup: PASS (4 container IDs, network ID, labels, names, and owner-only temporary artifacts absent)
IPNS lab: PASS
```

## Key handling

The exported file contains an unencrypted private key. The runner temporarily persists it only in the owner-only transfer area; it never prints, hashes, dumps, fixtures, or includes its bytes in the result. It mounts the transfer directory only into network-disabled helpers, checks owner-only modes, imports through a read-only transfer mount, removes A's named key, and deletes the transfer file and directory before B starts. Raw public IPNS records and bounded Kubo diagnostics are likewise temporarily persisted under the owner-only lab root, removed before result finalization, and excluded from the result.

This procedure is only for generated disposable lab keys. Ordinary filesystem deletion is **not secure erasure**; storage snapshots, copy-on-write layers, backups, and host compromise may retain bytes. Do not use this workflow for a production key, and never use a result/log artifact to carry a key.

## Failure and cleanup behavior

Any failed assertion exits nonzero. The success path removes captured container/network IDs and the mode-restricted temporary root, then uses status-preserving global, exact-name, and unique-label Docker queries to prove absence before optional result replacement. All daemon and helper containers carry the unique run label. Failure/interruption cleanup discovers helpers by that label, prints at most 80 daemon log lines per scoped container, and reports `INCOMPLETE` if Docker cannot be queried or absence is uncertain. It cannot print `IPNS lab: PASS` on failure.

`MESHKEEP_IPNS_LAB_INJECT_CLEANUP_QUERY_FAILURE=1` is a test-only hook that fails after resource removal but before cleanup verification/result finalization. `MESHKEEP_IPNS_LAB_HELPER_HOLD_SECONDS=N` starts a run-labeled, network-disabled helper so an operator can interrupt the runner and verify fallback discovery. Do not set either variable during evidence generation.

Passing evidence is written to a unique same-directory temporary file, fsynced, and atomically made visible with `os.replace` only after cleanup. A later unsupported directory fsync is tolerated; an unexpected directory-fsync error may leave the complete replacement visible while the process exits without its final pass milestone.

## Evidence privacy and limitations

The result contains the public IPNS name, immutable CIDs, sequences, boolean validation/cleanup observations, the routing-put status, sanitized per-replica HTTP counts, unavailable-target statuses, local/cross-container RPC counts, image/Docker/tool versions, and SHA-256 hashes of the three non-secret input files. It excludes response bodies, headers, private-key bytes or hashes, transfer/temp paths, raw records, temporary diagnostics, peer IDs, IP addresses, role aliases, host/user names, Docker daemon identity/root/proxies/registries, and local mirror references.

The DHT consists of four containers on one host. Its evidence is limited to exact unique expected-active-peer-set mesh checks, exact-ID closest-peer samples, Docker-internal networking, verified configuration isolation, replica-loopback gateway/API access, and same-network no-HTTP API failure through connection refusal or bounded inner timeout. Local `/ipfs` and `/ipns` gateway serving with both publishers offline is tested, but no independent-host gateway URL, firewall, host-boundary, public-gateway, or independently operated environment is exercised. The lab also does not establish routing-table membership, public-DHT propagation, independent failure domains, production key custody, secure erasure, resource-limit policy, rollback/freshness policy, synchronization atomicity, or a Meshkeep release-version mapping. IPNS sequence numbers in this lab are native Kubo ordering inputs, not Meshkeep release versions.
