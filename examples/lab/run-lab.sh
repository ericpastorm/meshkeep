#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT_FILE="$SCRIPT_DIR/run-lab.sh"
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
FIXTURES_DIR="$REPO_ROOT/examples/lab-fixtures"
MANIFEST="$SCRIPT_DIR/manifest.json"
WRITE_RESULTS_INPUT=""

usage() {
  printf 'Usage: %s [--write-results PATH]\n' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-results)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      WRITE_RESULTS_INPUT=$2
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

for command in cmp diff docker grep mktemp python3 sha256sum sort timeout tr wc; do
  require_command "$command"
done
[[ -f "$MANIFEST" ]] || fail "manifest not found: $MANIFEST"
[[ -f "$SCRIPT_FILE" ]] || fail "runner not found: $SCRIPT_FILE"

mapfile -t META < <(python3 - "$MANIFEST" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

if data.get("format") != "meshkeep-immutable-cid-lab-v2":
    raise SystemExit("unsupported manifest format")

kubo = data.get("kubo", {})
profile = data.get("profile", {})
fixtures = data.get("fixtures", {})
required_import = {
    "CidVersion": 1,
    "HashFunction": "sha2-256",
    "UnixFSChunker": "size-1048576",
    "UnixFSDAGLayout": "balanced",
    "UnixFSDirectoryMaxLinks": 0,
    "UnixFSFileMaxLinks": 1024,
    "UnixFSHAMTDirectoryMaxFanout": 256,
    "UnixFSHAMTDirectorySizeEstimation": "block",
    "UnixFSHAMTDirectorySizeThreshold": "256KiB",
    "UnixFSRawLeaves": True,
}

image = kubo.get("image", "")
index_digest = kubo.get("index_digest", "")
image_match = re.fullmatch(r"[^@\s]+@(sha256:[0-9a-f]{64})", image)
if image_match is None:
    raise SystemExit("invalid digest-pinned Kubo image reference")
if not re.fullmatch(r"sha256:[0-9a-f]{64}", index_digest):
    raise SystemExit("invalid Kubo index digest")
if image_match.group(1) != index_digest:
    raise SystemExit("Kubo image reference and index digest differ")
if kubo.get("requested_platform") != "linux/amd64":
    raise SystemExit("unsupported requested Kubo platform")
if kubo.get("version") != "0.42.0":
    raise SystemExit("unsupported Kubo version")
if kubo.get("repo_version") != 18:
    raise SystemExit("unsupported Kubo repository version")
if profile.get("name") != "unixfs-v1-2025":
    raise SystemExit("unsupported import profile")
if profile.get("import") != required_import:
    raise SystemExit("manifest must contain the exact ten required import profile fields")

for key in ("v1", "v2"):
    cid = fixtures.get(key, {}).get("root_cid", "")
    if not re.fullmatch(r"b[a-z2-7]{20,}", cid):
        raise SystemExit(f"invalid expected CID for {key}")

print(kubo["version"])
print(kubo["repo_version"])
print(image)
print(index_digest)
print(kubo["requested_platform"])
print(profile["name"])
print(fixtures["v1"]["root_cid"])
print(fixtures["v2"]["root_cid"])
PY
)
[[ ${#META[@]} -eq 8 ]] || fail "manifest metadata validation failed"
KUBO_VERSION=${META[0]}
KUBO_REPO_VERSION=${META[1]}
IMAGE=${META[2]}
EXPECTED_INDEX_DIGEST=${META[3]}
REQUESTED_PLATFORM=${META[4]}
PROFILE=${META[5]}
EXPECTED_V1=${META[6]}
EXPECTED_V2=${META[7]}

read -r SCRIPT_SHA256 _ < <(sha256sum "$SCRIPT_FILE")
read -r MANIFEST_SHA256 _ < <(sha256sum "$MANIFEST")

mapfile -t RUNNER_META < <(python3 - <<'PY'
import platform

os_release = platform.freedesktop_os_release()
uname = platform.uname()
print(os_release.get("ID", "unknown"))
print(os_release.get("VERSION_ID", "unknown"))
print(uname.system)
print(uname.release)
print(uname.machine)
print(platform.python_version())
PY
)
[[ ${#RUNNER_META[@]} -eq 6 ]] || fail "runner provenance collection failed"
RUNNER_OS_ID=${RUNNER_META[0]}
RUNNER_OS_VERSION=${RUNNER_META[1]}
RUNNER_KERNEL_SYSNAME=${RUNNER_META[2]}
RUNNER_KERNEL_RELEASE=${RUNNER_META[3]}
RUNNER_KERNEL_MACHINE=${RUNNER_META[4]}
PYTHON_VERSION=${RUNNER_META[5]}
BASH_VERSION_OBSERVED=$BASH_VERSION
COREUTILS_VERSION=$(LC_ALL=C sha256sum --version | python3 -c 'import sys; print(sys.stdin.readline().split()[-1])')

DOCKER_META_RAW=$(docker version --format '{{println .Client.Version}}{{println .Client.APIVersion}}{{println .Client.Os}}{{println .Client.Arch}}{{println .Server.Version}}{{println .Server.APIVersion}}{{println .Server.Os}}{{println .Server.Arch}}{{.Server.KernelVersion}}') || fail "Docker version provenance query failed"
mapfile -t DOCKER_META <<< "$DOCKER_META_RAW"
[[ ${#DOCKER_META[@]} -eq 9 ]] || fail "Docker version provenance collection failed"
DOCKER_CLIENT_VERSION=${DOCKER_META[0]}
DOCKER_CLIENT_API=${DOCKER_META[1]}
DOCKER_CLIENT_OS=${DOCKER_META[2]}
DOCKER_CLIENT_ARCH=${DOCKER_META[3]}
DOCKER_SERVER_VERSION=${DOCKER_META[4]}
DOCKER_SERVER_API=${DOCKER_META[5]}
DOCKER_SERVER_OS=${DOCKER_META[6]}
DOCKER_SERVER_ARCH=${DOCKER_META[7]}
DOCKER_SERVER_KERNEL=${DOCKER_META[8]}
DOCKER_STORAGE_DRIVER=$(docker info --format '{{.Driver}}')
[[ -n "$DOCKER_STORAGE_DRIVER" ]] || fail "Docker storage driver observation is empty"

PULL_PLATFORM_SUPPORTED=false
RUN_PLATFORM_SUPPORTED=false
INSPECT_PLATFORM_SUPPORTED=false
PULL_PLATFORM_ARGS=()
RUN_PLATFORM_ARGS=()
INSPECT_PLATFORM_ARGS=()
if LC_ALL=C docker pull --help | grep -q -- '--platform'; then
  PULL_PLATFORM_SUPPORTED=true
  PULL_PLATFORM_ARGS=(--platform "$REQUESTED_PLATFORM")
fi
if LC_ALL=C docker run --help | grep -q -- '--platform'; then
  RUN_PLATFORM_SUPPORTED=true
  RUN_PLATFORM_ARGS=(--platform "$REQUESTED_PLATFORM")
fi
if LC_ALL=C docker image inspect --help | grep -q -- '--platform'; then
  INSPECT_PLATFORM_SUPPORTED=true
  INSPECT_PLATFORM_ARGS=(--platform "$REQUESTED_PLATFORM")
fi

TMP_ROOT=$(mktemp -d /tmp/meshkeep-lab.XXXXXX)
RUN_ID=$(basename "$TMP_ROOT" | tr -cd 'A-Za-z0-9')
[[ -n "$RUN_ID" ]] || fail "temporary run identifier is empty"
NETWORK="meshkeep-lab-$RUN_ID"
declare -A NODE=(
  [publisher]="meshkeep-lab-publisher-$RUN_ID"
  [replica1]="meshkeep-lab-replica1-$RUN_ID"
  [replica2]="meshkeep-lab-replica2-$RUN_ID"
)
declare -A CONTAINER_ID=()
declare -A REPO_VERSION=()
NETWORK_ID=""
CLEANUP_VERIFIED=false
DOCKER_QUERY_FAILED=false

safe_remove_tmp_root() {
  [[ -n "${TMP_ROOT:-}" && "$TMP_ROOT" == /tmp/meshkeep-lab.* ]] || return 1
  rm -rf -- "$TMP_ROOT"
}

capture_docker_query() {
  local variable_name=$1
  shift
  local query_output

  if ! query_output=$(docker "$@"); then
    DOCKER_QUERY_FAILED=true
    return 1
  fi
  printf -v "$variable_name" '%s' "$query_output"
}

output_has_line() {
  local output=$1
  local expected=$2
  local line

  while IFS= read -r line; do
    [[ "$line" == "$expected" ]] && return 0
  done <<< "$output"
  return 1
}

output_has_name() {
  local output=$1
  local expected=$2
  local resource_id resource_name

  while IFS=$'\t' read -r resource_id resource_name; do
    [[ -n "$resource_id" && "$resource_name" == "$expected" ]] && return 0
  done <<< "$output"
  return 1
}

collect_ids_for_name() {
  local output=$1
  local expected=$2
  local target_name=$3
  local resource_id resource_name

  while IFS=$'\t' read -r resource_id resource_name; do
    if [[ -n "$resource_id" && "$resource_name" == "$expected" ]]; then
      printf -v "$target_name" '%s' "$resource_id"
      return 0
    fi
  done <<< "$output"
  return 1
}

fallback_cleanup() {
  local status=$?
  local cleanup_failed=0
  local role resource id named_id
  local container_ids_output=""
  local container_names_output=""
  local container_labels_output=""
  local network_ids_output=""
  local network_names_output=""
  local network_labels_output=""
  local -A container_targets=()
  local -A network_targets=()

  trap - EXIT INT TERM HUP
  if [[ "$CLEANUP_VERIFIED" == true ]]; then
    exit "$status"
  fi
  if (( status == 0 )); then
    status=1
  fi

  set +e
  [[ "$DOCKER_QUERY_FAILED" == true ]] && cleanup_failed=1

  capture_docker_query container_ids_output ps -aq --no-trunc || cleanup_failed=1
  capture_docker_query container_names_output ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' || cleanup_failed=1
  capture_docker_query container_labels_output ps -aq --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1

  for role in publisher replica1 replica2; do
    id=${CONTAINER_ID[$role]:-}
    if [[ -n "$id" ]]; then
      if [[ -n "$container_ids_output" ]] && output_has_line "$container_ids_output" "$id"; then
        container_targets[$id]=true
      elif [[ -z "$container_ids_output" ]]; then
        docker rm -fv "$id" >/dev/null 2>&1 || true
      fi
    fi
  done

  for role in publisher replica1 replica2; do
    named_id=""
    if collect_ids_for_name "$container_names_output" "${NODE[$role]}" named_id; then
      container_targets[$named_id]=true
    elif [[ -z "$container_names_output" ]]; then
      docker rm -fv "${NODE[$role]}" >/dev/null 2>&1 || true
    fi
  done

  while IFS= read -r resource; do
    [[ -n "$resource" ]] || continue
    container_targets[$resource]=true
  done <<< "$container_labels_output"

  for resource in "${!container_targets[@]}"; do
    docker logs --tail 80 "$resource" >&2 2>/dev/null || true
    docker rm -fv "$resource" >/dev/null 2>&1 || cleanup_failed=1
  done

  capture_docker_query network_ids_output network ls -q --no-trunc || cleanup_failed=1
  capture_docker_query network_names_output network ls --no-trunc --format '{{.ID}}\t{{.Name}}' || cleanup_failed=1
  capture_docker_query network_labels_output network ls -q --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1

  if [[ -n "$NETWORK_ID" ]]; then
    if [[ -n "$network_ids_output" ]] && output_has_line "$network_ids_output" "$NETWORK_ID"; then
      network_targets[$NETWORK_ID]=true
    elif [[ -z "$network_ids_output" ]]; then
      docker network rm "$NETWORK_ID" >/dev/null 2>&1 || true
    fi
  fi

  named_id=""
  if collect_ids_for_name "$network_names_output" "$NETWORK" named_id; then
    network_targets[$named_id]=true
  elif [[ -z "$network_names_output" ]]; then
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi

  while IFS= read -r resource; do
    [[ -n "$resource" ]] || continue
    network_targets[$resource]=true
  done <<< "$network_labels_output"

  for resource in "${!network_targets[@]}"; do
    docker network rm "$resource" >/dev/null 2>&1 || cleanup_failed=1
  done

  safe_remove_tmp_root || cleanup_failed=1

  container_ids_output=""
  container_names_output=""
  container_labels_output=""
  network_ids_output=""
  network_names_output=""
  network_labels_output=""
  capture_docker_query container_ids_output ps -aq --no-trunc || cleanup_failed=1
  capture_docker_query container_names_output ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' || cleanup_failed=1
  capture_docker_query container_labels_output ps -aq --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1
  capture_docker_query network_ids_output network ls -q --no-trunc || cleanup_failed=1
  capture_docker_query network_names_output network ls --no-trunc --format '{{.ID}}\t{{.Name}}' || cleanup_failed=1
  capture_docker_query network_labels_output network ls -q --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || cleanup_failed=1

  for role in publisher replica1 replica2; do
    id=${CONTAINER_ID[$role]:-}
    if [[ -n "$id" ]] && output_has_line "$container_ids_output" "$id"; then
      cleanup_failed=1
    fi
    if output_has_name "$container_names_output" "${NODE[$role]}"; then
      cleanup_failed=1
    fi
  done
  [[ -n "$container_labels_output" ]] && cleanup_failed=1
  if [[ -n "$NETWORK_ID" ]] && output_has_line "$network_ids_output" "$NETWORK_ID"; then
    cleanup_failed=1
  fi
  if output_has_name "$network_names_output" "$NETWORK"; then
    cleanup_failed=1
  fi
  [[ -n "$network_labels_output" ]] && cleanup_failed=1
  [[ ! -e "$TMP_ROOT" && ! -L "$TMP_ROOT" ]] || cleanup_failed=1

  if (( cleanup_failed != 0 )); then
    printf 'Cleanup fallback: INCOMPLETE for run %s\n' "$RUN_ID" >&2
  fi
  exit "$status"
}

trap fallback_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

verify_successful_cleanup() {
  local role id
  local container_ids_output=""
  local container_names_output=""
  local container_labels_output=""
  local network_ids_output=""
  local network_names_output=""
  local network_labels_output=""

  for role in publisher replica1 replica2; do
    id=${CONTAINER_ID[$role]:-}
    [[ -n "$id" ]] || fail "missing captured container ID for $role"
    docker rm -fv "$id" >/dev/null || fail "failed to remove $role container by ID"
  done
  [[ -n "$NETWORK_ID" ]] || fail "missing captured network ID"
  docker network rm "$NETWORK_ID" >/dev/null || fail "failed to remove internal network by ID"
  safe_remove_tmp_root || fail "failed to remove temporary repository root"

  capture_docker_query container_ids_output ps -aq --no-trunc || fail "failed to list containers after cleanup"
  capture_docker_query container_names_output ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' || fail "failed to list container names after cleanup"
  capture_docker_query container_labels_output ps -aq --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || fail "failed to list run-labeled containers after cleanup"
  capture_docker_query network_ids_output network ls -q --no-trunc || fail "failed to list networks after cleanup"
  capture_docker_query network_names_output network ls --no-trunc --format '{{.ID}}\t{{.Name}}' || fail "failed to list network names after cleanup"
  capture_docker_query network_labels_output network ls -q --no-trunc --filter "label=com.meshkeep.run=$RUN_ID" || fail "failed to list run-labeled networks after cleanup"

  for role in publisher replica1 replica2; do
    id=${CONTAINER_ID[$role]}
    output_has_line "$container_ids_output" "$id" && fail "$role container ID still exists after cleanup"
    output_has_name "$container_names_output" "${NODE[$role]}" && fail "$role container name still exists after cleanup"
  done
  output_has_line "$network_ids_output" "$NETWORK_ID" && fail "network ID still exists after cleanup"
  output_has_name "$network_names_output" "$NETWORK" && fail "network name still exists after cleanup"
  [[ -z "$container_labels_output" ]] || fail "run-labeled containers remain after cleanup"
  [[ -z "$network_labels_output" ]] || fail "run-labeled networks remain after cleanup"
  [[ ! -e "$TMP_ROOT" && ! -L "$TMP_ROOT" ]] || fail "temporary repository root remains after cleanup"

  CLEANUP_VERIFIED=true
  printf 'Cleanup: PASS (3 container IDs, network ID, run labels, names, and temporary root absent)\n'
}

FIXTURE_RECORDS="$TMP_ROOT/fixture-records.tsv"
python3 - "$MANIFEST" > "$FIXTURE_RECORDS" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

count = 0
for version in ("v1", "v2"):
    files = data["fixtures"][version]["files"]
    for relative_path in sorted(files):
        expected_hash = files[relative_path]
        if relative_path.startswith("/") or ".." in relative_path.split("/"):
            raise SystemExit("unsafe fixture path")
        if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            raise SystemExit("invalid fixture SHA-256")
        print(version, relative_path, expected_hash, sep="\t")
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

if ! docker image inspect "${INSPECT_PLATFORM_ARGS[@]}" "$IMAGE" >/dev/null 2>&1; then
  docker pull "${PULL_PLATFORM_ARGS[@]}" "$IMAGE" >/dev/null
fi

IMAGE_INSPECT_RAW="$TMP_ROOT/image-inspect.json"
if ! docker image inspect "${INSPECT_PLATFORM_ARGS[@]}" "$IMAGE" > "$IMAGE_INSPECT_RAW"; then
  fail "failed to inspect the complete Kubo image record"
fi
IMAGE_METADATA_JSON=$(python3 - "$IMAGE_INSPECT_RAW" "$EXPECTED_INDEX_DIGEST" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    records = json.load(handle)
expected_digest = sys.argv[2]
if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
    raise SystemExit("Docker image inspect did not return exactly one complete image record")
record = records[0]
repo_digests = record.get("RepoDigests")
if not isinstance(repo_digests, list) or not repo_digests:
    raise SystemExit("Kubo image has no local RepoDigests")
normalized_digests = []
for repo_digest in sorted(set(repo_digests)):
    if not isinstance(repo_digest, str) or "@" not in repo_digest:
        raise SystemExit("invalid local RepoDigest")
    digest_suffix = repo_digest.rsplit("@", 1)[1]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest_suffix):
        raise SystemExit("invalid local RepoDigest suffix")
    normalized_digests.append(digest_suffix)
if expected_digest not in normalized_digests:
    raise SystemExit("expected Kubo index digest is absent from local RepoDigests")

descriptor = record.get("Descriptor")
descriptor_status = "present" if isinstance(descriptor, dict) else "unavailable"
descriptor_observation = None
if descriptor_status == "present":
    descriptor_observation = {}
    for source, target in (("digest", "digest"), ("mediaType", "media_type"), ("size", "size")):
        if source in descriptor:
            descriptor_observation[target] = descriptor[source]
    platform_value = descriptor.get("platform")
    if isinstance(platform_value, dict):
        descriptor_observation["platform"] = {
            key: platform_value[key]
            for key in ("os", "architecture", "variant")
            if key in platform_value
        }
    if not descriptor_observation:
        descriptor_observation = None

metadata = {
    "architecture": record.get("Architecture"),
    "descriptor_observation": descriptor_observation,
    "descriptor_status": descriptor_status,
    "engine_image_id": record.get("Id"),
    "os": record.get("Os"),
}
if not all(isinstance(metadata[key], str) and metadata[key] for key in ("architecture", "engine_image_id", "os")):
    raise SystemExit("Docker image inspect omitted required image observations")
print(json.dumps(metadata, sort_keys=True, separators=(",", ":")))
PY
) || fail "failed to validate the complete Kubo image record"
ENGINE_IMAGE_ID=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["engine_image_id"])' "$IMAGE_METADATA_JSON")
ACTUAL_IMAGE_OS=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["os"])' "$IMAGE_METADATA_JSON")
ACTUAL_IMAGE_ARCH=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["architecture"])' "$IMAGE_METADATA_JSON")
LOCAL_DESCRIPTOR_STATUS=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["descriptor_status"])' "$IMAGE_METADATA_JSON")
LOCAL_DESCRIPTOR_JSON=$(python3 -c 'import json, sys; print(json.dumps(json.loads(sys.argv[1])["descriptor_observation"], sort_keys=True))' "$IMAGE_METADATA_JSON")
VERIFIED_REPO_DIGEST=$IMAGE
[[ "$ACTUAL_IMAGE_OS/$ACTUAL_IMAGE_ARCH" == "$REQUESTED_PLATFORM" ]] || fail "Kubo image platform mismatch: $ACTUAL_IMAGE_OS/$ACTUAL_IMAGE_ARCH"

ACTUAL_KUBO_VERSION=$(docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none \
  --label com.meshkeep.lab=true \
  --label "com.meshkeep.run=$RUN_ID" \
  --entrypoint ipfs \
  "$IMAGE" version --number)
[[ "$ACTUAL_KUBO_VERSION" == "$KUBO_VERSION" ]] || fail "Kubo version mismatch: $ACTUAL_KUBO_VERSION"
printf 'Kubo image: PASS (%s, %s, index %s)\n' "$KUBO_VERSION" "$REQUESTED_PLATFORM" "$EXPECTED_INDEX_DIGEST"

repo_ipfs() {
  local repo=$1
  shift
  docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none \
    --label com.meshkeep.lab=true \
    --label "com.meshkeep.run=$RUN_ID" \
    --user 1000:1000 \
    --entrypoint ipfs \
    --env IPFS_PATH=/data/ipfs \
    --volume "$repo:/data/ipfs" \
    "$IMAGE" "$@"
}

read_repo_version() {
  local version_file=$1
  python3 - "$version_file" "$KUBO_REPO_VERSION" <<'PY'
import os
import re
import stat
import sys

path = sys.argv[1]
expected = int(sys.argv[2])
flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(path, flags)
try:
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit("repository version is not a regular file")
    if metadata.st_size > 32:
        raise SystemExit("repository version file is unexpectedly large")
    raw = os.read(fd, 33)
finally:
    os.close(fd)
try:
    text = raw.decode("ascii")
except UnicodeDecodeError as error:
    raise SystemExit("repository version is not ASCII") from error
if not re.fullmatch(r"[0-9]+\n?", text):
    raise SystemExit("repository version is not an integer")
observed = int(text)
if observed != expected:
    raise SystemExit(f"repository version mismatch: {observed} != {expected}")
print(observed)
PY
}

EXPECTED_IMPORT_JSON=$(python3 - "$MANIFEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
print(json.dumps(data["profile"]["import"], sort_keys=True, separators=(",", ":")))
PY
)
EXPECTED_IMPORT="$TMP_ROOT/expected-import.json"
printf '%s\n' "$EXPECTED_IMPORT_JSON" > "$EXPECTED_IMPORT"

for role in publisher replica1 replica2; do
  repo="$TMP_ROOT/$role-repo"
  mkdir -p "$repo"
  docker run "${RUN_PLATFORM_ARGS[@]}" --rm --network none \
    --label com.meshkeep.lab=true \
    --label "com.meshkeep.run=$RUN_ID" \
    --env IPFS_PROFILE=test \
    --volume "$repo:/data/ipfs" \
    "$IMAGE" version >/dev/null

  REPO_VERSION[$role]=$(read_repo_version "$repo/version")
  repo_ipfs "$repo" config profile apply "$PROFILE" >/dev/null
  repo_ipfs "$repo" config Addresses.API /ip4/127.0.0.1/tcp/5001 >/dev/null
  repo_ipfs "$repo" config Addresses.Gateway /ip4/127.0.0.1/tcp/8080 >/dev/null
  repo_ipfs "$repo" config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001"]' >/dev/null
  repo_ipfs "$repo" config Routing.Type none >/dev/null
  repo_ipfs "$repo" config --json Provide.Enabled false >/dev/null
  repo_ipfs "$repo" bootstrap rm --all >/dev/null
  repo_ipfs "$repo" config --json Discovery.MDNS.Enabled false >/dev/null
  repo_ipfs "$repo" config Plugins.Plugins.telemetry.Config.Mode off >/dev/null

  [[ "$(repo_ipfs "$repo" config Routing.Type)" == "none" ]] || fail "$role routing is not disabled"
  [[ "$(repo_ipfs "$repo" config Provide.Enabled)" == "false" ]] || fail "$role providing is not disabled"
  [[ -z "$(repo_ipfs "$repo" bootstrap list)" ]] || fail "$role still has bootstrap peers"
  [[ "$(repo_ipfs "$repo" config Discovery.MDNS.Enabled)" == "false" ]] || fail "$role mDNS is not disabled"
  [[ "$(repo_ipfs "$repo" config Plugins.Plugins.telemetry.Config.Mode)" == "off" ]] || fail "$role telemetry is not disabled"

  repo_ipfs "$repo" config Import --json > "$TMP_ROOT/$role-import.json"
  python3 - "$EXPECTED_IMPORT" "$TMP_ROOT/$role-import.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as expected_handle:
    expected = json.load(expected_handle)
with open(sys.argv[2], encoding="utf-8") as actual_handle:
    actual = json.load(actual_handle)
if len(expected) != 10:
    raise SystemExit("expected import profile does not contain ten required fields")
for key, value in expected.items():
    if actual.get(key) != value:
        raise SystemExit(f"profile mismatch for {key}: {actual.get(key)!r} != {value!r}")
PY
done
printf 'Profiles: PASS (10 import fields, repo version %s, routing/providing disabled on 3 repos)\n' "$KUBO_REPO_VERSION"

NETWORK_ID=$(docker network create --internal \
  --label com.meshkeep.lab=true \
  --label "com.meshkeep.run=$RUN_ID" \
  "$NETWORK")
[[ -n "$NETWORK_ID" ]] || fail "Docker did not return the created network ID"

for role in publisher replica1 replica2; do
  container=${NODE[$role]}
  CONTAINER_ID[$role]=$(docker run "${RUN_PLATFORM_ARGS[@]}" --detach \
    --name "$container" \
    --network "$NETWORK_ID" \
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
    "$IMAGE" daemon)
  [[ -n "${CONTAINER_ID[$role]}" ]] || fail "Docker did not return the $role container ID"
done

wait_node() {
  local container=$1
  local _
  for _ in {1..60}; do
    if ! timeout 10 docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
      docker logs --tail 80 "$container" >&2 2>/dev/null || true
      fail "$container exited before becoming ready"
    fi
    if timeout 10 docker exec "$container" ipfs id >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs --tail 80 "$container" >&2 2>/dev/null || true
  fail "$container did not become ready"
}

assert_no_active_dht() {
  local container=$1
  local peer output status
  peer=$(timeout 10 docker exec "$container" ipfs id -f='<id>')
  [[ -n "$peer" ]] || fail "$container peer ID is empty during DHT assertion"
  set +e
  output=$(timeout 15 docker exec "$container" ipfs dht query "$peer" 2>&1)
  status=$?
  set -e
  [[ $status -ne 0 ]] || fail "$container unexpectedly has an active DHT"
  [[ $status -ne 124 && $status -ne 137 ]] || fail "$container DHT assertion timed out"
  output=${output//$'\r'/}
  [[ "$output" == "Error: routing service is not a DHT" ]] || fail "$container returned unexpected DHT failure: $output"
}

for role in publisher replica1 replica2; do
  wait_node "${CONTAINER_ID[$role]}"
  assert_no_active_dht "${CONTAINER_ID[$role]}"
done
printf 'Nodes: PASS (3 ready, zero host ports, internal network, no active DHT)\n'

PUBLISHER_PEER=$(timeout 10 docker exec "${CONTAINER_ID[publisher]}" ipfs id -f='<id>')
[[ -n "$PUBLISHER_PEER" ]] || fail "publisher peer ID is empty"
PUBLISHER_ADDR="/dns4/publisher/tcp/4001/p2p/$PUBLISHER_PEER"

connect_replicas() {
  local role peers
  for role in replica1 replica2; do
    timeout 30 docker exec "${CONTAINER_ID[$role]}" ipfs swarm connect "$PUBLISHER_ADDR" >/dev/null
    peers=$(timeout 15 docker exec "${CONTAINER_ID[$role]}" ipfs swarm peers)
    [[ "$peers" == *"$PUBLISHER_PEER"* ]] || fail "$role did not retain publisher swarm connection"
  done
}
connect_replicas
printf 'Swarm: PASS (two explicit connections; Bitswap transfer with routing disabled)\n'

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
  pinned=$(timeout 30 docker exec "$container" ipfs pin ls --type=recursive --quiet "$cid")
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
  timeout 90 docker exec "${CONTAINER_ID[publisher]}" ipfs pin add --recursive "$cid" >/dev/null
  collect_refs "${CONTAINER_ID[publisher]}" "$cid" "$refs_file"
  verify_files "${CONTAINER_ID[publisher]}" "$version" "$cid"
  for role in replica1 replica2; do
    timeout 90 docker exec "${CONTAINER_ID[$role]}" ipfs pin add --recursive "$cid" >/dev/null
    verify_recursive_pin "${CONTAINER_ID[$role]}" "$cid" "$refs_file" "$role-$version-online"
    verify_files "${CONTAINER_ID[$role]}" "$version" "$cid"
  done
}

verify_offline_version() {
  local version=$1
  local cid=$2
  local refs_file=$3
  local role
  for role in replica1 replica2; do
    verify_recursive_pin "${CONTAINER_ID[$role]}" "$cid" "$refs_file" "$role-$version-offline"
    verify_files "${CONTAINER_ID[$role]}" "$version" "$cid"
  done
}

V1=$(import_root "${CONTAINER_ID[publisher]}" v1)
[[ "$V1" == "$EXPECTED_V1" ]] || fail "v1 CID mismatch: $V1 != $EXPECTED_V1"
V1_REPEAT=$(import_root "${CONTAINER_ID[publisher]}" v1)
V1_INDEPENDENT=$(import_root "${CONTAINER_ID[replica1]}" v1 true)
[[ "$V1_REPEAT" == "$V1" && "$V1_INDEPENDENT" == "$V1" ]] || fail "v1 import is not deterministic across repeated/independent imports"
V1_REFS="$TMP_ROOT/v1.refs"
replicate_version v1 "$V1" "$V1_REFS"
V1_BLOCKS=$(wc -l < "$V1_REFS" | tr -d ' ')
printf 'v1 online: PASS (%s, %s reachable blocks)\n' "$V1" "$V1_BLOCKS"

timeout 30 docker stop --time 10 "${CONTAINER_ID[publisher]}" >/dev/null
verify_offline_version v1 "$V1" "$V1_REFS"
printf 'v1 origin-offline: PASS (2 replicas, complete graph and 4 file checksums each)\n'

timeout 30 docker start "${CONTAINER_ID[publisher]}" >/dev/null
wait_node "${CONTAINER_ID[publisher]}"
assert_no_active_dht "${CONTAINER_ID[publisher]}"
connect_replicas
V2=$(import_root "${CONTAINER_ID[publisher]}" v2)
[[ "$V2" == "$EXPECTED_V2" ]] || fail "v2 CID mismatch: $V2 != $EXPECTED_V2"
V2_INDEPENDENT=$(import_root "${CONTAINER_ID[replica2]}" v2 true)
[[ "$V2_INDEPENDENT" == "$V2" ]] || fail "v2 independent import CID mismatch"
V2_REFS="$TMP_ROOT/v2.refs"
replicate_version v2 "$V2" "$V2_REFS"
V2_BLOCKS=$(wc -l < "$V2_REFS" | tr -d ' ')
printf 'v2 online: PASS (%s, %s reachable blocks)\n' "$V2" "$V2_BLOCKS"

timeout 30 docker stop --time 10 "${CONTAINER_ID[publisher]}" >/dev/null
verify_offline_version v1 "$V1" "$V1_REFS"
verify_offline_version v2 "$V2" "$V2_REFS"
printf 'v1+v2 origin-offline: PASS (both replicas retain both immutable versions)\n'

verify_successful_cleanup

if [[ -n "$WRITE_RESULTS_INPUT" ]]; then
  if [[ "$WRITE_RESULTS_INPUT" == /* ]]; then
    WRITE_RESULTS_TARGET=$WRITE_RESULTS_INPUT
  else
    WRITE_RESULTS_TARGET="$REPO_ROOT/$WRITE_RESULTS_INPUT"
  fi
  WRITE_RESULTS_DISPLAY=$(python3 - "$WRITE_RESULTS_TARGET" "$REPO_ROOT" <<'PY'
import os
import sys

target = os.path.abspath(sys.argv[1])
root = os.path.abspath(sys.argv[2])
try:
    inside = os.path.commonpath((target, root)) == root
except ValueError:
    inside = False
print(os.path.relpath(target, root) if inside else target)
PY
)

  python3 - \
    "$WRITE_RESULTS_TARGET" \
    "$ACTUAL_KUBO_VERSION" \
    "$IMAGE" \
    "$REQUESTED_PLATFORM" \
    "$EXPECTED_INDEX_DIGEST" \
    "$VERIFIED_REPO_DIGEST" \
    "$ENGINE_IMAGE_ID" \
    "$ACTUAL_IMAGE_OS" \
    "$ACTUAL_IMAGE_ARCH" \
    "$LOCAL_DESCRIPTOR_STATUS" \
    "$LOCAL_DESCRIPTOR_JSON" \
    "$PULL_PLATFORM_SUPPORTED" \
    "$RUN_PLATFORM_SUPPORTED" \
    "$INSPECT_PLATFORM_SUPPORTED" \
    "$PROFILE" \
    "$EXPECTED_IMPORT_JSON" \
    "${REPO_VERSION[publisher]}" \
    "${REPO_VERSION[replica1]}" \
    "${REPO_VERSION[replica2]}" \
    "$V1" \
    "$V1_BLOCKS" \
    "$V2" \
    "$V2_BLOCKS" \
    "$SCRIPT_SHA256" \
    "$MANIFEST_SHA256" \
    "$DOCKER_CLIENT_VERSION" \
    "$DOCKER_CLIENT_API" \
    "$DOCKER_CLIENT_OS" \
    "$DOCKER_CLIENT_ARCH" \
    "$DOCKER_SERVER_VERSION" \
    "$DOCKER_SERVER_API" \
    "$DOCKER_SERVER_OS" \
    "$DOCKER_SERVER_ARCH" \
    "$DOCKER_SERVER_KERNEL" \
    "$DOCKER_STORAGE_DRIVER" \
    "$RUNNER_OS_ID" \
    "$RUNNER_OS_VERSION" \
    "$RUNNER_KERNEL_SYSNAME" \
    "$RUNNER_KERNEL_RELEASE" \
    "$RUNNER_KERNEL_MACHINE" \
    "$BASH_VERSION_OBSERVED" \
    "$PYTHON_VERSION" \
    "$COREUTILS_VERSION" <<'PY'
import datetime
import errno
import json
import os
import sys
import tempfile

(
    path,
    kubo_version,
    image,
    requested_platform,
    index_digest,
    verified_repo_digest,
    engine_image_id,
    actual_image_os,
    actual_image_arch,
    local_descriptor_status,
    local_descriptor_json,
    pull_platform_supported,
    run_platform_supported,
    inspect_platform_supported,
    profile,
    expected_import_json,
    publisher_repo_version,
    replica1_repo_version,
    replica2_repo_version,
    v1,
    v1_blocks,
    v2,
    v2_blocks,
    script_sha256,
    manifest_sha256,
    docker_client_version,
    docker_client_api,
    docker_client_os,
    docker_client_arch,
    docker_server_version,
    docker_server_api,
    docker_server_os,
    docker_server_arch,
    docker_server_kernel,
    docker_storage_driver,
    runner_os_id,
    runner_os_version,
    runner_kernel_sysname,
    runner_kernel_release,
    runner_kernel_machine,
    bash_version,
    python_version,
    coreutils_version,
) = sys.argv[1:]

local_descriptor = json.loads(local_descriptor_json)
required_import = json.loads(expected_import_json)

data = {
    "cleanup": {
        "container_ids_removed": 3,
        "network_id_removed": True,
        "resource_names_absent": True,
        "run_labels_absent": True,
        "temporary_root_absent": True,
        "docker_queries_verified": True,
        "verified": True,
    },
    "format": "meshkeep-immutable-cid-lab-result-v2",
    "isolation": {
        "bootstrap_peers_per_node": 0,
        "docker_internal_network": True,
        "host_ports_published": [],
        "mdns_enabled": False,
        "providing_enabled": False,
        "routing_type": "none",
        "runtime_dht_active": False,
        "runtime_dht_assertion": "routing service is not a DHT",
    },
    "kubo": {
        "actual_platform": {
            "architecture": actual_image_arch,
            "os": actual_image_os,
        },
        "engine_image_id": engine_image_id,
        "image": image,
        "index_digest": index_digest,
        "local_descriptor_status": local_descriptor_status,
        "local_descriptor_observation": local_descriptor,
        "platform_option_supported": {
            "inspect": inspect_platform_supported == "true",
            "pull": pull_platform_supported == "true",
            "run": run_platform_supported == "true",
        },
        "repository_versions": {
            "publisher": int(publisher_repo_version),
            "replica1": int(replica1_repo_version),
            "replica2": int(replica2_repo_version),
        },
        "requested_platform": requested_platform,
        "verified_repo_digest": verified_repo_digest,
        "version": kubo_version,
    },
    "limitations": [
        "IPNS publication and signed record validation were not exercised",
        "publishing-key transfer was not exercised",
        "containers emulate isolated nodes on one Docker host",
    ],
    "profile": {
        "name": profile,
        "required_fields_verified_per_role": True,
        "required_import": required_import,
    },
    "provenance": {
        "docker": {
            "client": {
                "api_version": docker_client_api,
                "architecture": docker_client_arch,
                "os": docker_client_os,
                "version": docker_client_version,
            },
            "server": {
                "api_version": docker_server_api,
                "architecture": docker_server_arch,
                "kernel_version": docker_server_kernel,
                "os": docker_server_os,
                "storage_driver": docker_storage_driver,
                "version": docker_server_version,
            },
        },
        "inputs": {
            "manifest_sha256": manifest_sha256,
            "run_lab_sha256": script_sha256,
        },
        "runner": {
            "kernel": {
                "machine": runner_kernel_machine,
                "release": runner_kernel_release,
                "sysname": runner_kernel_sysname,
            },
            "os": {
                "id": runner_os_id,
                "version_id": runner_os_version,
            },
        },
        "tools": {
            "bash": bash_version,
            "coreutils": coreutils_version,
            "python": python_version,
        },
    },
    "result": "pass",
    "v1": {
        "independent_import_match": True,
        "offline_replicas_verified": 2,
        "reachable_blocks": int(v1_blocks),
        "repeat_import_match": True,
        "root_cid": v1,
    },
    "v2": {
        "independent_import_match": True,
        "offline_replicas_verified": 2,
        "reachable_blocks": int(v2_blocks),
        "root_cid": v2,
        "v1_retained": True,
    },
    "verified_on": datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
}

directory = os.path.dirname(os.path.abspath(path))
os.makedirs(directory, mode=0o700, exist_ok=True)
temporary_path = None
try:
    fd, temporary_path = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(path)}.",
        suffix=".tmp",
    )
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary_path, 0o644)
    os.replace(temporary_path, path)
    temporary_path = None

    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_fd = os.open(directory, directory_flags)
    try:
        try:
            os.fsync(directory_fd)
        except OSError as error:
            if error.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EROFS}:
                raise
    finally:
        os.close(directory_fd)
finally:
    if temporary_path is not None:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
PY
  printf 'Results: %s\n' "$WRITE_RESULTS_DISPLAY"
fi

printf 'Lab: PASS\n'
