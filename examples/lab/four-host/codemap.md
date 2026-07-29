# examples/lab/four-host/

## Responsibility

This directory is an unexecuted, non-normative operator kit for a future four-environment Kubo run. It is not an all-host orchestrator and does not establish hard-MVP evidence. It reuses the committed immutable and signed-IPNS manifests rather than defining fixture, CID, profile, or IPNS truth.

## Files

- `manifest.json`: strict non-secret v1 contract for hash-pinned source manifests, roles, platform/image/repository baseline, direct non-NAT pnet/TCP assumptions, hardened containers, ports, phases, timeouts, and size bounds.
- `preflight.sh`: bounded local host/repository/image metadata verifier. It never executes or pulls the image and never opens `swarm.key`.
- `verify-role.sh`: bounded local phase verifier using status-preserving Docker queries and individual Kubo config/API/content commands. It issues no explicit dial or runtime mutation command, but Kubo queries may use established swarm/runtime state and affect Kubo or operating-system caches.
- `evidence-template.json`: aggregate `not-run` skeleton containing no observation.
- `README.md`: operator-owned configuration, starts, 12 dials, lifecycle, external key-handoff boundary, cross-host probes, cleanup, and manual evidence assembly.

## Data flow and trust boundaries

```text
../manifest.json + ../ipns-manifest.json + four-host/manifest.json
        ├──> preflight.sh + local repo/key metadata + local Docker image inspection
        └──> verify-role.sh + local mode-0600 peer sheet + one local container/host boundary
                    └──> one sanitized stdout object and optional owner-only no-clobber local evidence

operator-only actions
        ├──> repo configuration and Docker lifecycle
        ├──> 12 directed literal-IP swarm dials and cross-host transport probes
        ├──> authenticated E2E encrypted publishing-key handoff and cleartext-artifact removal outside the kit
        └──> manual reconciliation into an external copy of evidence-template.json
```

Peer IDs, IP addresses, repository/evidence paths, UID/GID values, API bodies, raw IPNS records, full Kubo config, Docker daemon identity, and key bytes/hashes never enter helper output. Peer sheets and any executed evidence remain local and uncommitted by default.

## Verification coverage

`preflight.sh` validates strict arguments, Linux/amd64, stable Docker client/server >=28, a normalized local Unix-socket Docker endpoint, the exact locally present digest/platform mapped by the hash-pinned committed manifest to Kubo 0.42.0, repository version 18, exact repository UID/GID/mode, equal direct bind/announce endpoints, and exact mode-0600 pnet-key UID/GID metadata without opening the key.

`verify-role.sh` validates strict phase inputs, hash-pinned source manifests, a local Unix-socket Docker endpoint, and the four-entry TCP-only peer sheet before querying the daemon. Non-cleanup phases inspect the exact image/container/mount/state/port/resource/hardening contract, exact image-default-plus-required-overlay environment, exact repository/key UID/GID metadata, and pnet metadata. Running roles additionally check 29 individual Kubo config keys, bounded local loopback API identity/version, exact host-loopback port-5001 `ECONNREFUSED`, and exact active peer IDs. Active replicas in publication phases check bounded recursive pins, `pin verify`, eight reachable blocks, fixture hashes, current signed IPNS value/sequence, v1 retention, and bounded host-loopback gateway bodies. Streaming API, content, and IPNS pipelines preserve each producer/consumer status under an outer timeout and suppress parser diagnostics. These local Kubo queries may communicate through established runtime state and affect caches. Stopped roles deliberately report zero runtime config/content checks rather than inventing observations. Cleanup verifies only classified container absence.

Optional role evidence accepts only an existing unrelated owner mode-0700 directory, derives a fixed run/role/phase filename, and uses a mode-0600 same-directory temporary file, file fsync, no-clobber hard-link publication, and directory fsync for bounded sanitized JSON. Cleanup cannot write evidence. No helper creates an aggregate result, directly orchestrates a remote host, invokes file transfer, explicitly dials a peer, replaces evidence, removes resources, or issues explicit Docker/Kubo/repository/firewall mutation commands. Ordinary deletion is not secure erasure, and helpers do not verify deletion of publishing-key transfer artifacts.

## Limitations

Fake backends can validate fail-closed parsing/query/output behavior, but only a real four-host operator run can establish independent environments, cross-host routing and port boundaries, external key handoff, publisher shutdown, gateway access, complete replication, and cleanup. `evidence-template.json` is proof of none of those outcomes.
