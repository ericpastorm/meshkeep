# Meshkeep immutable CID Kubo lab

This lab proves the immutable-content subset of the planned Meshkeep lifecycle. It does **not** prove IPNS publication, signed update validation, publishing-key migration, independent physical hosts, or the hard MVP.

## Proven behavior

A successful run:

1. validates all eight fixture SHA-256 checksums;
2. runs the exact Kubo image pinned in `manifest.json`;
3. initializes three disposable repositories with Kubo's `test` profile;
4. applies and verifies `unixfs-v1-2025` on every repository;
5. disables bootstrap, mDNS/autoconf from the test profile, and telemetry;
6. starts publisher + two replicas on a unique internal Docker network with no host ports;
7. manually swarm-connects each replica to the publisher;
8. imports v1 repeatedly and independently and requires the committed CID;
9. recursively pins v1 on both replicas and compares every reachable CID;
10. stops the publisher and verifies `pin verify`, reachable blocks, and four file hashes on each replica;
11. restarts the publisher, repeats the transfer for v2, stops it again, and verifies both v1 and v2 remain complete on both replicas;
12. removes all containers, network, and temporary repositories through an EXIT trap.

Kubo RPC and gateway listen only on container loopback. Only libp2p swarm TCP 4001 is reachable between nodes on the internal Docker network. Nothing is published to the host, public DHT, bootstrap peers, or the user's `~/.ipfs`.

## Requirements

- Linux shell with Bash;
- Docker Engine;
- Python 3, `sha256sum`, `sort`, `cmp`, and GNU `timeout`;
- enough temporary capacity for three 384 MiB-bounded Kubo containers.

The script pulls the pinned Kubo image only if it is missing locally.

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
Kubo image: PASS (0.42.0, sha256:8907...)
Profiles: PASS (unixfs-v1-2025 applied and bootstrap empty on 3 repos)
Nodes: PASS (3 ready, zero host ports, internal Docker network)
Swarm: PASS (two explicit connections; no bootstrap/DHT fallback)
v1 online: PASS (..., 8 reachable blocks)
v1 origin-offline: PASS (2 replicas, complete graph and 4 file checksums each)
v2 online: PASS (..., 8 reachable blocks)
v1+v2 origin-offline: PASS (both replicas retain both immutable versions)
Lab: PASS
Cleanup: PASS (containers, internal network, and temporary repositories removed)
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
- 1,024 links per file node;
- HAMT fanout 256, block-based threshold estimation, 256 KiB threshold.

It deliberately does not pass `--raw-leaves=false`, `--cid-version=0`, a 256 KiB chunker, or other flags that would override the profile.

## Failure behavior

Any mismatch or failed operation exits non-zero. On failure, the script prints recent Kubo logs, then removes only resources labeled/named for its unique run.

Useful safe failure checks:

- change one fixture byte: checksum validation must fail before Docker nodes start;
- change an expected root CID in a temporary copy of `manifest.json`: import must fail before replication is accepted;
- interrupt the script: the EXIT trap removes containers, internal network, and temporary repositories.

After an interrupted run, confirm no resources remain:

```bash
docker ps -a --format '{{.Names}}' | grep '^meshkeep-lab-' || true
docker network ls --format '{{.Name}}' | grep '^meshkeep-lab-' || true
docker volume ls --format '{{.Name}}' | grep 'meshkeep-lab' || true
```

No output is expected.

## Evidence and limitations

`results/immutable-cid-lab.json` records the last committed successful run without peer IDs, container IPs, temporary paths, or host-identifying data.

This is one-host container isolation, not separate operators or machines. CID transfer uses explicit libp2p connections, not IPNS. The next lab must introduce disposable IPNS signing, signed v1→v2 resolution, secure key transfer to a second publisher environment, stale/invalid record failures, and only then claim the hard MVP.
