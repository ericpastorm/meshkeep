#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
FIXTURES_DIR="$REPO_ROOT/examples/lab-fixtures"
MANIFEST="$SCRIPT_DIR/manifest.json"
WRITE_RESULTS=""

usage() {
  printf 'Usage: %s [--write-results PATH]\n' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-results)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      WRITE_RESULTS=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

for command in docker python3 sha256sum sort cmp timeout; do
  require_command "$command"
done
[[ -f "$MANIFEST" ]] || fail "manifest not found: $MANIFEST"

mapfile -t META < <(python3 - "$MANIFEST" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
if data.get("format") != "meshkeep-immutable-cid-lab-v1":
    raise SystemExit("unsupported manifest format")
kubo = data.get("kubo", {})
profile = data.get("profile", {})
fixtures = data.get("fixtures", {})
for key in ("v1", "v2"):
    cid = fixtures.get(key, {}).get("root_cid", "")
    if not re.fullmatch(r"b[a-z2-7]{20,}", cid):
        raise SystemExit(f"invalid expected CID for {key}")
print(kubo["version"])
print(kubo["repo_version"])
print(kubo["image"])
print(kubo["image_id"])
print(profile["name"])
print(fixtures["v1"]["root_cid"])
print(fixtures["v2"]["root_cid"])
PY
)
[[ ${#META[@]} -eq 7 ]] || fail "manifest metadata validation failed"
KUBO_VERSION=${META[0]}
KUBO_REPO_VERSION=${META[1]}
IMAGE=${META[2]}
EXPECTED_IMAGE_ID=${META[3]}
PROFILE=${META[4]}
EXPECTED_V1=${META[5]}
EXPECTED_V2=${META[6]}

TMP_ROOT=$(mktemp -d /tmp/meshkeep-lab.XXXXXX)
RUN_ID=$(basename "$TMP_ROOT" | tr -cd 'A-Za-z0-9')
NETWORK="meshkeep-lab-$RUN_ID"
declare -A NODE=(
  [publisher]="meshkeep-lab-publisher-$RUN_ID"
  [replica1]="meshkeep-lab-replica1-$RUN_ID"
  [replica2]="meshkeep-lab-replica2-$RUN_ID"
)
STARTED=()
NETWORK_CREATED=false

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if (( status != 0 )); then
    for container in "${STARTED[@]}"; do
      printf '%s\n' "--- $container logs ---" >&2
      docker logs --tail 80 "$container" >&2 2>/dev/null || true
    done
  fi
  for container in "${STARTED[@]}"; do
    docker rm -fv "$container" >/dev/null 2>&1 || true
  done
  if [[ "$NETWORK_CREATED" == true ]]; then
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
  if (( status == 0 )); then
    printf 'Cleanup: PASS (containers, internal network, and temporary repositories removed)\n'
  fi
  exit "$status"
}
trap cleanup EXIT

FIXTURE_RECORDS="$TMP_ROOT/fixture-records.tsv"
python3 - "$MANIFEST" > "$FIXTURE_RECORDS" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
count = 0
for version in ("v1", "v2"):
    files = data["fixtures"][version]["files"]
    for relative_path in sorted(files):
        if relative_path.startswith("/") or ".." in relative_path.split("/"):
            raise SystemExit("unsafe fixture path")
        print(version, relative_path, files[relative_path], sep="\t")
        count += 1
if count != 8:
    raise SystemExit("expected exactly eight fixture files")
PY

verified_files=0
while IFS=$'\t' read -r version relative_path expected_hash; do
  fixture="$FIXTURES_DIR/$version/$relative_path"
  [[ -f "$fixture" && ! -L "$fixture" ]] || fail "missing or unsafe fixture: $fixture"
  read -r actual_hash _ < <(sha256sum "$fixture")
  [[ "$actual_hash" == "$expected_hash" ]] || fail "fixture checksum mismatch: $version/$relative_path"
  ((verified_files += 1))
done < "$FIXTURE_RECORDS"
[[ $verified_files -eq 8 ]] || fail "fixture record count mismatch"
printf 'Fixtures: PASS (%s files)\n' "$verified_files"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull "$IMAGE" >/dev/null
fi
ACTUAL_IMAGE_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
[[ "$ACTUAL_IMAGE_ID" == "$EXPECTED_IMAGE_ID" ]] || fail "Kubo image ID mismatch: $ACTUAL_IMAGE_ID"
ACTUAL_KUBO_VERSION=$(docker run --rm --network none --entrypoint ipfs "$IMAGE" version --number)
[[ "$ACTUAL_KUBO_VERSION" == "$KUBO_VERSION" ]] || fail "Kubo version mismatch: $ACTUAL_KUBO_VERSION"
printf 'Kubo image: PASS (%s, %s)\n' "$KUBO_VERSION" "$ACTUAL_IMAGE_ID"

repo_ipfs() {
  local repo=$1
  shift
  docker run --rm --network none \
    --user 1000:1000 \
    --entrypoint ipfs \
    --env IPFS_PATH=/data/ipfs \
    --volume "$repo:/data/ipfs" \
    "$IMAGE" "$@"
}

EXPECTED_IMPORT="$TMP_ROOT/expected-import.json"
python3 - "$MANIFEST" > "$EXPECTED_IMPORT" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
print(json.dumps(data["profile"]["import"], sort_keys=True))
PY

for role in publisher replica1 replica2; do
  repo="$TMP_ROOT/$role-repo"
  mkdir -p "$repo"
  docker run --rm --network none \
    --env IPFS_PROFILE=test \
    --volume "$repo:/data/ipfs" \
    "$IMAGE" version >/dev/null
  repo_ipfs "$repo" config profile apply "$PROFILE" >/dev/null
  repo_ipfs "$repo" config Addresses.API /ip4/127.0.0.1/tcp/5001 >/dev/null
  repo_ipfs "$repo" config Addresses.Gateway /ip4/127.0.0.1/tcp/8080 >/dev/null
  repo_ipfs "$repo" config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001"]' >/dev/null
  repo_ipfs "$repo" bootstrap rm --all >/dev/null
  repo_ipfs "$repo" config Plugins.Plugins.telemetry.Config.Mode off >/dev/null
  [[ -z "$(repo_ipfs "$repo" bootstrap list)" ]] || fail "$role still has bootstrap peers"
  repo_ipfs "$repo" config Import --json > "$TMP_ROOT/$role-import.json"
  python3 - "$EXPECTED_IMPORT" "$TMP_ROOT/$role-import.json" <<'PY'
import json, sys
expected = json.load(open(sys.argv[1], encoding="utf-8"))
actual = json.load(open(sys.argv[2], encoding="utf-8"))
for key, value in expected.items():
    if actual.get(key) != value:
        raise SystemExit(f"profile mismatch for {key}: {actual.get(key)!r} != {value!r}")
PY
done
printf 'Profiles: PASS (%s applied and bootstrap empty on 3 repos)\n' "$PROFILE"

docker network create --internal \
  --label com.meshkeep.lab=true \
  --label "com.meshkeep.run=$RUN_ID" \
  "$NETWORK" >/dev/null
NETWORK_CREATED=true

for role in publisher replica1 replica2; do
  container=${NODE[$role]}
  docker run --detach \
    --name "$container" \
    --network "$NETWORK" \
    --network-alias "$role" \
    --label com.meshkeep.lab=true \
    --label "com.meshkeep.run=$RUN_ID" \
    --user 1000:1000 \
    --entrypoint ipfs \
    --env IPFS_PATH=/data/ipfs \
    --env IPFS_TELEMETRY=off \
    --volume "$TMP_ROOT/$role-repo:/data/ipfs" \
    --volume "$FIXTURES_DIR:/fixtures:ro" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --memory 384m \
    --cpus 0.50 \
    --pids-limit 256 \
    --stop-timeout 10 \
    "$IMAGE" daemon >/dev/null
  STARTED+=("$container")
done

wait_node() {
  local container=$1
  local _
  for _ in {1..60}; do
    if ! docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
      docker logs "$container" >&2 || true
      fail "$container exited before becoming ready"
    fi
    if docker exec "$container" ipfs id >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  fail "$container did not become ready"
}

for role in publisher replica1 replica2; do
  wait_node "${NODE[$role]}"
done
printf 'Nodes: PASS (3 ready, zero host ports, internal Docker network)\n'

PUBLISHER_PEER=$(docker exec "${NODE[publisher]}" ipfs id -f='<id>')
[[ -n "$PUBLISHER_PEER" ]] || fail "publisher peer ID is empty"
PUBLISHER_ADDR="/dns4/publisher/tcp/4001/p2p/$PUBLISHER_PEER"

connect_replicas() {
  local role peers
  for role in replica1 replica2; do
    timeout 30 docker exec "${NODE[$role]}" ipfs swarm connect "$PUBLISHER_ADDR" >/dev/null
    peers=$(docker exec "${NODE[$role]}" ipfs swarm peers)
    [[ "$peers" == *"$PUBLISHER_PEER"* ]] || fail "$role did not retain publisher swarm connection"
  done
}
connect_replicas
printf 'Swarm: PASS (two explicit connections; no bootstrap/DHT fallback)\n'

import_root() {
  local container=$1
  local version=$2
  local only_hash=${3:-false}
  local output
  local args=(add --quieter --recursive --pin=false)
  if [[ "$only_hash" == true ]]; then
    args+=(--only-hash)
  fi
  if ! output=$(timeout 90 docker exec "$container" ipfs "${args[@]}" "/fixtures/$version"); then
    fail "import failed for $version on $container"
  fi
  mapfile -t import_lines <<< "$output"
  [[ ${#import_lines[@]} -gt 0 ]] || fail "import returned no CIDs"
  printf '%s\n' "${import_lines[-1]}"
}

collect_refs() {
  local container=$1
  local cid=$2
  local destination=$3
  local raw="$destination.raw"
  {
    printf '%s\n' "$cid"
    timeout 60 docker exec "$container" ipfs refs --recursive --unique "/ipfs/$cid"
  } > "$raw"
  LC_ALL=C sort -u "$raw" > "$destination"
  rm -f "$raw"
}

verify_files() {
  local container=$1
  local version=$2
  local cid=$3
  local record_version relative_path expected_hash actual_line actual_hash
  while IFS=$'\t' read -r record_version relative_path expected_hash; do
    [[ "$record_version" == "$version" ]] || continue
    if ! actual_line=$(timeout 30 docker exec "$container" ipfs cat "/ipfs/$cid/$relative_path" | sha256sum); then
      fail "$container could not read $version/$relative_path"
    fi
    read -r actual_hash _ <<< "$actual_line"
    [[ "$actual_hash" == "$expected_hash" ]] || fail "$container content mismatch: $version/$relative_path"
  done < "$FIXTURE_RECORDS"
}

verify_recursive_pin() {
  local container=$1
  local cid=$2
  local expected_refs=$3
  local label=$4
  local pinned refs_file
  pinned=$(docker exec "$container" ipfs pin ls --type=recursive --quiet "$cid")
  [[ "$pinned" == "$cid" ]] || fail "$label does not have recursive pin $cid"
  if ! timeout 60 docker exec "$container" ipfs pin verify >/dev/null; then
    fail "$label pin verify command failed"
  fi
  refs_file="$TMP_ROOT/$label.refs"
  collect_refs "$container" "$cid" "$refs_file"
  cmp -s "$expected_refs" "$refs_file" || {
    diff -u "$expected_refs" "$refs_file" >&2 || true
    fail "$label reachable block set differs"
  }
}

replicate_version() {
  local version=$1
  local cid=$2
  local refs_file=$3
  local role
  timeout 90 docker exec "${NODE[publisher]}" ipfs pin add --recursive "$cid" >/dev/null
  collect_refs "${NODE[publisher]}" "$cid" "$refs_file"
  verify_files "${NODE[publisher]}" "$version" "$cid"
  for role in replica1 replica2; do
    timeout 90 docker exec "${NODE[$role]}" ipfs pin add --recursive "$cid" >/dev/null
    verify_recursive_pin "${NODE[$role]}" "$cid" "$refs_file" "$role-$version-online"
    verify_files "${NODE[$role]}" "$version" "$cid"
  done
}

verify_offline_version() {
  local version=$1
  local cid=$2
  local refs_file=$3
  local role
  for role in replica1 replica2; do
    verify_recursive_pin "${NODE[$role]}" "$cid" "$refs_file" "$role-$version-offline"
    verify_files "${NODE[$role]}" "$version" "$cid"
  done
}

V1=$(import_root "${NODE[publisher]}" v1)
[[ "$V1" == "$EXPECTED_V1" ]] || fail "v1 CID mismatch: $V1 != $EXPECTED_V1"
V1_REPEAT=$(import_root "${NODE[publisher]}" v1)
V1_INDEPENDENT=$(import_root "${NODE[replica1]}" v1 true)
[[ "$V1_REPEAT" == "$V1" && "$V1_INDEPENDENT" == "$V1" ]] || fail "v1 import is not deterministic across repeated/independent imports"
V1_REFS="$TMP_ROOT/v1.refs"
replicate_version v1 "$V1" "$V1_REFS"
V1_BLOCKS=$(wc -l < "$V1_REFS" | tr -d ' ')
printf 'v1 online: PASS (%s, %s reachable blocks)\n' "$V1" "$V1_BLOCKS"

docker stop --time 10 "${NODE[publisher]}" >/dev/null
verify_offline_version v1 "$V1" "$V1_REFS"
printf 'v1 origin-offline: PASS (2 replicas, complete graph and 4 file checksums each)\n'

docker start "${NODE[publisher]}" >/dev/null
wait_node "${NODE[publisher]}"
connect_replicas
V2=$(import_root "${NODE[publisher]}" v2)
[[ "$V2" == "$EXPECTED_V2" ]] || fail "v2 CID mismatch: $V2 != $EXPECTED_V2"
V2_INDEPENDENT=$(import_root "${NODE[replica2]}" v2 true)
[[ "$V2_INDEPENDENT" == "$V2" ]] || fail "v2 independent import CID mismatch"
V2_REFS="$TMP_ROOT/v2.refs"
replicate_version v2 "$V2" "$V2_REFS"
V2_BLOCKS=$(wc -l < "$V2_REFS" | tr -d ' ')
printf 'v2 online: PASS (%s, %s reachable blocks)\n' "$V2" "$V2_BLOCKS"

docker stop --time 10 "${NODE[publisher]}" >/dev/null
verify_offline_version v1 "$V1" "$V1_REFS"
verify_offline_version v2 "$V2" "$V2_REFS"
printf 'v1+v2 origin-offline: PASS (both replicas retain both immutable versions)\n'

if [[ -n "$WRITE_RESULTS" ]]; then
  [[ "$WRITE_RESULTS" == /* ]] || WRITE_RESULTS="$REPO_ROOT/$WRITE_RESULTS"
  mkdir -p "$(dirname "$WRITE_RESULTS")"
  results_tmp="$WRITE_RESULTS.partial"
  python3 - "$results_tmp" "$KUBO_VERSION" "$KUBO_REPO_VERSION" "$IMAGE" "$ACTUAL_IMAGE_ID" "$PROFILE" "$V1" "$V1_BLOCKS" "$V2" "$V2_BLOCKS" <<'PY'
import datetime, json, os, sys
(path, version, repo_version, image, image_id, profile,
 v1, v1_blocks, v2, v2_blocks) = sys.argv[1:]
data = {
    "format": "meshkeep-immutable-cid-lab-result-v1",
    "result": "pass",
    "verified_on": datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
    "kubo": {
        "version": version,
        "repo_version": int(repo_version),
        "image": image,
        "image_id": image_id,
    },
    "isolation": {
        "docker_internal_network": True,
        "host_ports_published": [],
        "bootstrap_peers_per_node": 0,
        "temporary_repositories": True,
    },
    "profile": profile,
    "v1": {
        "root_cid": v1,
        "reachable_blocks": int(v1_blocks),
        "repeat_import_match": True,
        "independent_import_match": True,
        "offline_replicas_verified": 2,
    },
    "v2": {
        "root_cid": v2,
        "reachable_blocks": int(v2_blocks),
        "independent_import_match": True,
        "offline_replicas_verified": 2,
        "v1_retained": True,
    },
    "limitations": [
        "IPNS publication and signed record validation were not exercised",
        "publishing-key transfer was not exercised",
        "containers emulate isolated nodes on one Docker host",
    ],
}
with open(path, "x", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.chmod(path, 0o644)
PY
  mv "$results_tmp" "$WRITE_RESULTS"
  printf 'Results: %s\n' "$WRITE_RESULTS"
fi

printf 'Lab: PASS\n'
