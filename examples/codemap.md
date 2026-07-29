# examples/

## Responsibility

`examples/` contains non-normative, disposable inputs and the reproducible manual Kubo lab. It demonstrates a bounded part of the Meshkeep lifecycle without defining protocol behavior.

- `demo-site/` is a self-contained page reserved for a future publication test. It is not an input to the current immutable-CID lab.
- `lab-fixtures/v1/` and `lab-fixtures/v2/` are the two deterministic static directory trees imported by the lab. Each version has four files at the same relative paths.
- `lab/` owns the immutable runner plus a separate signed-IPNS/key-transfer runner, their non-overlapping committed expectations, instructions, and generated evidence snapshots.
- `lab/four-host/` is an unexecuted operator kit that references those expectations and emits only sanitized local role checks; it is not another runner or result.

Normative schemas and interoperability fixtures belong under `spec/`, not here. Protocol, CLI, and Kubo lifecycle implementation also remain outside this directory.

## Design

The example data is intentionally small and auditable. The lab treats fixture bytes and relative paths as identity-bearing inputs rather than as a site to build or transform. The v1 and v2 trees model two immutable releases; text inside those files is fixture content, not evidence that signing or IPNS occurred.

Four layers are deliberately coupled:

1. `lab-fixtures/` supplies the exact bytes and directory structure.
2. `lab/manifest.json` pins every fixture SHA-256, expected root CIDs, all ten required `unixfs-v1-2025` fields, the Kubo version/repository version, OCI index digest, and requested platform.
3. `lab/run-lab.sh` rejects drift in those inputs and verifies image/repository identity, disabled routing/providing, imports, complete reachable graphs, recursive pins, retrieved bytes, and fail-closed ID/name/label cleanup. All disposable Kubo containers share the unique run labels.
4. `lab/results/immutable-cid-lab.json` is a sanitized dated v2 snapshot made visible at the post-cleanup `os.replace` commit point, recording bounded image/configuration observations, input and environment provenance, CIDs, reachable-block counts, isolation facts, and limitations.

The Phase 3 path adds `lab/ipns-manifest.json`, `lab/run-ipns-lab.sh`, `lab/IPNS.md`, and `lab/results/ipns-key-transfer-lab.json`. It reuses layer 2 rather than duplicating Kubo/profile/fixture truth, and adds only native IPNS settings, private-DHT/EOL/HTTP bounds, same-name key-transfer evidence, negative observations, local gateway serving, and same-network RPC-boundary checks.

Changing fixture bytes, paths, import settings, or Kubo identity can change the release CID and requires all committed expectations and evidence to be reconsidered together. The results file is evidence of one run, not an independent source of protocol truth.

## Flow

`run-lab.sh` reads `lab/manifest.json`, validates the files below `lab-fixtures/`, and mounts those fixtures read-only into three disposable Kubo containers. The publisher imports each fixture version; two explicitly connected replicas fetch by Bitswap and recursively pin its complete graph while routing and providing are disabled. The runner stops the publisher, rechecks graph completeness and file hashes, explicitly removes and verifies every run resource, and only then can atomically replace result v2.

The lab never consumes `demo-site/`, invokes a site build, or mutates fixture content.

The IPNS runner uses four same-host nodes. Publisher A signs sequence-0 v1, two replicas resolve/directly inspect/pin it, and a network-disabled owner-only cleartext transfer moves a disposable named key to stopped publisher B. B signs sequence-1 v2 under the same name; replicas retain both graphs after both publishers stop. Inspect fields, exact one-second TTL, publication-bracketed EOL, semantic status-1 diagnostics, successful complete pin-list absence, and post-routing-put selected-record state bound the negative evidence. After both publishers stop, BusyBox verifies every fixture file through replica-loopback `/ipfs` and current `/ipns` gateway paths; it also requires absent-record HTTP 200 before cached-only target HTTP 412. Local API POSTs validate each replica identity/version in memory, while cross-container requests prove same-network no-HTTP refusal with successful name resolution. Invalid-signature, stale, malformed, and unavailable-target observations are native Kubo behavior, not protocol policy.

The four-host kit adds no executed flow. Its preflight checks one local environment/repository/image without mutation; its role verifier checks one local phase and can atomically write one sanitized local object. All repository configuration, Docker starts/stops/removal, directed dials, cross-host probes, external key handoff, and aggregate evidence assembly remain explicit operator actions.

## Integration

The example lab integrates directly with Docker Engine and the pinned Kubo container image. It does not call Meshkeep protocol or CLI packages, use the user's IPFS repository, or require a Meshkeep-operated service. Its Docker networks are internal, peers are connected explicitly, host-port queries must complete with empty output, and the IPNS runner requires exact API/gateway loopback binds. Docker-internal DNS is used for configured `/dns4` peers and bounded cross-container API-refusal probes while Kubo custom/public resolvers remain absent. These are same-host namespace checks, not independent-host gateway or firewall evidence.

See `lab/codemap.md` for phase-by-phase control flow, boundaries, outputs, and claim limits.
