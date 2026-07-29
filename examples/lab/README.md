# Meshkeep immutable CID Kubo lab

This lab proves the immutable-content subset of the planned Meshkeep lifecycle. It does **not** prove IPNS publication, signed update validation, publishing-key migration, independent physical hosts, or the hard MVP.

## Proven behavior

A successful run:

1. validates all eight fixture SHA-256 checksums;
2. selects `linux/amd64`, requires the pinned OCI index digest in local `RepoDigests`, and verifies the actual image platform and Kubo version;
3. initializes three disposable repositories with Kubo's `test` profile and observes repository version 18 from each repository's version file;
4. applies and verifies all ten required `unixfs-v1-2025` fields on every repository while allowing unrelated Kubo config fields;
5. explicitly disables and verifies routing, providing, bootstrap, mDNS, and telemetry, then proves at runtime that no DHT is active;
6. starts publisher + two replicas on a unique internal Docker network with no host ports;
7. manually swarm-connects each replica to the publisher;
8. imports v1 repeatedly and independently and requires the committed CID;
9. recursively pins v1 on both replicas and compares every reachable CID;
10. stops the publisher and verifies `pin verify`, reachable blocks, and four file hashes on each replica;
11. restarts the publisher, repeats the transfer for v2, stops it again, and verifies both v1 and v2 remain complete on both replicas;
12. removes the three captured container IDs, captured network ID, and temporary repository root; requires successful global/name/label Docker listings proving IDs, names, run labels, and the root are absent; and only then finalizes optional passing evidence.

Kubo RPC and gateway listen only on container loopback. Only libp2p swarm TCP 4001 is reachable between nodes on the internal Docker network. Nothing is published to the host, public DHT, bootstrap peers, or the user's `~/.ipfs`.

## Requirements

- Linux shell with Bash;
- Docker Engine;
- Python 3, `sha256sum`, `sort`, `cmp`, and GNU `timeout`;
- enough temporary capacity for three 384 MiB-bounded Kubo containers.

The script pulls the pinned Kubo image only if it is missing locally. It does not require buildx or a live registry descriptor lookup when the image is already present. Docker's engine-local image ID and optional local descriptor are observations, not substitutes for the OCI index digest. Descriptor state is recorded neutrally as `present` or `unavailable`; absence does not identify Docker's image-store backend.

## Run

From the repository root:

```bash
./examples/lab/run-lab.sh
```

To atomically write/replace the committed-style evidence file only after a complete pass:

```bash
./examples/lab/run-lab.sh \
  --write-results examples/lab/results/immutable-cid-lab.json
```

Expected milestone output:

```text
Fixtures: PASS (8 files)
Kubo image: PASS (0.42.0, linux/amd64, index sha256:8907...)
Profiles: PASS (10 import fields, repo version 18, routing/providing disabled on 3 repos)
Nodes: PASS (3 ready, zero host ports, internal network, no active DHT)
Swarm: PASS (two explicit connections; Bitswap transfer with routing disabled)
v1 online: PASS (..., 8 reachable blocks)
v1 origin-offline: PASS (2 replicas, complete graph and 4 file checksums each)
v2 online: PASS (..., 8 reachable blocks)
v1+v2 origin-offline: PASS (both replicas retain both immutable versions)
Cleanup: PASS (3 container IDs, network ID, run labels, names, and temporary root absent)
Results: examples/lab/results/immutable-cid-lab.json
Lab: PASS
```

Expected root CIDs:

- v1: `bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki`
- v2: `bafybeiczekoh2tsak4wy6hhuxr7tmmaqpjfrh5yqckq4rzmnavkk6k5hwq`

They are roots of `/fixtures/v1` and `/fixtures/v2`; no extra wrapper directory or legacy UnixFS flags are added.

## Import profile

The script applies Kubo `config profile apply unixfs-v1-2025` and checks these committed profile fields before starting any daemon:

- CIDv1;
- raw UnixFS leaves;
- SHA2-256;
- 1 MiB chunks;
- balanced DAG layout;
- zero fixed links per directory before HAMT conversion;
- 1,024 links per file node;
- HAMT fanout 256, block-based threshold estimation, 256 KiB threshold.

It deliberately does not pass `--raw-leaves=false`, `--cid-version=0`, a 256 KiB chunker, or other flags that would override the profile.

## Failure behavior

Any mismatch or failed operation exits non-zero. The successful path makes cleanup a verified pass condition and propagates removal or Docker-query failures. On failure or interruption, an EXIT fallback prints at most 80 recent log lines per captured/run-scoped container and attempts removal by captured ID first, then exact names and the unique run label. Every disposable Kubo helper has the same unique labels, so interrupted `--rm` helpers remain discoverable. If Docker cannot be queried, scoped resources cannot be enumerated, or removal/verification fails, fallback prints `INCOMPLETE`; it never turns uncertainty into a passing run.

Useful safe failure checks:

- change one fixture byte: checksum validation must fail before Docker nodes start;
- change an expected root CID in a temporary copy of `manifest.json`: import must fail before replication is accepted;
- use an unwritable result destination: content and cleanup can pass, but result finalization must fail without printing `Lab: PASS` or replacing an existing target;
- interrupt the script: the EXIT fallback attempts to remove containers, internal network, and temporary repositories.

After an interrupted run, confirm no resources remain:

```bash
containers=$(docker ps -a --format '{{.Names}}') || { printf 'Docker container query failed\n' >&2; exit 1; }
networks=$(docker network ls --format '{{.Name}}') || { printf 'Docker network query failed\n' >&2; exit 1; }
volumes=$(docker volume ls --format '{{.Name}}') || { printf 'Docker volume query failed\n' >&2; exit 1; }

if grep -q '^meshkeep-lab-' <<< "$containers" ||
  grep -q '^meshkeep-lab-' <<< "$networks" ||
  grep -q 'meshkeep-lab' <<< "$volumes"; then
  printf 'Meshkeep lab resources remain\n' >&2
  exit 1
fi
```

No output is expected.

## Evidence and limitations

`results/immutable-cid-lab.json` uses result format v2 and is replaced through a unique same-directory temporary file only after cleanup verification. It records the requested and actual image platform, verified expected public OCI reference/digest, engine image ID and neutral optional descriptor observations, per-role repository versions, routing/providing state, cleanup assertions, complete v1/v2 evidence, and sanitized provenance. Local mirror names observed during `RepoDigests` validation are not persisted. Provenance contains selected Docker/runner/tool versions and pre-run SHA-256 values for `run-lab.sh` and `manifest.json`; it omits hostname, username, repository paths, Git state, Docker daemon identity/root/proxies/registries, peer IDs, and IP addresses.

The temporary file is fsynced before `os.replace`; that atomic replacement is the result's visibility commit point. The script then fsyncs the containing directory where supported. An unexpected directory-fsync failure after replacement can therefore leave a complete new result visible while the command exits non-zero and prints neither `Results:` nor `Lab: PASS`.

This is one-host container isolation, not separate operators or machines. CID transfer uses explicit libp2p connections, not IPNS. The next lab must introduce disposable IPNS signing, signed v1→v2 resolution, secure key transfer to a second publisher environment, stale/invalid record failures, and only then claim the hard MVP.
