# Four-host Kubo manual execution kit

This directory is an **unexecuted, bounded operator kit**, not an all-host runner and not hard-MVP evidence. It prepares local validation checks for four independent Linux/amd64 Docker environments. The helpers issue no direct remote orchestration or file-transfer commands and no explicit Docker, Kubo, repository, or firewall mutation commands; optional evidence output only creates one local no-clobber result. Local Kubo query commands can use established swarm/runtime state and may affect Kubo or operating-system caches. `evidence-template.json` deliberately remains `result: "not-run"`.

The four roles are `publisher-a`, `publisher-b`, `replica1`, and `replica2`. Every command below is run manually by the operator responsible for that environment. A real run remains externally blocked until four hosts/VMs, their operators, network policy, clocks, and a publishing-key handoff are available.

## Security and platform assumptions

- Docker access is root-equivalent. Use dedicated disposable hosts/VMs and repositories containing only test content and keys.
- Docker Engine and client must be at least 28.0.0. The localhost gateway publication relies on Docker's corrected localhost-port behavior; older engines fail preflight.
- The kit is Linux/amd64 and IPv4/TCP-only. It assumes a nonzero numeric container UID, numeric GID, static mutually routable direct swarm endpoints, and explicit operator control of firewall policy. NAT translation is outside this contract: each role's host bind and announced endpoint must be the same literal IPv4 address and TCP port 4001.
- Both helpers reject `DOCKER_API_VERSION`, remote/TCP/SSH Docker endpoints, and a socket path that is itself a symlink. They accept only a normalized absolute `unix://` endpoint whose final path is a Unix socket. This constrains the client connection but does not prove that the daemon or its storage has an independent physical failure domain.
- Examples use only RFC 5737 documentation addresses: `192.0.2.10`, `192.0.2.11`, `192.0.2.12`, and `192.0.2.13`. Replace them locally. Never commit actual addresses, peer IDs, paths, user/group IDs, host identifiers, or environment IDs.
- All four repositories must contain the same operator-provisioned private-network `swarm.key`. It must be a regular, non-symlink mode-0600 file owned by the requested UID. The helpers inspect only metadata and never open, read, hash, print, generate, or transport it.
- Kubo API remains container-loopback only and is never published. Replica gateway listens in-container on all interfaces solely so Docker can publish it as host `127.0.0.1:8080`; publishers do not publish a gateway.
- Gateway traffic is plain local HTTP with no TLS. Do not publish port 8080 beyond loopback or place the API behind any browser/untrusted content boundary.
- The operator, not this kit, owns routing, firewall, no-NAT, cloud, and physical failure-domain attestations. A refusal/timeout after a positive swarm control is bounded transport evidence, not proof that a firewall is correct.

The kit does not invoke remote shells or file-copy tools, explicitly dial peers, or issue lifecycle/configuration/publication commands. Its local Kubo queries may still communicate through already-established runtime state and may affect caches. It does not select or inspect the external publishing-key channel.

## Files and local-only inputs

- `manifest.json`: strict, non-secret kit contract referencing `../manifest.json` and `../ipns-manifest.json` by exact relative path and SHA-256 for immutable fixture/IPNS truth.
- `preflight.sh`: bounded local environment/repository/image metadata check. Success stdout is one sanitized JSON object.
- `verify-role.sh`: bounded phase-aware local query verifier. It may create one sanitized local no-clobber evidence object; Kubo queries can use established runtime state and affect caches.
- `evidence-template.json`: unexecuted aggregate template only.
- `codemap.md`: implementation boundaries and data flow.

Each operator creates locally:

1. an opaque ID `env-` followed by 32 lowercase hexadecimal characters;
2. one shared opaque run ID `run-` followed by 32 lowercase hexadecimal characters;
3. an initialized mode-0700 Kubo repository at an absolute non-symlink path, owned by the exact container UID and GID;
4. the separately provisioned mode-0600 `swarm.key`;
5. a mode-0600 peer sheet, never committed or moved by the kit.

