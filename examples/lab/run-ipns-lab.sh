#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT_FILE="$SCRIPT_DIR/run-ipns-lab.sh"
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
FIXTURES_DIR="$REPO_ROOT/examples/lab-fixtures"
BASE_MANIFEST="$SCRIPT_DIR/manifest.json"
IPNS_MANIFEST="$SCRIPT_DIR/ipns-manifest.json"
WRITE_RESULTS_INPUT=""

usage() { printf 'Usage: %s [--write-results PATH]\n' "$0"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-results)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      WRITE_RESULTS_INPUT=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }
for command in cmp diff docker grep mktemp python3 sha256sum sort stat timeout tr wc; do require_command "$command"; done
[[ -f "$SCRIPT_FILE" && -f "$BASE_MANIFEST" && -f "$IPNS_MANIFEST" ]] || fail "lab input missing"

mapfile -t META < <(python3 - "$BASE_MANIFEST" "$IPNS_MANIFEST" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as h: base = json.load(h)
with open(sys.argv[2], encoding="utf-8") as h: ipns = json.load(h)
required_import = {
    "CidVersion": 1, "HashFunction": "sha2-256", "UnixFSChunker": "size-1048576",
    "UnixFSDAGLayout": "balanced", "UnixFSDirectoryMaxLinks": 0,
    "UnixFSFileMaxLinks": 1024, "UnixFSHAMTDirectoryMaxFanout": 256,
    "UnixFSHAMTDirectorySizeEstimation": "block",
    "UnixFSHAMTDirectorySizeThreshold": "256KiB", "UnixFSRawLeaves": True,
}
if base.get("format") != "meshkeep-immutable-cid-lab-v2": raise SystemExit("unsupported base manifest")
if ipns.get("format") != "meshkeep-ipns-key-transfer-lab-v1": raise SystemExit("unsupported IPNS manifest")
if ipns.get("immutable_manifest") != "manifest.json": raise SystemExit("invalid immutable manifest reference")
kubo, profile, fixtures = base["kubo"], base["profile"], base["fixtures"]
m = re.fullmatch(r"[^@\s]+@(sha256:[0-9a-f]{64})", kubo.get("image", ""))
if not m or m.group(1) != kubo.get("index_digest"): raise SystemExit("invalid pinned image")
if (kubo.get("version"), kubo.get("repo_version"), kubo.get("requested_platform")) != ("0.42.0", 18, "linux/amd64"): raise SystemExit("unsupported Kubo baseline")
if profile.get("name") != "unixfs-v1-2025" or profile.get("import") != required_import: raise SystemExit("invalid ten-field import profile")
for version in ("v1", "v2"):
    if not re.fullmatch(r"b[a-z2-7]{20,}", fixtures[version]["root_cid"]): raise SystemExit("invalid expected CID")
settings = ipns.get("ipns", {}); network = ipns.get("network", {}); expected = ipns.get("expectations", {})
if settings != {"key_name":"meshkeep-publisher","key_type":"ed25519","lifetime":"10m","ttl":"1s","eol_bracket_tolerance_seconds":2,"v1_sequence":0,"v2_sequence":1}: raise SystemExit("unsupported IPNS settings")
if expected != {"reachable_blocks_per_version":8,"replicas":2,"publishers":2}: raise SystemExit("unsupported expectations")
if not isinstance(network.get("dht_record_count"), int) or not 1 <= network["dht_record_count"] <= 4: raise SystemExit("invalid DHT record count")
if not re.fullmatch(r"[1-9][0-9]*s", network.get("dht_timeout", "")): raise SystemExit("invalid DHT timeout")
if not isinstance(network.get("resolve_attempts"), int) or not 1 <= network["resolve_attempts"] <= 20: raise SystemExit("invalid resolve attempts")
if not isinstance(network.get("resolve_retry_delay_seconds"), int) or not 1 <= network["resolve_retry_delay_seconds"] <= 10: raise SystemExit("invalid retry delay")
for value in (kubo["version"], str(kubo["repo_version"]), kubo["image"], kubo["index_digest"], kubo["requested_platform"], profile["name"], fixtures["v1"]["root_cid"], fixtures["v2"]["root_cid"], settings["key_name"], settings["key_type"], settings["lifetime"], settings["ttl"], str(settings["v1_sequence"]), str(settings["v2_sequence"]), str(settings["eol_bracket_tolerance_seconds"]), str(network["dht_record_count"]), network["dht_timeout"], str(network["resolve_attempts"]), str(network["resolve_retry_delay_seconds"]), json.dumps(required_import, sort_keys=True, separators=(",",":"))): print(value)
PY
)
[[ ${#META[@]} -eq 20 ]] || fail "manifest metadata validation failed"
KUBO_VERSION=${META[0]}; KUBO_REPO_VERSION=${META[1]}; IMAGE=${META[2]}; EXPECTED_INDEX_DIGEST=${META[3]}
REQUESTED_PLATFORM=${META[4]}; PROFILE=${META[5]}; EXPECTED_V1=${META[6]}; EXPECTED_V2=${META[7]}
KEY_NAME=${META[8]}; KEY_TYPE=${META[9]}; IPNS_LIFETIME=${META[10]}; IPNS_TTL=${META[11]}
V1_SEQUENCE=${META[12]}; V2_SEQUENCE=${META[13]}; EOL_BRACKET_TOLERANCE=${META[14]}
DHT_RECORD_COUNT=${META[15]}; DHT_TIMEOUT=${META[16]}; RESOLVE_ATTEMPTS=${META[17]}
RESOLVE_RETRY_DELAY=${META[18]}; EXPECTED_IMPORT_JSON=${META[19]}
read -r SCRIPT_SHA256 _ < <(sha256sum "$SCRIPT_FILE")
read -r BASE_MANIFEST_SHA256 _ < <(sha256sum "$BASE_MANIFEST")
read -r IPNS_MANIFEST_SHA256 _ < <(sha256sum "$IPNS_MANIFEST")

DOCKER_META_RAW=$(docker version --format '{{println .Client.Version}}{{println .Client.APIVersion}}{{println .Client.Os}}{{println .Client.Arch}}{{println .Server.Version}}{{println .Server.APIVersion}}{{println .Server.Os}}{{.Server.Arch}}') || fail "Docker version query failed"
mapfile -t DOCKER_META <<< "$DOCKER_META_RAW"
[[ ${#DOCKER_META[@]} -eq 8 ]] || fail "Docker version provenance collection failed"
DOCKER_STORAGE_DRIVER=$(docker info --format '{{.Driver}}') || fail "Docker storage-driver query failed"
[[ -n "$DOCKER_STORAGE_DRIVER" ]] || fail "Docker storage-driver observation is empty"

PULL_PLATFORM_ARGS=(); RUN_PLATFORM_ARGS=(); INSPECT_PLATFORM_ARGS=()
LC_ALL=C docker pull --help | grep -q -- '--platform' && PULL_PLATFORM_ARGS=(--platform "$REQUESTED_PLATFORM")
LC_ALL=C docker run --help | grep -q -- '--platform' && RUN_PLATFORM_ARGS=(--platform "$REQUESTED_PLATFORM")
LC_ALL=C docker image inspect --help | grep -q -- '--platform' && INSPECT_PLATFORM_ARGS=(--platform "$REQUESTED_PLATFORM")

TMP_ROOT=$(mktemp -d /tmp/meshkeep-ipns-lab.XXXXXX)
RUN_ID=$(basename "$TMP_ROOT" | tr -cd 'A-Za-z0-9')
[[ -n "$RUN_ID" ]] || fail "empty run identifier"
RECORDS_DIR="$TMP_ROOT/raw-records"
DIAGNOSTICS_DIR="$TMP_ROOT/diagnostics"
mkdir -m 700 "$RECORDS_DIR" "$DIAGNOSTICS_DIR"
NETWORK="meshkeep-ipns-lab-$RUN_ID"
declare -A NODE=(
  [publisher-a]="meshkeep-ipns-publisher-a-$RUN_ID"
  [publisher-b]="meshkeep-ipns-publisher-b-$RUN_ID"
  [replica1]="meshkeep-ipns-replica1-$RUN_ID"
  [replica2]="meshkeep-ipns-replica2-$RUN_ID"
)
ROLES=(publisher-a publisher-b replica1 replica2)
declare -A CONTAINER_ID=() REPO_VERSION=() PEER=()
NETWORK_ID=""; CLEANUP_VERIFIED=false; DOCKER_QUERY_FAILED=false; TRANSFER_CLEANED=false
MUTATED_INSPECT_INVALID=false; MUTATED_NAME_PUT_REJECTED=false; ROUTING_POSTCONDITION_VALID=false
STALE_V1_VALID_UNEXPIRED=false; STALE_REPLAY_REJECTED=false; STALE_POSTCONDITION_VALID=false
MALFORMED_INSPECT_REJECTED=false; MALFORMED_PUT_REJECTED=false
ABSENT_TARGET_RESOLVED=false; ABSENT_TARGET_PIN_FAILED=false; ABSENT_TARGET_PIN_ABSENT=false

safe_remove_tmp_root() {
  [[ -n "${TMP_ROOT:-}" && "$TMP_ROOT" == /tmp/meshkeep-ipns-lab.* ]] || return 1
  rm -rf -- "$TMP_ROOT"
}
capture_docker_query() {
  local variable_name=$1; shift; local query_output
  if ! query_output=$(docker "$@"); then DOCKER_QUERY_FAILED=true; return 1; fi
  printf -v "$variable_name" '%s' "$query_output"
}
output_has_line() { local line; while IFS= read -r line; do [[ "$line" == "$2" ]] && return 0; done <<< "$1"; return 1; }
output_has_name() { local id name; while IFS=$'\t' read -r id name; do [[ -n "$id" && "$name" == "$2" ]] && return 0; done <<< "$1"; return 1; }
collect_id_for_name() { local id name; while IFS=$'\t' read -r id name; do if [[ -n "$id" && "$name" == "$2" ]]; then printf -v "$3" '%s' "$id"; return 0; fi; done <<< "$1"; return 1; }

fallback_cleanup() {
  local status=$? cleanup_failed=0 role id resource named_id
  local ids="" names="" labels="" net_ids="" net_names="" net_labels=""
  local -A containers=() networks=()
  trap - EXIT INT TERM HUP
  [[ "$CLEANUP_VERIFIED" == true ]] && exit "$status"
  (( status == 0 )) && status=1
  set +e
  [[ "$DOCKER_QUERY_FAILED" == true ]] && cleanup_failed=1
  capture_docker_query ids ps -aq --no-trunc || cleanup_failed=1
  capture_docker_query names ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' || cleanup_failed=1
  capture_docker_query labels ps -aq --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1
  for role in "${ROLES[@]}"; do
    id=${CONTAINER_ID[$role]:-}; [[ -n "$id" ]] && containers[$id]=true
    named_id=""; collect_id_for_name "$names" "${NODE[$role]}" named_id && containers[$named_id]=true
  done
  while IFS= read -r resource; do [[ -n "$resource" ]] && containers[$resource]=true; done <<< "$labels"
  for resource in "${!containers[@]}"; do docker logs --tail 80 "$resource" >&2 2>/dev/null || true; docker rm -fv "$resource" >/dev/null 2>&1 || cleanup_failed=1; done
  capture_docker_query net_ids network ls -q --no-trunc || cleanup_failed=1
  capture_docker_query net_names network ls --no-trunc --format '{{.ID}}\t{{.Name}}' || cleanup_failed=1
  capture_docker_query net_labels network ls -q --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1
  [[ -n "$NETWORK_ID" ]] && networks[$NETWORK_ID]=true
  named_id=""; collect_id_for_name "$net_names" "$NETWORK" named_id && networks[$named_id]=true
  while IFS= read -r resource; do [[ -n "$resource" ]] && networks[$resource]=true; done <<< "$net_labels"
  for resource in "${!networks[@]}"; do docker network rm "$resource" >/dev/null 2>&1 || cleanup_failed=1; done
  safe_remove_tmp_root || cleanup_failed=1
  ids=""; names=""; labels=""; net_ids=""; net_names=""; net_labels=""
  capture_docker_query ids ps -aq --no-trunc || cleanup_failed=1
  capture_docker_query names ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' || cleanup_failed=1
  capture_docker_query labels ps -aq --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1
  capture_docker_query net_ids network ls -q --no-trunc || cleanup_failed=1
  capture_docker_query net_names network ls --no-trunc --format '{{.ID}}\t{{.Name}}' || cleanup_failed=1
  capture_docker_query net_labels network ls -q --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1
  for role in "${ROLES[@]}"; do id=${CONTAINER_ID[$role]:-}; [[ -n "$id" ]] && output_has_line "$ids" "$id" && cleanup_failed=1; output_has_name "$names" "${NODE[$role]}" && cleanup_failed=1; done
  [[ -n "$labels" || -n "$net_labels" ]] && cleanup_failed=1
  [[ -n "$NETWORK_ID" ]] && output_has_line "$net_ids" "$NETWORK_ID" && cleanup_failed=1
  output_has_name "$net_names" "$NETWORK" && cleanup_failed=1
  [[ ! -e "$TMP_ROOT" && ! -L "$TMP_ROOT" ]] || cleanup_failed=1
  (( cleanup_failed != 0 )) && printf 'Cleanup fallback: INCOMPLETE for run %s\n' "$RUN_ID" >&2
  exit "$status"
}
trap fallback_cleanup EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

verify_successful_cleanup() {
  local role id ids="" names="" labels="" net_ids="" net_names="" net_labels=""
  for role in "${ROLES[@]}"; do id=${CONTAINER_ID[$role]:-}; [[ -n "$id" ]] || fail "missing $role container ID"; docker rm -fv "$id" >/dev/null || fail "failed to remove $role"; done
  [[ -n "$NETWORK_ID" ]] || fail "missing network ID"
  docker network rm "$NETWORK_ID" >/dev/null || fail "failed to remove network"
  safe_remove_tmp_root || fail "failed to remove temporary root"
  if [[ ${MESHKEEP_IPNS_LAB_INJECT_CLEANUP_QUERY_FAILURE:-0} == 1 ]]; then DOCKER_QUERY_FAILED=true; fail "injected post-removal Docker query failure"; fi
  capture_docker_query ids ps -aq --no-trunc || fail "container query failed after cleanup"
  capture_docker_query names ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' || fail "container-name query failed after cleanup"
  capture_docker_query labels ps -aq --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || fail "container-label query failed after cleanup"
  capture_docker_query net_ids network ls -q --no-trunc || fail "network query failed after cleanup"
  capture_docker_query net_names network ls --no-trunc --format '{{.ID}}\t{{.Name}}' || fail "network-name query failed after cleanup"
  capture_docker_query net_labels network ls -q --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || fail "network-label query failed after cleanup"
  for role in "${ROLES[@]}"; do id=${CONTAINER_ID[$role]}; output_has_line "$ids" "$id" && fail "$role ID remains"; output_has_name "$names" "${NODE[$role]}" && fail "$role name remains"; done
  [[ -z "$labels" && -z "$net_labels" ]] || fail "run-labeled resources remain"
  output_has_line "$net_ids" "$NETWORK_ID" && fail "network ID remains"
  output_has_name "$net_names" "$NETWORK" && fail "network name remains"
  [[ ! -e "$TMP_ROOT" && ! -L "$TMP_ROOT" ]] || fail "temporary root remains"
  CLEANUP_VERIFIED=true
  printf 'Cleanup: PASS (4 container IDs, network ID, labels, names, and owner-only temporary artifacts absent)\n'
}

FIXTURE_RECORDS="$TMP_ROOT/fixtures.tsv"
python3 - "$BASE_MANIFEST" > "$FIXTURE_RECORDS" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as h: data=json.load(h)
count=0
for version in ("v1","v2"):
  for path, digest in sorted(data["fixtures"][version]["files"].items()):
    if path.startswith("/") or ".." in path.split("/") or not re.fullmatch(r"[0-9a-f]{64}", digest): raise SystemExit("unsafe fixture record")
    print(version,path,digest,sep="\t"); count += 1
if count != 8: raise SystemExit("expected eight fixture files")
PY
verified_files=0
while IFS=$'\t' read -r version relative_path expected_hash; do
  fixture="$FIXTURES_DIR/$version/$relative_path"; [[ -f "$fixture" && ! -L "$fixture" ]] || fail "unsafe fixture"
  read -r actual_hash _ < <(sha256sum "$fixture"); [[ "$actual_hash" == "$expected_hash" ]] || fail "fixture checksum mismatch"
  ((verified_files += 1))
done < "$FIXTURE_RECORDS"
[[ $verified_files -eq 8 ]] || fail "fixture count mismatch"
printf 'Fixtures: PASS (8 files; immutable manifest reused)\n'

if ! docker image inspect "${INSPECT_PLATFORM_ARGS[@]}" "$IMAGE" >/dev/null 2>&1; then docker pull "${PULL_PLATFORM_ARGS[@]}" "$IMAGE" >/dev/null; fi
IMAGE_INSPECT="$TMP_ROOT/image.json"
docker image inspect "${INSPECT_PLATFORM_ARGS[@]}" "$IMAGE" > "$IMAGE_INSPECT" || fail "image inspect failed"
mapfile -t IMAGE_META < <(python3 - "$IMAGE_INSPECT" "$EXPECTED_INDEX_DIGEST" <<'PY'
import json,re,sys
with open(sys.argv[1],encoding="utf-8") as h: records=json.load(h)
if not isinstance(records,list) or len(records)!=1: raise SystemExit("unexpected image inspect")
r=records[0]; digests=r.get("RepoDigests")
if not isinstance(digests,list) or sys.argv[2] not in [x.rsplit("@",1)[-1] for x in digests if isinstance(x,str) and "@" in x]: raise SystemExit("pinned RepoDigest absent")
for key in ("Os","Architecture","Id"):
  value=r.get(key);
  if not isinstance(value,str) or not value: raise SystemExit("image observation absent")
print(r["Os"]); print(r["Architecture"]); print(r["Id"]); print("present" if isinstance(r.get("Descriptor"),dict) else "unavailable")
PY
)
[[ ${#IMAGE_META[@]} -eq 4 ]] || fail "image metadata validation failed"
ACTUAL_IMAGE_OS=${IMAGE_META[0]}; ACTUAL_IMAGE_ARCH=${IMAGE_META[1]}; ENGINE_IMAGE_ID=${IMAGE_META[2]}; DESCRIPTOR_STATUS=${IMAGE_META[3]}
[[ "$ACTUAL_IMAGE_OS/$ACTUAL_IMAGE_ARCH" == "$REQUESTED_PLATFORM" ]] || fail "image platform mismatch"
ACTUAL_KUBO_VERSION=$(docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" --entrypoint ipfs "$IMAGE" version --number)
[[ "$ACTUAL_KUBO_VERSION" == "$KUBO_VERSION" ]] || fail "Kubo version mismatch"
printf 'Kubo image: PASS (0.42.0, repo 18, linux/amd64, pinned index)\n'

repo_ipfs() {
  local repo=$1; shift
  docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" --user 1000:1000 --entrypoint ipfs --env IPFS_PATH=/data/ipfs --volume "$repo:/data/ipfs" "$IMAGE" "$@"
}
read_repo_version() { python3 - "$1" "$KUBO_REPO_VERSION" <<'PY'
import os,re,stat,sys
fd=os.open(sys.argv[1],os.O_RDONLY|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0))
try: meta=os.fstat(fd); raw=os.read(fd,33)
finally: os.close(fd)
if not stat.S_ISREG(meta.st_mode) or meta.st_size>32 or not re.fullmatch(rb"[0-9]+\n?",raw): raise SystemExit("invalid repo version file")
value=int(raw); expected=int(sys.argv[2])
if value!=expected: raise SystemExit("repository version mismatch")
print(value)
PY
}

EXPECTED_IMPORT="$TMP_ROOT/expected-import.json"; printf '%s\n' "$EXPECTED_IMPORT_JSON" > "$EXPECTED_IMPORT"
for role in "${ROLES[@]}"; do
  repo="$TMP_ROOT/$role-repo"; mkdir -p "$repo"
  docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" --env IPFS_PROFILE=test --volume "$repo:/data/ipfs" "$IMAGE" version >/dev/null
  REPO_VERSION[$role]=$(read_repo_version "$repo/version")
  repo_ipfs "$repo" config profile apply "$PROFILE" >/dev/null
  repo_ipfs "$repo" config Addresses.API /ip4/127.0.0.1/tcp/5001 >/dev/null
  repo_ipfs "$repo" config Addresses.Gateway /ip4/127.0.0.1/tcp/8080 >/dev/null
  repo_ipfs "$repo" config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001"]' >/dev/null
  repo_ipfs "$repo" bootstrap rm --all >/dev/null
  repo_ipfs "$repo" config Routing.Type dhtserver >/dev/null
  repo_ipfs "$repo" config --json Routing.DelegatedRouters '[]' >/dev/null
  repo_ipfs "$repo" config --json Provide.Enabled false >/dev/null
  repo_ipfs "$repo" config --json AutoConf.Enabled false >/dev/null
  repo_ipfs "$repo" config --json AutoTLS.Enabled false >/dev/null
  repo_ipfs "$repo" config --json DNS.Resolvers '{}' >/dev/null
  repo_ipfs "$repo" config --json Ipns.DelegatedPublishers '[]' >/dev/null
  repo_ipfs "$repo" config --json Ipns.UsePubsub false >/dev/null
  repo_ipfs "$repo" config --json Discovery.MDNS.Enabled false >/dev/null
  repo_ipfs "$repo" config --json Swarm.DisableNatPortMap true >/dev/null
  repo_ipfs "$repo" config --json Swarm.EnableHolePunching false >/dev/null
  repo_ipfs "$repo" config --json Swarm.RelayClient.Enabled false >/dev/null
  repo_ipfs "$repo" config --json Swarm.RelayService.Enabled false >/dev/null
  repo_ipfs "$repo" config --json HTTPRetrieval.Enabled false >/dev/null
  repo_ipfs "$repo" config --json Gateway.NoFetch true >/dev/null
  repo_ipfs "$repo" config --json Gateway.NoDNSLink true >/dev/null
  repo_ipfs "$repo" config --json Gateway.ExposeRoutingAPI false >/dev/null
  repo_ipfs "$repo" config --json Swarm.DisableBandwidthMetrics true >/dev/null
  repo_ipfs "$repo" config Plugins.Plugins.telemetry.Config.Mode off >/dev/null
  repo_ipfs "$repo" config Import --json > "$TMP_ROOT/$role-import.json"
  python3 - "$EXPECTED_IMPORT" "$TMP_ROOT/$role-import.json" <<'PY'
import json,sys
with open(sys.argv[1]) as h: expected=json.load(h)
with open(sys.argv[2]) as h: actual=json.load(h)
if len(expected)!=10 or any(actual.get(k)!=v for k,v in expected.items()): raise SystemExit("import profile mismatch")
PY
  PEER[$role]=$(repo_ipfs "$repo" id -f='<id>')
  [[ -n "${PEER[$role]}" ]] || fail "empty node identity"
done
[[ "${PEER[publisher-a]}" != "${PEER[publisher-b]}" ]] || fail "publisher node identities unexpectedly equal"

for role in "${ROLES[@]}"; do
  peers_json=$(python3 - "$role" "${PEER[publisher-a]}" "${PEER[publisher-b]}" "${PEER[replica1]}" "${PEER[replica2]}" <<'PY'
import json,sys
role=sys.argv[1]; names=("publisher-a","publisher-b","replica1","replica2"); ids=sys.argv[2:]
print(json.dumps([{"ID":peer,"Addrs":[f"/dns4/{name}/tcp/4001"]} for name,peer in zip(names,ids) if name!=role],separators=(",",":")))
PY
)
  repo_ipfs "$TMP_ROOT/$role-repo" config --json Peering.Peers "$peers_json" >/dev/null
  repo_ipfs "$TMP_ROOT/$role-repo" config show > "$TMP_ROOT/$role-config.json"
  python3 - "$TMP_ROOT/$role-config.json" <<'PY'
import json,sys
with open(sys.argv[1]) as h: c=json.load(h)
checks=[
 ("Routing.Type",c["Routing"].get("Type"),"dhtserver"),("Routing.DelegatedRouters",c["Routing"].get("DelegatedRouters"),[]),("Provide.Enabled",c["Provide"].get("Enabled"),False),
 ("AutoConf.Enabled",c["AutoConf"].get("Enabled"),False),("AutoTLS.Enabled",c["AutoTLS"].get("Enabled"),False),("DNS.Resolvers",c["DNS"].get("Resolvers"),{}),
 ("Ipns.DelegatedPublishers",c["Ipns"].get("DelegatedPublishers"),[]),("Ipns.UsePubsub",c["Ipns"].get("UsePubsub"),False),("Discovery.MDNS.Enabled",c["Discovery"]["MDNS"].get("Enabled"),False),
 ("Swarm.DisableNatPortMap",c["Swarm"].get("DisableNatPortMap"),True),("Swarm.EnableHolePunching",c["Swarm"].get("EnableHolePunching"),False),
 ("Swarm.RelayClient.Enabled",c["Swarm"]["RelayClient"].get("Enabled"),False),("Swarm.RelayService.Enabled",c["Swarm"]["RelayService"].get("Enabled"),False),
 ("HTTPRetrieval.Enabled",c["HTTPRetrieval"].get("Enabled"),False),("Gateway.NoFetch",c["Gateway"].get("NoFetch"),True),("Gateway.NoDNSLink",c["Gateway"].get("NoDNSLink"),True),
 ("Gateway.ExposeRoutingAPI",c["Gateway"].get("ExposeRoutingAPI"),False),("Swarm.DisableBandwidthMetrics",c["Swarm"].get("DisableBandwidthMetrics"),True),
 ("Plugins.telemetry.Mode",c["Plugins"]["Plugins"]["telemetry"]["Config"].get("Mode"),"off"),
]
for item in checks:
 if len(item)==2:
  actual,expected=item; label="isolation setting"
 else:
  label,actual,expected=item
 if actual!=expected: raise SystemExit(f"isolation config mismatch: {label}: {actual!r} != {expected!r}")
if c.get("Bootstrap") not in (None,[]): raise SystemExit("isolation config mismatch: Bootstrap is not empty")
if len(c["Peering"].get("Peers",[]))!=3: raise SystemExit("peering is not full mesh")
PY
done
printf 'Repositories: PASS (4 repos, ten-field profile, private-DHT/isolation policy)\n'

NETWORK_ID=$(docker network create --internal --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" "$NETWORK")
[[ -n "$NETWORK_ID" ]] || fail "network creation returned no ID"
for role in "${ROLES[@]}"; do
  CONTAINER_ID[$role]=$(docker run "${RUN_PLATFORM_ARGS[@]}" --detach --name "${NODE[$role]}" --network "$NETWORK_ID" --network-alias "$role" --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" --user 1000:1000 --entrypoint ipfs --env IPFS_PATH=/data/ipfs --env IPFS_TELEMETRY=off --volume "$TMP_ROOT/$role-repo:/data/ipfs" --volume "$FIXTURES_DIR:/fixtures:ro" --volume "$RECORDS_DIR:/lab-records:ro" --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m --cap-drop ALL --security-opt no-new-privileges:true --memory 384m --cpus 0.50 --pids-limit 256 --stop-timeout 10 "$IMAGE" daemon)
  [[ -n "${CONTAINER_ID[$role]}" ]] || fail "missing $role container ID"
done

if [[ ${MESHKEEP_IPNS_LAB_HELPER_HOLD_SECONDS:-0} =~ ^[1-9][0-9]*$ ]]; then
  docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" --entrypoint sleep "$IMAGE" "$MESHKEEP_IPNS_LAB_HELPER_HOLD_SECONDS"
fi
wait_node() { local i; for i in {1..60}; do if timeout 10 docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null | grep -qx true && timeout 10 docker exec "$1" ipfs id >/dev/null 2>&1; then return; fi; sleep 1; done; docker logs --tail 80 "$1" >&2 2>/dev/null || true; fail "$1 not ready"; }
for role in "${ROLES[@]}"; do
  wait_node "${CONTAINER_ID[$role]}"
  set +e
  HOST_PORT_OUTPUT=$(timeout -k 5 15 docker port "${CONTAINER_ID[$role]}" 2> "$DIAGNOSTICS_DIR/$role-docker-port.err")
  HOST_PORT_STATUS=$?
  set -e
  [[ $HOST_PORT_STATUS -eq 0 ]] || fail "$role host-port query failed"
  [[ -z "$HOST_PORT_OUTPUT" ]] || fail "$role publishes host ports"
done

role_is_expected() { local candidate=$1; shift; local expected; for expected in "$@"; do [[ "$candidate" == "$expected" ]] && return 0; done; return 1; }
connect_expected_mesh() {
  local -a expected_roles=("$@") expected_peer_ids=()
  local -A seen=()
  local role source target state state_status connect_status peer_status attempts peers_file
  local connections_complete=false
  [[ ${#expected_roles[@]} -ge 2 ]] || fail "expected mesh requires at least two roles"
  for role in "${expected_roles[@]}"; do
    [[ -v NODE[$role] && -z "${seen[$role]:-}" ]] || fail "invalid or duplicate expected mesh role"
    seen[$role]=true
  done
  for role in "${ROLES[@]}"; do
    set +e
    state=$(timeout -k 5 15 docker inspect --format '{{.State.Running}}' "${CONTAINER_ID[$role]}" 2> "$DIAGNOSTICS_DIR/mesh-$role-inspect.err")
    state_status=$?
    set -e
    [[ $state_status -eq 0 ]] || fail "$role state query failed during mesh assertion"
    if role_is_expected "$role" "${expected_roles[@]}"; then
      [[ "$state" == true ]] || fail "$role is not running for expected mesh"
    else
      [[ "$state" == false ]] || fail "$role unexpectedly active outside expected mesh"
    fi
  done
  for attempts in {1..8}; do
    connections_complete=true
    for source in "${expected_roles[@]}"; do
      for target in "${expected_roles[@]}"; do
        [[ "$source" == "$target" ]] && continue
        set +e
        timeout -k 5 20 docker exec "${CONTAINER_ID[$source]}" ipfs swarm connect "/dns4/$target/tcp/4001/p2p/${PEER[$target]}" > "$DIAGNOSTICS_DIR/mesh-connect-$source-$target.out" 2> "$DIAGNOSTICS_DIR/mesh-connect-$source-$target.err"
        connect_status=$?
        set -e
        [[ $connect_status -ne 124 && $connect_status -lt 125 ]] || fail "$source to $target mesh connection invocation failed"
        [[ $connect_status -eq 0 ]] || connections_complete=false
      done
    done
    [[ "$connections_complete" == true ]] && break
    sleep 1
  done
  [[ "$connections_complete" == true ]] || fail "expected active-role mesh did not converge"
  sleep 1
  for source in "${expected_roles[@]}"; do
    expected_peer_ids=()
    for target in "${expected_roles[@]}"; do
      [[ "$source" == "$target" ]] && continue
      expected_peer_ids+=("${PEER[$target]}")
    done
    peers_file="$DIAGNOSTICS_DIR/mesh-$source-peers.out"
    set +e
    timeout -k 5 15 docker exec "${CONTAINER_ID[$source]}" ipfs swarm peers > "$peers_file" 2> "$DIAGNOSTICS_DIR/mesh-$source-peers.err"
    peer_status=$?
    set -e
    [[ $peer_status -eq 0 ]] || fail "$source swarm-peer query failed during mesh assertion"
    python3 - "$peers_file" "${expected_peer_ids[@]}" <<'PY'
import sys
path, *expected = sys.argv[1:]
if not expected or len(expected) != len(set(expected)):
    raise SystemExit("expected active target peer IDs are empty or non-unique")
lines = open(path, encoding="utf-8").read().splitlines()
observed = []
for line in lines:
    parts = line.split("/")
    if not line or line.strip() != line or len(parts) < 3 or parts[0] != "" or parts[-2] != "p2p" or not parts[-1]:
        raise SystemExit("swarm-peer output contains an unparseable peer multiaddress")
    observed.append(parts[-1])
if len(observed) != len(set(observed)):
    raise SystemExit("swarm-peer output contains duplicate peer IDs")
if set(observed) != set(expected):
    raise SystemExit("swarm-peer output does not exactly match the expected active target peer IDs")
PY
  done
}
connect_expected_mesh publisher-a publisher-b replica1 replica2

for role in "${ROLES[@]}"; do
  DHT_SAMPLE_FILE="$TMP_ROOT/$role-closest-peers.txt"
  set +e
  timeout -k 5 25 docker exec "${CONTAINER_ID[$role]}" ipfs dht query "${PEER[$role]}" > "$DHT_SAMPLE_FILE" 2> "$DIAGNOSTICS_DIR/$role-dht-query.err"
  DHT_SAMPLE_STATUS=$?
  set -e
  [[ $DHT_SAMPLE_STATUS -eq 0 ]] || fail "$role private DHT closest-peer query failed"
  python3 - "$DHT_SAMPLE_FILE" "${PEER[publisher-a]}" "${PEER[publisher-b]}" "${PEER[replica1]}" "${PEER[replica2]}" <<'PY'
import sys
lines=open(sys.argv[1],encoding="utf-8").read().splitlines()
allowed=set(sys.argv[2:])
if not 1 <= len(lines) <= len(allowed): raise SystemExit("closest-peer sample count outside lab bound")
if any(not line or line not in allowed for line in lines): raise SystemExit("closest-peer sample contains an empty or non-lab identity")
PY
done
printf 'Network: PASS (4-node explicit mesh; bounded closest-peer samples; Docker-internal/config isolation)\n'

import_root() { local output; output=$(timeout 90 docker exec "$1" ipfs add --quieter --recursive --pin=false "/fixtures/$2") || fail "import failed"; mapfile -t lines <<< "$output"; [[ ${#lines[@]} -gt 0 ]] || fail "empty import"; printf '%s\n' "${lines[-1]}"; }
collect_refs() { { printf '%s\n' "$2"; timeout 60 docker exec "$1" ipfs refs --recursive --unique "/ipfs/$2"; } | LC_ALL=C sort -u > "$3"; }
verify_files() { local record_version path digest line actual; while IFS=$'\t' read -r record_version path digest; do [[ "$record_version" == "$2" ]] || continue; line=$(timeout 30 docker exec "$1" ipfs cat "/ipfs/$3/$path" | sha256sum) || fail "file read failed"; read -r actual _ <<< "$line"; [[ "$actual" == "$digest" ]] || fail "content hash mismatch"; done < "$FIXTURE_RECORDS"; }
verify_recursive_pin() { local pinned refs="$TMP_ROOT/$4.refs"; pinned=$(timeout 30 docker exec "$1" ipfs pin ls --type=recursive --quiet "$2") || fail "$4 recursive pin absent"; [[ "$pinned" == "$2" ]] || fail "$4 pin mismatch"; timeout 60 docker exec "$1" ipfs pin verify >/dev/null || fail "$4 pin verification failed"; collect_refs "$1" "$2" "$refs"; cmp -s "$3" "$refs" || { diff -u "$3" "$refs" >&2 || true; fail "$4 graph mismatch"; }; }
replicate_to_replicas() { local role; for role in replica1 replica2; do timeout 90 docker exec "${CONTAINER_ID[$role]}" ipfs pin add --recursive "$2" >/dev/null || fail "$role pin failed"; verify_recursive_pin "${CONTAINER_ID[$role]}" "$2" "$3" "$role-$1"; verify_files "${CONTAINER_ID[$role]}" "$1" "$2"; done; }
resolve_expected() { local role=$1 name=$2 expected=$3 attempt value=""; for ((attempt=1; attempt<=RESOLVE_ATTEMPTS; attempt++)); do set +e; value=$(timeout 30 docker exec "${CONTAINER_ID[$role]}" ipfs name resolve --nocache --dht-record-count "$DHT_RECORD_COUNT" --dht-timeout "$DHT_TIMEOUT" "$name" 2>/dev/null); status=$?; set -e; [[ $status -eq 0 && "$value" == "/ipfs/$expected" ]] && { printf '%s\n' "$value"; return; }; sleep "$RESOLVE_RETRY_DELAY"; done; fail "$role did not resolve expected IPNS value"; }
capture_record() { timeout 30 docker exec "$1" ipfs name get "$2" > "$3" || fail "IPNS record capture failed"; [[ -s "$3" ]] || fail "captured IPNS record is empty"; }
inspect_record() {
  local container=$1 name=$2 record=$3 output=$4 expected_cid=$5 expected_sequence=$6 publication_start=$7 publication_end=$8 require_unexpired=${9:-false}
  local status
  set +e
  timeout -k 5 30 docker exec -i "$container" ipfs name inspect --enc=json --dump=false --verify "$name" < "$record" > "$output" 2> "$output.err"
  status=$?
  set -e
  [[ $status -eq 0 ]] || fail "IPNS inspect/verify invocation did not complete successfully"
  [[ ! -s "$output.err" ]] || fail "successful IPNS inspect emitted diagnostics"
  python3 - "$output" "$name" "$expected_cid" "$expected_sequence" "$publication_start" "$publication_end" "$require_unexpired" "$EOL_BRACKET_TOLERANCE" <<'PY'
import datetime,json,sys
path,name,cid,sequence,start_raw,end_raw,require_unexpired,tolerance_raw=sys.argv[1:]
with open(path,encoding="utf-8") as h: d=json.load(h)
if not isinstance(d,dict) or not isinstance(d.get("Entry"),dict) or not isinstance(d.get("Validation"),dict): raise SystemExit("unexpected Kubo 0.42 inspect structure")
entry=d["Entry"]; validation=d["Validation"]
expected_entry={"Value":"/ipfs/"+cid,"ValidityType":0,"Sequence":int(sequence),"TTL":1_000_000_000}
for key,value in expected_entry.items():
 if entry.get(key)!=value: raise SystemExit(f"unexpected Kubo 0.42 Entry.{key}")
if not isinstance(entry.get("Validity"),str): raise SystemExit("Kubo 0.42 Entry.Validity is absent")
if validation.get("Valid") is not True or validation.get("Name")!=name or validation.get("Reason")!="": raise SystemExit("Kubo 0.42 signature/name verification failed")
if d.get("SignatureType")!="V1+V2" or d.get("HexDump")!="" or not isinstance(d.get("PbSize"),int) or not 0<d["PbSize"]<=10_240: raise SystemExit("unexpected Kubo 0.42 inspect metadata")
def parse(value):
 parsed=datetime.datetime.fromisoformat(value.replace("Z","+00:00"))
 if parsed.tzinfo is None: raise SystemExit("timestamp lacks timezone")
 return parsed.astimezone(datetime.timezone.utc)
start=parse(start_raw); end=parse(end_raw); eol=parse(entry["Validity"])
if end<start: raise SystemExit("publication timestamp order invalid")
# The manifest's two seconds cover host/container timestamp sampling and scheduler delay around the bounded publish call.
tolerance=datetime.timedelta(seconds=int(tolerance_raw)); lifetime=datetime.timedelta(minutes=10)
if not start+lifetime-tolerance <= eol <= end+lifetime+tolerance: raise SystemExit("EOL is not bracketed by the ten-minute publication interval")
if require_unexpired=="true" and eol<=datetime.datetime.now(datetime.timezone.utc): raise SystemExit("captured record is expired")
if require_unexpired not in ("true","false"): raise SystemExit("invalid unexpired assertion flag")
PY
}

validate_name_put_diagnostic() {
  python3 - "$1" "$2" "$3" <<'PY'
import re,sys
stdout_path,stderr_path,kind=sys.argv[1:]
stdout=open(stdout_path,"rb").read(); stderr=open(stderr_path,"rb").read()
if stdout: raise SystemExit("rejected name put unexpectedly wrote stdout")
if len(stderr)>512: raise SystemExit("name put diagnostic exceeds bounded size")
try: text=stderr.decode("utf-8")
except UnicodeDecodeError: raise SystemExit("name put diagnostic is not UTF-8")
expected={
 "invalid-signature":r"Error: record validation failed: signature verification failed\n?",
 "stale-sequence":r"Error: existing IPNS record has sequence 1 >= new record sequence 0, use 'ipfs name put --force' to skip this check\n?",
 "malformed":r"Error: invalid IPNS record: record is malformed\nproto: cannot parse invalid wire-format data\n?",
}
if kind not in expected or re.fullmatch(expected[kind],text) is None: raise SystemExit(f"unexpected Kubo 0.42 {kind} diagnostic")
PY
}
run_name_put_rejection() {
  local label=$1 name=$2 container_record=$3 diagnostic_kind=$4 status
  set +e
  timeout -k 5 30 docker exec "${CONTAINER_ID[replica1]}" ipfs name put --allow-offline "$name" "$container_record" > "$DIAGNOSTICS_DIR/$label.out" 2> "$DIAGNOSTICS_DIR/$label.err"
  status=$?
  set -e
  [[ $status -eq 1 ]] || fail "$label did not complete with Kubo's semantic rejection status"
  validate_name_put_diagnostic "$DIAGNOSTICS_DIR/$label.out" "$DIAGNOSTICS_DIR/$label.err" "$diagnostic_kind" || fail "$label did not emit the expected bounded Kubo 0.42 diagnostic"
}

IPNS_NAME=$(timeout 30 docker exec "${CONTAINER_ID[publisher-a]}" ipfs key gen --type="$KEY_TYPE" "$KEY_NAME")
[[ "$IPNS_NAME" =~ ^k[0-9a-z]+$ ]] || fail "unexpected public IPNS name"
V1=$(import_root "${CONTAINER_ID[publisher-a]}" v1); [[ "$V1" == "$EXPECTED_V1" ]] || fail "v1 CID mismatch"
timeout 90 docker exec "${CONTAINER_ID[publisher-a]}" ipfs pin add --recursive "$V1" >/dev/null
V1_REFS="$TMP_ROOT/v1.refs"; collect_refs "${CONTAINER_ID[publisher-a]}" "$V1" "$V1_REFS"; V1_BLOCKS=$(wc -l < "$V1_REFS" | tr -d ' '); [[ "$V1_BLOCKS" == 8 ]] || fail "v1 block count mismatch"
V1_PUBLICATION_STARTED=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')
PUBLISHED_NAME=$(timeout 90 docker exec "${CONTAINER_ID[publisher-a]}" ipfs name publish --key="$KEY_NAME" --lifetime="$IPNS_LIFETIME" --ttl="$IPNS_TTL" --sequence="$V1_SEQUENCE" --quieter "/ipfs/$V1")
V1_PUBLICATION_ENDED=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')
[[ "$PUBLISHED_NAME" == "$IPNS_NAME" ]] || fail "published IPNS name mismatch"
for role in replica1 replica2; do resolve_expected "$role" "$IPNS_NAME" "$V1" >/dev/null; capture_record "${CONTAINER_ID[$role]}" "$IPNS_NAME" "$RECORDS_DIR/$role-v1.record"; inspect_record "${CONTAINER_ID[$role]}" "$IPNS_NAME" "$RECORDS_DIR/$role-v1.record" "$TMP_ROOT/$role-v1.inspect.json" "$V1" "$V1_SEQUENCE" "$V1_PUBLICATION_STARTED" "$V1_PUBLICATION_ENDED" false; done
replicate_to_replicas v1 "$V1" "$V1_REFS"
timeout 30 docker stop --time 10 "${CONTAINER_ID[publisher-a]}" >/dev/null
for role in replica1 replica2; do verify_recursive_pin "${CONTAINER_ID[$role]}" "$V1" "$V1_REFS" "$role-v1-a-offline"; verify_files "${CONTAINER_ID[$role]}" v1 "$V1"; done
printf 'IPNS v1: PASS (sequence 0, signatures/EOL/TTL, 8 blocks, A offline, 2 replicas)\n'

timeout 30 docker stop --time 10 "${CONTAINER_ID[publisher-b]}" >/dev/null
TRANSFER_DIR="$TMP_ROOT/key-transfer"; mkdir -m 700 "$TRANSFER_DIR"; TRANSFER_FILE="$TRANSFER_DIR/disposable.key"
docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" --user 1000:1000 --entrypoint ipfs --env IPFS_PATH=/data/ipfs --volume "$TMP_ROOT/publisher-a-repo:/data/ipfs" --volume "$TRANSFER_DIR:/transfer" --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m --cap-drop ALL --security-opt no-new-privileges:true "$IMAGE" key export --format=libp2p-protobuf-cleartext --output=/transfer/disposable.key "$KEY_NAME" >/dev/null
[[ -f "$TRANSFER_FILE" && ! -L "$TRANSFER_FILE" ]] || fail "key export did not create a regular file"; chmod 600 "$TRANSFER_FILE"; [[ $(stat -c '%a' "$TRANSFER_DIR") == 700 && $(stat -c '%a' "$TRANSFER_FILE") == 600 ]] || fail "key transfer permissions incorrect"
IMPORTED_NAME=$(docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none --label com.meshkeep.lab=ipns --label "com.meshkeep.run=$RUN_ID" --user 1000:1000 --entrypoint ipfs --env IPFS_PATH=/data/ipfs --volume "$TMP_ROOT/publisher-b-repo:/data/ipfs" --volume "$TRANSFER_DIR:/transfer:ro" --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m --cap-drop ALL --security-opt no-new-privileges:true "$IMAGE" key import --format=libp2p-protobuf-cleartext "$KEY_NAME" /transfer/disposable.key)
[[ "$IMPORTED_NAME" == "$IPNS_NAME" ]] || fail "imported key name changed"
repo_ipfs "$TMP_ROOT/publisher-a-repo" key rm "$KEY_NAME" >/dev/null
set +e
A_KEY_LIST=$(repo_ipfs "$TMP_ROOT/publisher-a-repo" key list 2> "$DIAGNOSTICS_DIR/publisher-a-key-list.err")
A_KEY_LIST_STATUS=$?
set -e
[[ $A_KEY_LIST_STATUS -eq 0 ]] || fail "publisher A key-list query failed"
output_has_line "$A_KEY_LIST" "$KEY_NAME" && fail "original named key remains on publisher A"
rm -f -- "$TRANSFER_FILE"; rmdir -- "$TRANSFER_DIR"; [[ ! -e "$TRANSFER_FILE" && ! -e "$TRANSFER_DIR" ]] || fail "transfer artifact cleanup failed"; TRANSFER_CLEANED=true
printf 'Key transfer: PASS (same public name, distinct node identity, A key query complete, owner-only cleartext artifact deleted)\n'

timeout 30 docker start "${CONTAINER_ID[publisher-b]}" >/dev/null; wait_node "${CONTAINER_ID[publisher-b]}"; connect_expected_mesh publisher-b replica1 replica2
resolve_expected publisher-b "$IPNS_NAME" "$V1" >/dev/null
capture_record "${CONTAINER_ID[publisher-b]}" "$IPNS_NAME" "$RECORDS_DIR/publisher-b-v1.record"
inspect_record "${CONTAINER_ID[publisher-b]}" "$IPNS_NAME" "$RECORDS_DIR/publisher-b-v1.record" "$TMP_ROOT/publisher-b-v1.inspect.json" "$V1" "$V1_SEQUENCE" "$V1_PUBLICATION_STARTED" "$V1_PUBLICATION_ENDED" false
V2=$(import_root "${CONTAINER_ID[publisher-b]}" v2); [[ "$V2" == "$EXPECTED_V2" ]] || fail "v2 CID mismatch"
timeout 90 docker exec "${CONTAINER_ID[publisher-b]}" ipfs pin add --recursive "$V2" >/dev/null
V2_REFS="$TMP_ROOT/v2.refs"; collect_refs "${CONTAINER_ID[publisher-b]}" "$V2" "$V2_REFS"; V2_BLOCKS=$(wc -l < "$V2_REFS" | tr -d ' '); [[ "$V2_BLOCKS" == 8 ]] || fail "v2 block count mismatch"
V2_PUBLICATION_STARTED=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')
PUBLISHED_NAME_V2=$(timeout 90 docker exec "${CONTAINER_ID[publisher-b]}" ipfs name publish --key="$KEY_NAME" --lifetime="$IPNS_LIFETIME" --ttl="$IPNS_TTL" --sequence="$V2_SEQUENCE" --quieter "/ipfs/$V2")
V2_PUBLICATION_ENDED=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')
[[ "$PUBLISHED_NAME_V2" == "$IPNS_NAME" ]] || fail "v2 public name changed"
sleep 2
for role in replica1 replica2; do resolve_expected "$role" "$IPNS_NAME" "$V2" >/dev/null; capture_record "${CONTAINER_ID[$role]}" "$IPNS_NAME" "$RECORDS_DIR/$role-v2.record"; inspect_record "${CONTAINER_ID[$role]}" "$IPNS_NAME" "$RECORDS_DIR/$role-v2.record" "$TMP_ROOT/$role-v2.inspect.json" "$V2" "$V2_SEQUENCE" "$V2_PUBLICATION_STARTED" "$V2_PUBLICATION_ENDED" false; done
replicate_to_replicas v2 "$V2" "$V2_REFS"
printf 'IPNS v2: PASS (same name, sequence 1, signatures valid, 8 blocks, v1 retained)\n'

# Mutate only protobuf field 8 (SignatureV2), preserving the record's protobuf structure.
python3 - "$RECORDS_DIR/replica1-v2.record" "$RECORDS_DIR/mutated.record" <<'PY'
import sys
raw=bytearray(open(sys.argv[1],"rb").read()); i=0; changed=False
def varint(buf,pos):
  value=0; shift=0
  while True:
    if pos>=len(buf) or shift>63: raise SystemExit("malformed source protobuf")
    b=buf[pos]; pos+=1; value|=(b&127)<<shift
    if not b&128: return value,pos
    shift+=7
while i<len(raw):
  key,i2=varint(raw,i); field=key>>3; wire=key&7; i=i2
  if wire==0: _,i=varint(raw,i)
  elif wire==1: i+=8
  elif wire==2:
    length,start=varint(raw,i); end=start+length
    if end>len(raw): raise SystemExit("malformed source protobuf")
    if field==8 and length:
      raw[start]^=1; changed=True; break
    i=end
  elif wire==5: i+=4
  else: raise SystemExit("unsupported protobuf wire type")
if not changed: raise SystemExit("SignatureV2 field not found")
open(sys.argv[2],"wb").write(raw)
PY
set +e
timeout -k 5 30 docker exec -i "${CONTAINER_ID[replica1]}" ipfs name inspect --enc=json --dump=false --verify "$IPNS_NAME" < "$RECORDS_DIR/mutated.record" > "$TMP_ROOT/mutated.inspect.json" 2> "$DIAGNOSTICS_DIR/mutated-inspect.err"
MUTATED_INSPECT_STATUS=$?
set -e
[[ $MUTATED_INSPECT_STATUS -eq 0 ]] || fail "mutated SignatureV2 inspect did not complete successfully"
[[ ! -s "$DIAGNOSTICS_DIR/mutated-inspect.err" ]] || fail "completed mutated SignatureV2 inspect emitted diagnostics"
python3 - "$TMP_ROOT/mutated.inspect.json" "$IPNS_NAME" "$V2" "$V2_SEQUENCE" "$V2_PUBLICATION_STARTED" "$V2_PUBLICATION_ENDED" "$EOL_BRACKET_TOLERANCE" <<'PY'
import datetime,json,sys
path,name,cid,sequence,start_raw,end_raw,tolerance_raw=sys.argv[1:]
with open(path,encoding="utf-8") as h: d=json.load(h)
if not isinstance(d,dict) or not isinstance(d.get("Entry"),dict) or not isinstance(d.get("Validation"),dict): raise SystemExit("unexpected Kubo 0.42 invalid-inspect structure")
entry=d["Entry"]; validation=d["Validation"]
expected={"Value":"/ipfs/"+cid,"ValidityType":0,"Sequence":int(sequence),"TTL":1_000_000_000}
if any(entry.get(k)!=v for k,v in expected.items()) or not isinstance(entry.get("Validity"),str): raise SystemExit("mutated inspect Entry fields changed")
if validation.get("Valid") is not False or validation.get("Name")!=name or validation.get("Reason")!="signature verification failed": raise SystemExit("mutated inspect did not report the expected invalid signature/name")
if d.get("SignatureType")!="V1+V2" or d.get("HexDump")!="" or not isinstance(d.get("PbSize"),int) or not 0<d["PbSize"]<=10_240: raise SystemExit("unexpected Kubo 0.42 invalid-inspect metadata")
def parse(value): return datetime.datetime.fromisoformat(value.replace("Z","+00:00")).astimezone(datetime.timezone.utc)
start=parse(start_raw); end=parse(end_raw); eol=parse(entry["Validity"]); tolerance=datetime.timedelta(seconds=int(tolerance_raw)); lifetime=datetime.timedelta(minutes=10)
if end<start or not start+lifetime-tolerance <= eol <= end+lifetime+tolerance: raise SystemExit("mutated inspect EOL does not match v2 publication")
PY
MUTATED_INSPECT_INVALID=true
run_name_put_rejection mutated-name-put "$IPNS_NAME" /lab-records/mutated.record invalid-signature
MUTATED_NAME_PUT_REJECTED=true
printf 'Negative invalid-signature inspect/name-put: PASS\n'
set +e
timeout -k 5 30 docker exec "${CONTAINER_ID[replica1]}" ipfs routing put "/ipns/$IPNS_NAME" /lab-records/mutated.record > "$DIAGNOSTICS_DIR/mutated-routing-put.out" 2> "$DIAGNOSTICS_DIR/mutated-routing-put.err"
MUTATED_ROUTING_STATUS=$?
set -e
[[ $MUTATED_ROUTING_STATUS -eq 0 ]] || fail "mutated-record routing put did not complete with pinned Kubo 0.42.0 status zero"
sleep 1
capture_record "${CONTAINER_ID[replica1]}" "$IPNS_NAME" "$RECORDS_DIR/post-mutated-routing.record"
inspect_record "${CONTAINER_ID[replica1]}" "$IPNS_NAME" "$RECORDS_DIR/post-mutated-routing.record" "$TMP_ROOT/post-mutated-routing.inspect.json" "$V2" "$V2_SEQUENCE" "$V2_PUBLICATION_STARTED" "$V2_PUBLICATION_ENDED" false
cmp -s "$RECORDS_DIR/replica1-v2.record" "$RECORDS_DIR/post-mutated-routing.record" || fail "routing put changed the selected valid v2 record"
ROUTING_POSTCONDITION_VALID=true
printf 'Post-routing-put selected-record observation: PASS (routing put status %s; selected record byte-identical valid v2)\n' "$MUTATED_ROUTING_STATUS"

inspect_record "${CONTAINER_ID[replica1]}" "$IPNS_NAME" "$RECORDS_DIR/replica1-v1.record" "$TMP_ROOT/pre-stale-v1.inspect.json" "$V1" "$V1_SEQUENCE" "$V1_PUBLICATION_STARTED" "$V1_PUBLICATION_ENDED" true
STALE_V1_VALID_UNEXPIRED=true
run_name_put_rejection stale-name-put "$IPNS_NAME" /lab-records/replica1-v1.record stale-sequence
STALE_REPLAY_REJECTED=true
capture_record "${CONTAINER_ID[replica1]}" "$IPNS_NAME" "$RECORDS_DIR/post-stale.record"
inspect_record "${CONTAINER_ID[replica1]}" "$IPNS_NAME" "$RECORDS_DIR/post-stale.record" "$TMP_ROOT/post-stale.inspect.json" "$V2" "$V2_SEQUENCE" "$V2_PUBLICATION_STARTED" "$V2_PUBLICATION_ENDED" false
cmp -s "$RECORDS_DIR/replica1-v2.record" "$RECORDS_DIR/post-stale.record" || fail "stale replay changed the selected valid v2 record"
STALE_POSTCONDITION_VALID=true
printf 'Negative stale-replay: PASS\n'

printf 'not-an-ipns-protobuf' > "$RECORDS_DIR/malformed.record"
set +e
timeout -k 5 30 docker exec -i "${CONTAINER_ID[replica1]}" ipfs name inspect --verify "$IPNS_NAME" < "$RECORDS_DIR/malformed.record" > "$DIAGNOSTICS_DIR/malformed-inspect.out" 2> "$DIAGNOSTICS_DIR/malformed-inspect.err"
MALFORMED_INSPECT_STATUS=$?
set -e
[[ $MALFORMED_INSPECT_STATUS -eq 1 ]] || fail "malformed inspect did not complete with Kubo's semantic rejection status"
python3 - "$DIAGNOSTICS_DIR/malformed-inspect.out" "$DIAGNOSTICS_DIR/malformed-inspect.err" <<'PY'
import re,sys
stdout=open(sys.argv[1],"rb").read(); stderr=open(sys.argv[2],"rb").read()
if stdout or len(stderr)>512: raise SystemExit("malformed inspect diagnostic is not bounded")
try: text=stderr.decode("utf-8")
except UnicodeDecodeError: raise SystemExit("malformed inspect diagnostic is not UTF-8")
if re.fullmatch(r"Error: record is malformed\nproto: cannot parse invalid wire-format data\n?",text) is None: raise SystemExit("unexpected Kubo 0.42 malformed-inspect diagnostic")
PY
MALFORMED_INSPECT_REJECTED=true
run_name_put_rejection malformed-name-put "$IPNS_NAME" /lab-records/malformed.record malformed
MALFORMED_PUT_REJECTED=true
printf 'Negative malformed-record: PASS\n'

ABSENT_KEY_NAME=meshkeep-absent-target
ABSENT_NAME=$(timeout 30 docker exec "${CONTAINER_ID[publisher-b]}" ipfs key gen --type=ed25519 "$ABSENT_KEY_NAME")
ABSENT_CID=$(printf 'meshkeep intentionally absent block v1\n' | timeout 30 docker exec -i "${CONTAINER_ID[publisher-b]}" ipfs add --only-hash --pin=false --quieter -)
[[ "$ABSENT_CID" =~ ^b[a-z2-7]+$ ]] || fail "absent target CID malformed"
timeout -k 5 90 docker exec "${CONTAINER_ID[publisher-b]}" ipfs name publish --resolve=false --key="$ABSENT_KEY_NAME" --lifetime="$IPNS_LIFETIME" --ttl="$IPNS_TTL" --sequence=0 --quieter "/ipfs/$ABSENT_CID" >/dev/null
ABSENT_TARGET_RESOLVE_COUNT=0
ABSENT_TARGET_PIN_FAILURE_COUNT=0
ABSENT_TARGET_PIN_ABSENCE_COUNT=0
for role in replica1 replica2; do
  resolve_expected "$role" "$ABSENT_NAME" "$ABSENT_CID" >/dev/null
  ((ABSENT_TARGET_RESOLVE_COUNT += 1))
  set +e
  timeout -k 5 15 docker exec "${CONTAINER_ID[$role]}" ipfs pin add --recursive "$ABSENT_CID" > "$DIAGNOSTICS_DIR/$role-absent-pin-add.out" 2> "$DIAGNOSTICS_DIR/$role-absent-pin-add.err"
  ABSENT_PIN_STATUS=$?
  set -e
  [[ $ABSENT_PIN_STATUS -eq 1 || $ABSENT_PIN_STATUS -eq 124 ]] || fail "$role absent-target pin did not end in the intended bounded availability failure"
  ((ABSENT_TARGET_PIN_FAILURE_COUNT += 1))
  set +e
  RECURSIVE_PIN_LIST=$(timeout -k 5 30 docker exec "${CONTAINER_ID[$role]}" ipfs pin ls --type=recursive --quiet 2> "$DIAGNOSTICS_DIR/$role-recursive-pin-list.err")
  RECURSIVE_PIN_LIST_STATUS=$?
  set -e
  [[ $RECURSIVE_PIN_LIST_STATUS -eq 0 ]] || fail "$role complete recursive-pin listing failed"
  output_has_line "$RECURSIVE_PIN_LIST" "$ABSENT_CID" && fail "$role complete recursive-pin listing contains absent target"
  ((ABSENT_TARGET_PIN_ABSENCE_COUNT += 1))
done
[[ $ABSENT_TARGET_RESOLVE_COUNT -eq 2 ]] && ABSENT_TARGET_RESOLVED=true
[[ $ABSENT_TARGET_PIN_FAILURE_COUNT -eq 2 ]] && ABSENT_TARGET_PIN_FAILED=true
[[ $ABSENT_TARGET_PIN_ABSENCE_COUNT -eq 2 ]] && ABSENT_TARGET_PIN_ABSENT=true
printf 'Negative observations: PASS (invalid signature, stale replay, malformed record, missing graph)\n'

timeout 30 docker stop --time 10 "${CONTAINER_ID[publisher-b]}" >/dev/null
for role in publisher-a publisher-b; do
  set +e
  PUBLISHER_RUNNING=$(timeout -k 5 15 docker inspect --format '{{.State.Running}}' "${CONTAINER_ID[$role]}" 2> "$DIAGNOSTICS_DIR/$role-final-state.err")
  PUBLISHER_STATE_STATUS=$?
  set -e
  [[ $PUBLISHER_STATE_STATUS -eq 0 && "$PUBLISHER_RUNNING" == false ]] || fail "$role is not verifiably offline"
done
for role in replica1 replica2; do verify_recursive_pin "${CONTAINER_ID[$role]}" "$V1" "$V1_REFS" "$role-final-v1"; verify_files "${CONTAINER_ID[$role]}" v1 "$V1"; verify_recursive_pin "${CONTAINER_ID[$role]}" "$V2" "$V2_REFS" "$role-final-v2"; verify_files "${CONTAINER_ID[$role]}" v2 "$V2"; done
printf 'Publishers offline: PASS (both replicas retain/read complete v1 and v2 graphs)\n'

for observation in "$MUTATED_INSPECT_INVALID" "$MUTATED_NAME_PUT_REJECTED" "$ROUTING_POSTCONDITION_VALID" "$STALE_V1_VALID_UNEXPIRED" "$STALE_REPLAY_REJECTED" "$STALE_POSTCONDITION_VALID" "$MALFORMED_INSPECT_REJECTED" "$MALFORMED_PUT_REJECTED" "$ABSENT_TARGET_RESOLVED" "$ABSENT_TARGET_PIN_FAILED" "$ABSENT_TARGET_PIN_ABSENT"; do
  [[ "$observation" == true ]] || fail "a required negative-path assertion is incomplete"
done
[[ "$TRANSFER_CLEANED" == true ]] || fail "key-transfer cleanup assertion is incomplete"
verify_successful_cleanup

if [[ -n "$WRITE_RESULTS_INPUT" ]]; then
  [[ "$WRITE_RESULTS_INPUT" == /* ]] && WRITE_RESULTS_TARGET=$WRITE_RESULTS_INPUT || WRITE_RESULTS_TARGET="$REPO_ROOT/$WRITE_RESULTS_INPUT"
  python3 - "$WRITE_RESULTS_TARGET" "$IPNS_NAME" "$V1" "$V2" "$V1_BLOCKS" "$V2_BLOCKS" "$IMAGE" "$EXPECTED_INDEX_DIGEST" "$REQUESTED_PLATFORM" "$ACTUAL_KUBO_VERSION" "$KUBO_REPO_VERSION" "$ENGINE_IMAGE_ID" "$DESCRIPTOR_STATUS" "$ACTUAL_IMAGE_OS" "$ACTUAL_IMAGE_ARCH" "$SCRIPT_SHA256" "$BASE_MANIFEST_SHA256" "$IPNS_MANIFEST_SHA256" "${DOCKER_META[@]}" "$DOCKER_STORAGE_DRIVER" "$BASH_VERSION" "$(python3 --version | tr -d '\n')" "$(sha256sum --version | python3 -c 'import sys; print(sys.stdin.readline().split()[-1])')" "$MUTATED_ROUTING_STATUS" "$EOL_BRACKET_TOLERANCE" "$MUTATED_INSPECT_INVALID" "$MUTATED_NAME_PUT_REJECTED" "$ROUTING_POSTCONDITION_VALID" "$STALE_V1_VALID_UNEXPIRED" "$STALE_REPLAY_REJECTED" "$STALE_POSTCONDITION_VALID" "$MALFORMED_INSPECT_REJECTED" "$MALFORMED_PUT_REJECTED" "$ABSENT_TARGET_RESOLVED" "$ABSENT_TARGET_PIN_FAILED" "$ABSENT_TARGET_PIN_ABSENT" <<'PY'
import datetime,errno,json,os,sys,tempfile
(path,name,v1,v2,v1blocks,v2blocks,image,digest,platform,kubo,repo_version,image_id,descriptor,image_os,image_arch,runner_hash,base_hash,ipns_hash,dcv,dca,dcos,dcarch,dsv,dsa,dsos,dsarch,storage,bash_version,python_version,coreutils,mutated_routing_status,eol_tolerance,mutated_inspect,mutated_name_put,routing_postcondition,stale_precondition,stale_rejected,stale_postcondition,malformed_inspect,malformed_put,absent_resolved,absent_pin_failed,absent_pin_absent)=sys.argv[1:]
def observed(value):
 if value!="true": raise SystemExit("result assertion was not completed")
 return True
data={
 "format":"meshkeep-ipns-key-transfer-lab-result-v1","result":"pass","verified_on":datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
 "public_ipns_name":name,
 "versions":{"v1":{"root_cid":v1,"sequence":0,"reachable_blocks":int(v1blocks)},"v2":{"root_cid":v2,"sequence":1,"reachable_blocks":int(v2blocks)}},
 "ipns":{"same_name_v1_v2":True,"replica_signature_validation":{"v1":True,"v2":True},"ttl":"1s","ttl_nanoseconds":1_000_000_000,"lifetime":"10m","publication_eol_bracket_tolerance_seconds":int(eol_tolerance),"cache_bypass":True,"raw_records_temporarily_persisted_owner_only":True,"raw_records_removed_before_result_finalization":True,"raw_records_excluded_from_result":True},
 "key_transfer":{"format":"libp2p-protobuf-cleartext","key_name_continuity":True,"publisher_node_identities_distinct":True,"original_key_removed_after_successful_key_listing":True,"transfer_file_cleaned":True,"cleartext_key_temporarily_persisted_owner_only":True,"cleartext_key_removed_before_result_finalization":True,"cleartext_key_excluded_from_result":True,"ordinary_deletion_is_secure_erasure":False,"disposable_key":True},
 "replicas":{"count":2,"v1_complete_graph_and_content":True,"v1_with_publisher_a_offline":True,"v2_complete_graph_and_content":True,"both_versions_with_both_publishers_offline":True},
 "negative_observations":{"mutated_signature_v2_inspect_completed_with_validation_false":observed(mutated_inspect),"mutated_signature_v2_name_put_semantic_rejection":observed(mutated_name_put),"stale_v1_precondition_valid_and_unexpired":observed(stale_precondition),"stale_v1_name_put_sequence_conflict":observed(stale_rejected),"stale_replay_selected_record_byte_identical_valid_v2":observed(stale_postcondition),"malformed_inspect_semantic_rejection":observed(malformed_inspect),"malformed_name_put_semantic_rejection":observed(malformed_put),"absent_target_resolved":observed(absent_resolved),"absent_target_recursive_pin_bounded_failure":observed(absent_pin_failed),"absent_target_missing_from_successful_complete_recursive_pin_listing":observed(absent_pin_absent)},
 "post_routing_put_selected_record_observation":{"routing_put_status":int(mutated_routing_status),"selected_record_byte_identical_valid_v2":observed(routing_postcondition)},
 "isolation":{"nodes":4,"routing_type":"dhtserver","bounded_closest_peer_samples_only_contained_lab_ids":True,"exact_unique_active_mesh_peer_sets_verified":True,"initial_expected_active_mesh_roles":4,"post_transfer_expected_active_mesh_roles":3,"configured_full_mesh_peering":True,"docker_internal_network":True,"docker_internal_dns_used_for_dns4_aliases":True,"host_ports_published":[],"host_port_queries_completed":4,"bootstrap_peers_per_node":0,"delegated_routers":False,"delegated_publishers":False,"kubo_custom_dns_resolvers_configured":False,"autoconf":False,"autotls":False,"mdns":False,"ipns_pubsub":False,"nat_port_mapping":False,"hole_punching":False,"relays":False,"http_retrieval":False,"gateway_fetch":False,"gateway_dnslink":False,"gateway_routing_api":False,"swarm_bandwidth_metrics":False,"telemetry":False,"providing":False},
 "cleanup":{"container_ids_removed":4,"network_id_removed":True,"resource_names_absent":True,"run_labels_absent":True,"temporary_root_absent":True,"owner_only_raw_records_removed":True,"owner_only_transfer_artifacts_removed":True,"docker_queries_verified":True,"verified":True},
 "kubo":{"version":kubo,"repository_version":int(repo_version),"image":image,"index_digest":digest,"verified_repo_digest":image,"requested_platform":platform,"actual_platform":{"os":image_os,"architecture":image_arch},"engine_image_id":image_id,"local_descriptor_status":descriptor},
 "profile":{"name":"unixfs-v1-2025","ten_required_fields_verified_on_four_repositories":True},
 "provenance":{"inputs":{"run_ipns_lab_sha256":runner_hash,"immutable_manifest_sha256":base_hash,"ipns_manifest_sha256":ipns_hash},"docker":{"client":{"version":dcv,"api_version":dca,"os":dcos,"architecture":dcarch},"server":{"version":dsv,"api_version":dsa,"os":dsos,"architecture":dsarch,"storage_driver":storage}},"tools":{"bash":bash_version,"python":python_version,"coreutils":coreutils}},
 "limitations":["All four nodes ran as containers on one host; this is not independent-machine or independent-operator evidence.","The four-node private LAN DHT checks are bounded closest-peer samples plus Docker-internal/config isolation, not representative routing-table membership, propagation, scale, or public-DHT behavior.","Kubo native IPNS sequence ordering is observed here; Meshkeep release version, freshness, rollback, quorum, compatibility, resource-limit, and synchronization-atomicity semantics remain unspecified.","Cleartext key export is suitable only for this disposable lab procedure; temporary owner-only persistence and ordinary file deletion are not secure erasure.","A status-zero routing put is only paired with a subsequent byte-identical valid-v2 selected-record observation; no rejection, storage absence, or non-propagation is claimed.","No public routing, provider announcement, gateway HTTP access, interrupted synchronization, key rotation, revocation, or compromise recovery was tested."]}
directory=os.path.dirname(os.path.abspath(path)); os.makedirs(directory,mode=0o700,exist_ok=True); temporary=None
try:
 fd,temporary=tempfile.mkstemp(dir=directory,prefix=f".{os.path.basename(path)}.",suffix=".tmp")
 with os.fdopen(fd,"w",encoding="utf-8") as h: json.dump(data,h,indent=2,sort_keys=True); h.write("\n"); h.flush(); os.fsync(h.fileno())
 os.chmod(temporary,0o644); os.replace(temporary,path); temporary=None
 dfd=os.open(directory,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
 try:
  try: os.fsync(dfd)
  except OSError as e:
   if e.errno not in {errno.EINVAL,errno.ENOTSUP,errno.EROFS}: raise
 finally: os.close(dfd)
finally:
 if temporary is not None:
  try: os.unlink(temporary)
  except FileNotFoundError: pass
PY
  printf 'Results: %s\n' "$WRITE_RESULTS_INPUT"
fi
printf 'IPNS lab: PASS\n'