The local peer sheet has exactly this shape after placeholders are replaced:

```json
{
  "format": "meshkeep-four-host-peer-sheet-v1",
  "peers": [
    {"role":"publisher-a","peer_id":"<PUBLISHER_A_PEER_ID>","dial_addr":"/ip4/192.0.2.10/tcp/4001/p2p/<PUBLISHER_A_PEER_ID>"},
    {"role":"publisher-b","peer_id":"<PUBLISHER_B_PEER_ID>","dial_addr":"/ip4/192.0.2.11/tcp/4001/p2p/<PUBLISHER_B_PEER_ID>"},
    {"role":"replica1","peer_id":"<REPLICA1_PEER_ID>","dial_addr":"/ip4/192.0.2.12/tcp/4001/p2p/<REPLICA1_PEER_ID>"},
    {"role":"replica2","peer_id":"<REPLICA2_PEER_ID>","dial_addr":"/ip4/192.0.2.13/tcp/4001/p2p/<REPLICA2_PEER_ID>"}
  ]
}
```

Set mode 0600 without displaying it:

```bash
chmod 0600 "$PEER_SHEET"
```

## Read-only preflight

Run locally before any configuration/start command. `--swarm-bind` and `--announce` must be the same operator-validated, directly dialable literal IPv4 TCP port 4001 endpoint; translated NAT endpoints fail closed.

```bash
./examples/lab/four-host/preflight.sh \
  --role "$ROLE" \
  --container "$CONTAINER" \
  --repo "$REPO" \
  --swarm-bind "192.0.2.10:4001" \
  --announce "192.0.2.10:4001" \
  --uid "$KUBO_UID" \
  --gid "$KUBO_GID" \
  --environment-id "$ENVIRONMENT_ID" \
  --network-attested
```

The preflight does not pull the image or execute it. It requires the exact local digest/platform and treats the committed digest-to-Kubo-0.42.0 mapping in the hash-pinned immutable manifest as the version authority. It checks repository version 18, exact repository UID/GID/mode, and exact `swarm.key` UID/GID/mode without opening the key. Docker client and daemon must both report a stable version at or above 28.0.0 on Linux/amd64 through the accepted local Unix endpoint. Exit 0 emits one JSON line; assertion/environment failure is 1; usage/input failure is 2. Diagnostics never include supplied path, address, UID/GID, endpoint, or key metadata values.

By supplying `--network-attested`, the operator—not the helper—attests that all advertised swarm endpoints are direct and non-NAT; Docker uses ordinary bridge port-publication/NAT behavior only; daemon-wide direct routing is disabled; no `nat-unprotected` gateway mode, routed gateway mode, or trusted host interface exposes container ports; and applicable host, upstream, cloud, and perimeter firewall policy has been checked. The helper proves only the argument/manifest equality and local observations described above.

## Operator repository configuration

The following fenced commands are **manual operator mutations**, not actions performed by either helper. Start from an already initialized disposable repository with the committed `unixfs-v1-2025` profile and the common pnet key. Set local variables without logging their values:

```bash
IMAGE='ipfs/kubo@sha256:8907cb0cc1ad5798f6bb1bb1341a800990c268e021cedfa317e8aa1a33864214'
ANNOUNCE_IP='192.0.2.10'

repo_ipfs() {
  docker run --rm --pull=never --network none \
    --user "$KUBO_UID:$KUBO_GID" \
    --env IPFS_PATH=/data/ipfs \
    --volume "$REPO:/data/ipfs:rw" \
    --entrypoint ipfs "$IMAGE" "$@"
}

repo_ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
if [[ "$ROLE" == replica1 || "$ROLE" == replica2 ]]; then
  repo_ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080
else
  repo_ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080
fi
repo_ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001"]'
repo_ipfs config --json Addresses.Announce "[\"/ip4/$ANNOUNCE_IP/tcp/4001\"]"
repo_ipfs config --json Bootstrap '[]'
repo_ipfs config Routing.Type dhtserver
repo_ipfs config --json Routing.DelegatedRouters '[]'
repo_ipfs config --json Provide.Enabled false
repo_ipfs config --json AutoConf.Enabled false
repo_ipfs config --json AutoTLS.Enabled false
repo_ipfs config --json DNS.Resolvers '{}'
repo_ipfs config --json Ipns.DelegatedPublishers '[]'
repo_ipfs config --json Ipns.UsePubsub false
repo_ipfs config --json Discovery.MDNS.Enabled false
repo_ipfs config --json Swarm.DisableNatPortMap true
repo_ipfs config --json Swarm.EnableHolePunching false
repo_ipfs config --json Swarm.RelayClient.Enabled false
repo_ipfs config --json Swarm.RelayService.Enabled false
repo_ipfs config --json Swarm.Transports.Network.QUIC false
repo_ipfs config --json Swarm.Transports.Network.WebTransport false
repo_ipfs config --json Swarm.Transports.Network.Websocket false
repo_ipfs config --json Swarm.Transports.Network.WebRTCDirect false
repo_ipfs config --json Swarm.Transports.Network.TCP true
repo_ipfs config --json HTTPRetrieval.Enabled false
repo_ipfs config --json Gateway.NoFetch true
repo_ipfs config --json Gateway.NoDNSLink true
repo_ipfs config --json Gateway.ExposeRoutingAPI false
repo_ipfs config --json Swarm.DisableBandwidthMetrics true
repo_ipfs config Plugins.Plugins.telemetry.Config.Mode off
```

Only individual keys are queried later; `verify-role.sh` never captures full Kubo config.

## Operator Docker start commands

These are manual starts. `--pull=never` makes a missing image fail rather than fetch. Select the role's host bind address locally.

Publisher:

```bash
docker run --detach --pull=never --network bridge --restart no \
  --name "$CONTAINER" \
  --user "$KUBO_UID:$KUBO_GID" \
  --env IPFS_PATH=/data/ipfs \
  --env LIBP2P_FORCE_PNET=1 \
  --publish "192.0.2.10:4001:4001/tcp" \
  --volume "$REPO:/data/ipfs:rw" \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 384m --cpus 0.50 --pids-limit 256 --stop-timeout 10 \
  --entrypoint ipfs "$IMAGE" daemon
```

Replica (the API is intentionally absent from `--publish`):

```bash
docker run --detach --pull=never --network bridge --restart no \
  --name "$CONTAINER" \
  --user "$KUBO_UID:$KUBO_GID" \
  --env IPFS_PATH=/data/ipfs \
  --env LIBP2P_FORCE_PNET=1 \
  --publish "192.0.2.12:4001:4001/tcp" \
  --publish 127.0.0.1:8080:8080/tcp \
  --volume "$REPO:/data/ipfs:rw" \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 384m --cpus 0.50 --pids-limit 256 --stop-timeout 10 \
  --entrypoint ipfs "$IMAGE" daemon
```

Repeat with the role's RFC-5737 placeholder replacement. Do not use a wildcard host bind for 8080 and never publish 5001. The verifier reads `Config.Env` from the same bounded pinned-image inspection, rejects duplicate image/container keys, overlays exactly the two displayed environment assignments, and rejects any extra or conflicting container environment entry.

## Explicit full mesh: all 12 directed dials

Collect peer IDs locally into each mode-0600 peer sheet without printing them. Run every directed command on the named source host; success in one direction does not replace the reverse dial.

```bash
dial_peer() {
  local dial_status
  if timeout -k 5 40 docker exec "$1" ipfs swarm connect "$2" >/dev/null 2>&1; then
    return 0
  else
    dial_status=$?
    printf 'ERROR: directed swarm dial failed\n' >&2
    return "$dial_status"
  fi
}

# publisher-a source
dial_peer "$PUBLISHER_A_CONTAINER" "/ip4/192.0.2.11/tcp/4001/p2p/$PUBLISHER_B_PEER_ID"
dial_peer "$PUBLISHER_A_CONTAINER" "/ip4/192.0.2.12/tcp/4001/p2p/$REPLICA1_PEER_ID"
dial_peer "$PUBLISHER_A_CONTAINER" "/ip4/192.0.2.13/tcp/4001/p2p/$REPLICA2_PEER_ID"
# publisher-b source
dial_peer "$PUBLISHER_B_CONTAINER" "/ip4/192.0.2.10/tcp/4001/p2p/$PUBLISHER_A_PEER_ID"
dial_peer "$PUBLISHER_B_CONTAINER" "/ip4/192.0.2.12/tcp/4001/p2p/$REPLICA1_PEER_ID"
dial_peer "$PUBLISHER_B_CONTAINER" "/ip4/192.0.2.13/tcp/4001/p2p/$REPLICA2_PEER_ID"
# replica1 source
dial_peer "$REPLICA1_CONTAINER" "/ip4/192.0.2.10/tcp/4001/p2p/$PUBLISHER_A_PEER_ID"
dial_peer "$REPLICA1_CONTAINER" "/ip4/192.0.2.11/tcp/4001/p2p/$PUBLISHER_B_PEER_ID"
dial_peer "$REPLICA1_CONTAINER" "/ip4/192.0.2.13/tcp/4001/p2p/$REPLICA2_PEER_ID"
# replica2 source
dial_peer "$REPLICA2_CONTAINER" "/ip4/192.0.2.10/tcp/4001/p2p/$PUBLISHER_A_PEER_ID"
dial_peer "$REPLICA2_CONTAINER" "/ip4/192.0.2.11/tcp/4001/p2p/$PUBLISHER_B_PEER_ID"
dial_peer "$REPLICA2_CONTAINER" "/ip4/192.0.2.12/tcp/4001/p2p/$REPLICA1_PEER_ID"
```

The wrapper suppresses identity-bearing command output, preserves the exact `timeout`/Docker status, and emits only a generic failure diagnostic. Record only per-direction success booleans and aggregate counts in evidence.

Run `verify-role.sh --phase initial` on all four environments after all 12 dials. It requires each local observed peer-ID set to be exactly the other three IDs.

## Phased lifecycle

Use the existing signed-IPNS guide for exact native Kubo sequence, lifetime, TTL, inspect, recursive-pin, and negative-record semantics. The four-host sequence adds operator/environment boundaries:

1. **Initial:** preflight all four; configure/start manually; complete all 12 dials; verify every role at `initial`.
2. **v1:** publisher A imports/pins the committed v1 fixture, publishes sequence 0, and records the public IPNS name. Both replicas resolve/inspect, recursively pin, and verify v1.
3. **A offline:** the A operator stops A. Every operator records A-offline attestation independently. Run `publisher-a-offline-v1` with `--ipns-name` and `--publisher-a-offline-attested`; replica verification checks v1 pin/graph/files and host-loopback `/ipfs` plus `/ipns` content.
4. **Publishing-key handoff:** both publisher containers are stopped. A exports the disposable named key to owner-only local storage. The A operator sends it directly to the B operator using an operator-selected authenticated end-to-end encrypted external channel. This kit does not choose, invoke, observe, identify, or verify that channel. B imports while stopped and proves public-name continuity. Only after B confirms both import and public-name continuity may A remove its original named key and both operators remove every cleartext export, receive, staging, and channel-download artifact under their control. Ordinary artifact deletion is not secure erasure: filesystem journals, snapshots, backups, flash translation layers, and channel retention may preserve copies. The helpers cannot verify deletion, erasure, or remote-channel retention. Never include publishing-key or swarm-key content, hash, path, or metadata values in evidence.
5. **v2:** B starts, observes v1, imports/pins committed v2, and publishes sequence 1 under the same name. Replicas resolve/inspect, recursively pin v2, and retain v1. Run `publisher-b-active-v2` with the A-offline attestation.
6. **Both publishers offline:** the B operator stops B and all operators record B-offline attestation. Run `publishers-offline-v2` with both offline flags. Each replica checks both recursive pins, exact eight-block reachable counts, all eight fixture hashes, current sequence-1 IPNS, eight `/ipfs` gateway files, and four current `/ipns` files.
7. **Cleanup:** operators manually stop/remove their own disposable container/repository according to local policy. Only afterward run `verify-role.sh --phase cleanup`; it performs absence verification and never removes anything. Cleanup phase accepts neither IPNS name nor offline-attestation flags.

General verification form:

```bash
./examples/lab/four-host/verify-role.sh \
  --role "$ROLE" \
  --phase "$PHASE" \
  --container "$CONTAINER" \
  --manifest "$(cd examples/lab/four-host && pwd -P)/manifest.json" \
  --expected-peers "$PEER_SHEET" \
  --environment-id "$ENVIRONMENT_ID" \
  --run-id "$RUN_ID" \
  --ipns-name "$PUBLIC_IPNS_NAME" \
  --publisher-a-offline-attested \
  --publisher-b-offline-attested \
  --evidence-dir "$LOCAL_OWNER_ONLY_EVIDENCE_DIR"
```

Omit phase-inapplicable options exactly as described above. `--evidence-dir` is optional, is forbidden for `cleanup`, and must name an existing absolute non-symlink mode-0700 directory owned by the invoking user and unrelated to the manifest, referenced manifests, peer sheet, or repository. The verifier chooses the fixed filename `meshkeep-$RUN_ID-$ROLE-$PHASE.json`; callers cannot supply a destination filename. It fails rather than replacing an existing path, publishes a mode-0600 same-directory temporary file with a no-clobber hard link, fsyncs the file and directory, and emits the same sanitized bytes on stdout. It never writes an aggregate result.

## Cross-host transport probes

The local verifier cannot create cross-host evidence. From each source environment, probe each remote role's literal address manually. First require a positive TCP 4001 control; only then classify 5001 and 8080 as connection-refused or bounded timeout. A no-route, DNS, command, Docker, or host failure invalidates the pair.

```bash
python3 - "192.0.2.11" <<'PY'
import errno,socket,sys
address=sys.argv[1]
def connect(port,expect_open):
    sock=socket.socket(); sock.settimeout(10)
    try:
        result=sock.connect_ex((address,port))
    finally:
        sock.close()
    if expect_open and result!=0:
        raise SystemExit("positive swarm control failed")
    if not expect_open and result not in {errno.ECONNREFUSED,errno.ETIMEDOUT}:
        raise SystemExit("negative probe was no-route or unclassified infrastructure failure")
connect(4001,True)
connect(5001,False)
connect(8080,False)
PY
```

Repeat for all directed host pairs and retain only sanitized booleans/counts. These checks show bounded transport behavior after a positive control; they do not prove firewall correctness, TLS, or resistance to another route/interface.

## Manual evidence assembly and blockers

Each operator reviews the single-role JSON locally. Operators may manually exchange only sanitized role evidence through a channel they choose. There is intentionally no transfer, collection, or aggregation helper. Copy `evidence-template.json` to owner-only external working storage and fill it manually only after reconciling:

- four distinct opaque environment IDs and one run ID;
- all preflights and phase-local role evidence;
- all 12 directed dials and cross-host positive/negative probes;
- independent A/B offline attestations and external key-handoff completion;
- replica graph, IPNS, gateway, RPC, and cleanup observations;
- timestamps, clock assumptions, and hashes of the three non-secret committed manifests.

Do not commit the assembled result unless project governance explicitly requests it and its privacy review passes. Until a real run exists, the blockers are four genuinely independent environments/operators, mutually routable controlled direct TCP endpoints, operator firewall/no-NAT attestations, safe external key handoff and cleartext-artifact handling, and manual evidence reconciliation. Every hard-MVP and v0.0 checkbox remains unchanged.
