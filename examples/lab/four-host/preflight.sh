#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
MANIFEST="$SCRIPT_DIR/manifest.json"

usage_error() { printf 'ERROR: invalid preflight arguments\n' >&2; exit 2; }
assertion_error() { printf 'ERROR: preflight assertion failed\n' >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || assertion_error; }
require_command python3

bounded_capture() {
  local variable_name=$1 limit=$2 seconds=$3 output status
  shift 3
  set +e
  output=$(python3 - "$limit" "$seconds" "$@" 2>/dev/null <<'PY'
import os,selectors,subprocess,sys,time
limit=int(sys.argv[1]); timeout=float(sys.argv[2]); command=sys.argv[3:]
if not command or limit<1 or timeout<=0: raise SystemExit(1)
process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True)
selector=selectors.DefaultSelector(); selector.register(process.stdout,selectors.EVENT_READ); data=bytearray(); deadline=time.monotonic()+timeout
try:
    while selector.get_map():
        remaining=deadline-time.monotonic()
        if remaining<=0: raise TimeoutError
        events=selector.select(remaining)
        if not events: raise TimeoutError
        for key,_ in events:
            chunk=os.read(key.fd,min(65536,limit+1-len(data)))
            if not chunk: selector.unregister(key.fileobj); continue
            data.extend(chunk)
            if len(data)>limit: raise OverflowError
    remaining=deadline-time.monotonic()
    if remaining<=0: raise TimeoutError
    status=process.wait(timeout=remaining)
    if status!=0: raise RuntimeError
except Exception:
    process.kill()
    try: process.wait(timeout=1)
    except Exception: pass
    raise SystemExit(1)
sys.stdout.buffer.write(data)
PY
)
  status=$?
  set -e
  [[ $status -eq 0 ]] || assertion_error
  printf -v "$variable_name" '%s' "$output"
}

validate_local_docker_endpoint() {
  local endpoint context_name context_json endpoint_status
  [[ -z "${DOCKER_API_VERSION:-}" ]] || assertion_error
  [[ -z "${DOCKER_HOST:-}" || -z "${DOCKER_CONTEXT:-}" ]] || assertion_error
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    endpoint=$DOCKER_HOST
  else
    if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
      context_name=$DOCKER_CONTEXT
    else
      bounded_capture context_name 8192 10 docker context show
    fi
    [[ "$context_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || assertion_error
    bounded_capture context_json 8192 10 docker context inspect "$context_name" --format '{{json .Endpoints.docker.Host}}'
    set +e
    endpoint=$(python3 - "$context_json" 2>/dev/null <<'PY'
import json,sys
value=json.loads(sys.argv[1])
if not isinstance(value,str): raise SystemExit(1)
print(value)
PY
)
    endpoint_status=$?
    set -e
    [[ $endpoint_status -eq 0 ]] || assertion_error
  fi
  python3 - "$endpoint" 2>/dev/null <<'PY' >/dev/null || assertion_error
import os,stat,sys
endpoint=sys.argv[1]
if not endpoint.startswith("unix://"): raise SystemExit(1)
path=endpoint[7:]
if not path.startswith("/") or path=="/" or os.path.normpath(path)!=path or endpoint!="unix://"+path: raise SystemExit(1)
meta=os.lstat(path)
if stat.S_ISLNK(meta.st_mode) or not stat.S_ISSOCK(meta.st_mode): raise SystemExit(1)
PY
}

python3 - "$@" 2>/dev/null <<'PY' >/dev/null || usage_error
import sys
if any(any(ord(char)<32 or ord(char)==127 for char in value) for value in sys.argv[1:]): raise SystemExit(1)
PY

declare -A SEEN=()
ROLE=""; CONTAINER=""; REPO=""; SWARM_BIND=""; ANNOUNCE=""; REQUESTED_UID=""; REQUESTED_GID=""; ENVIRONMENT_ID=""
NETWORK_ATTESTED=false
while (($#)); do
  option=$1
  case "$option" in
    --network-attested)
      [[ -z "${SEEN[$option]:-}" ]] || usage_error
      SEEN[$option]=true; NETWORK_ATTESTED=true; shift
      ;;
    --role|--container|--repo|--swarm-bind|--announce|--uid|--gid|--environment-id)
      [[ -z "${SEEN[$option]:-}" && $# -ge 2 && "$2" != --* ]] || usage_error
      SEEN[$option]=true; value=$2; shift 2
      case "$option" in
        --role) ROLE=$value ;;
        --container) CONTAINER=$value ;;
        --repo) REPO=$value ;;
        --swarm-bind) SWARM_BIND=$value ;;
        --announce) ANNOUNCE=$value ;;
        --uid) REQUESTED_UID=$value ;;
        --gid) REQUESTED_GID=$value ;;
        --environment-id) ENVIRONMENT_ID=$value ;;
      esac
      ;;
    *) usage_error ;;
  esac
done
[[ -n "$ROLE" && -n "$CONTAINER" && -n "$REPO" && -n "$SWARM_BIND" && -n "$ANNOUNCE" && -n "$REQUESTED_UID" && -n "$REQUESTED_GID" && -n "$ENVIRONMENT_ID" && "$NETWORK_ATTESTED" == true ]] || usage_error

python3 - "$ROLE" "$CONTAINER" "$REPO" "$SWARM_BIND" "$ANNOUNCE" "$REQUESTED_UID" "$REQUESTED_GID" "$ENVIRONMENT_ID" 2>/dev/null <<'PY' >/dev/null || usage_error
import ipaddress,os,re,sys
role,container,repo,swarm_bind,announce,uid,gid,environment_id=sys.argv[1:]
if role not in {"publisher-a","publisher-b","replica1","replica2"}: raise SystemExit(1)
if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}",container) is None: raise SystemExit(1)
if not repo.startswith("/") or repo=="/" or os.path.normpath(repo)!=repo or len(repo)>4096: raise SystemExit(1)
if re.fullmatch(r"env-[0-9a-f]{32}",environment_id) is None: raise SystemExit(1)
if re.fullmatch(r"[0-9]+",uid) is None or not 1<=int(uid)<=2_147_483_647: raise SystemExit(1)
if re.fullmatch(r"[0-9]+",gid) is None or not 0<=int(gid)<=2_147_483_647: raise SystemExit(1)
def endpoint(value):
    if value.count(":")!=1: raise SystemExit(1)
    address,port_raw=value.rsplit(":",1)
    try: parsed=ipaddress.ip_address(address)
    except ValueError: raise SystemExit(1)
    if parsed.version!=4 or parsed.is_unspecified or parsed.is_loopback or parsed.is_multicast or parsed.is_link_local: raise SystemExit(1)
    if re.fullmatch(r"[0-9]+",port_raw) is None or int(port_raw)!=4001: raise SystemExit(1)
    return f"{parsed}:4001"
if endpoint(swarm_bind)!=endpoint(announce) or swarm_bind!=announce: raise SystemExit(1)
PY

for required_command in docker uname; do require_command "$required_command"; done

set +e
MANIFEST_META=$(python3 - "$MANIFEST" 2>/dev/null <<'PY'
import hashlib,json,os,pathlib,re,stat,sys
path=pathlib.Path(sys.argv[1]); limit=65536
def safe_file(candidate,expected_hash=None):
    raw_path=str(candidate)
    if not raw_path.startswith("/") or os.path.normpath(raw_path)!=raw_path: raise SystemExit(1)
    current="/"
    for component in raw_path.strip("/").split("/"):
        current=os.path.join(current,component); meta=os.lstat(current)
        if stat.S_ISLNK(meta.st_mode): raise SystemExit(1)
    flags=os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)
    fd=os.open(raw_path,flags)
    with os.fdopen(fd,"rb") as handle:
        meta=os.fstat(handle.fileno())
        if not stat.S_ISREG(meta.st_mode) or not 0<meta.st_size<=limit: raise SystemExit(1)
        data=handle.read(limit+1)
    if len(data)!=meta.st_size or (expected_hash and hashlib.sha256(data).hexdigest()!=expected_hash): raise SystemExit(1)
    return data
kit=json.loads(safe_file(path).decode())
expected_keys={"format","references","platform","kubo","container_contract","roles","ports","phases","timeouts_seconds","limits_bytes","expectations"}
if set(kit)!=expected_keys or kit["format"]!="meshkeep-four-host-kubo-kit-v1": raise SystemExit(1)
references=kit["references"]
expected_refs={"immutable_manifest":{"path":"../manifest.json","sha256":"09c9b23033fd4df6197abec7d2e86f4edb8f59a51fd886d4ef331c2a0c6436f3"},"ipns_manifest":{"path":"../ipns-manifest.json","sha256":"377bd94a6b03e7fa724ad9abffd06ff2b91116d632467b44bfe13bcb6e3f850a"}}
if references!=expected_refs: raise SystemExit(1)
base_path=pathlib.Path(os.path.normpath(str(path.parent/references["immutable_manifest"]["path"]))); ipns_path=pathlib.Path(os.path.normpath(str(path.parent/references["ipns_manifest"]["path"])))
if str(base_path)!=str(path.parent.parent/"manifest.json") or str(ipns_path)!=str(path.parent.parent/"ipns-manifest.json"): raise SystemExit(1)
base=json.loads(safe_file(base_path,references["immutable_manifest"]["sha256"]).decode()); ipns=json.loads(safe_file(ipns_path,references["ipns_manifest"]["sha256"]).decode())
required_import={"CidVersion":1,"HashFunction":"sha2-256","UnixFSChunker":"size-1048576","UnixFSDAGLayout":"balanced","UnixFSDirectoryMaxLinks":0,"UnixFSFileMaxLinks":1024,"UnixFSHAMTDirectoryMaxFanout":256,"UnixFSHAMTDirectorySizeEstimation":"block","UnixFSHAMTDirectorySizeThreshold":"256KiB","UnixFSRawLeaves":True}
if set(base)!={"format","kubo","profile","fixtures"} or base.get("format")!="meshkeep-immutable-cid-lab-v2" or base.get("profile")!={"name":"unixfs-v1-2025","import":required_import}: raise SystemExit(1)
if set(base.get("kubo",{}))!={"version","repo_version","image","index_digest","requested_platform"}: raise SystemExit(1)
if set(base.get("fixtures",{}))!={"v1","v2"}: raise SystemExit(1)
for version in ("v1","v2"):
    item=base["fixtures"][version]
    if set(item)!={"root_cid","files"} or re.fullmatch(r"b[a-z2-7]{20,}",item["root_cid"]) is None or not isinstance(item["files"],dict) or len(item["files"])!=4: raise SystemExit(1)
    for relative,digest in item["files"].items():
        if not isinstance(relative,str) or relative.startswith("/") or ".." in relative.split("/") or re.fullmatch(r"[A-Za-z0-9._/-]+",relative) is None or re.fullmatch(r"[0-9a-f]{64}",digest) is None: raise SystemExit(1)
expected_ipns={"format":"meshkeep-ipns-key-transfer-lab-v1","immutable_manifest":"manifest.json","network":{"dht_record_count":4,"dht_timeout":"20s","http_request_timeout_seconds":10,"resolve_attempts":8,"resolve_retry_delay_seconds":2},"ipns":{"key_name":"meshkeep-publisher","key_type":"ed25519","lifetime":"10m","ttl":"1s","eol_bracket_tolerance_seconds":2,"v1_sequence":0,"v2_sequence":1},"expectations":{"reachable_blocks_per_version":8,"replicas":2,"publishers":2}}
if ipns!=expected_ipns: raise SystemExit(1)
kubo=kit["kubo"]; base_kubo=base["kubo"]
if kubo!={"image":base_kubo["image"],"index_digest":base_kubo["index_digest"],"repository_version":base_kubo["repo_version"],"requested_platform":base_kubo["requested_platform"],"version":base_kubo["version"]}: raise SystemExit(1)
platform=kit["platform"]
if platform!={"architecture":"amd64","docker_minimum_version":"28.0.0","endpoint_mode":"direct-non-nat","network_family":"ipv4","operating_system":"linux","pnet_required":True,"transport":"tcp"}: raise SystemExit(1)
if kit["roles"]!=["publisher-a","publisher-b","replica1","replica2"]: raise SystemExit(1)
if kit["ports"]!={"container":{"api_tcp":5001,"gateway_tcp":8080,"swarm_tcp":4001},"host":{"publishers":{"api":"unpublished","gateway":"unpublished","swarm_tcp":4001},"replicas":{"api":"unpublished","gateway_bind":"loopback","gateway_tcp":8080,"swarm_tcp":4001}}}: raise SystemExit(1)
contract=kit["container_contract"]
if contract!={"cap_drop":["ALL"],"cmd":["daemon"],"entrypoint":["ipfs"],"memory_bytes":402653184,"nano_cpus":500000000,"network_mode":"bridge","no_new_privileges":True,"pids_limit":256,"privileged":False,"publish_all_ports":False,"readonly_rootfs":True,"repository_destination":"/data/ipfs","restart_policy":{"maximum_retry_count":0,"name":"no"},"stop_timeout_seconds":10,"tmpfs":{"destination":"/tmp","options":["rw","nosuid","nodev","noexec","size=32m"]}}: raise SystemExit(1)
expected_phases={"initial":({"publisher-a","publisher-b","replica1","replica2"},set(),3),"publisher-a-offline-v1":({"publisher-b","replica1","replica2"},{"publisher-a"},2),"publisher-b-active-v2":({"publisher-b","replica1","replica2"},{"publisher-a"},2),"publishers-offline-v2":({"replica1","replica2"},{"publisher-a","publisher-b"},1),"cleanup":(set(),set(),0)}
if set(kit["phases"])!=set(expected_phases): raise SystemExit(1)
for name,(active,stopped,count) in expected_phases.items():
    item=kit["phases"][name]
    if set(item)!={"active_roles","stopped_roles","expected_peer_count_per_active_role"} or set(item["active_roles"])!=active or set(item["stopped_roles"])!=stopped or item["expected_peer_count_per_active_role"]!=count: raise SystemExit(1)
timeouts=kit["timeouts_seconds"]; limits=kit["limits_bytes"]
if timeouts!={"command":30,"gateway":20,"outer":40,"pin":90,"transport_probe":10}: raise SystemExit(1)
expected_limits={"api_body":262144,"client_config_output":8192,"container_inspect":262144,"diagnostic":8192,"docker_version":8192,"evidence":65536,"expected_peer_file":16384,"gateway_body":1048576,"image_inspect":131072,"ipns_inspect":262144,"kubo_output":262144,"manifest":65536,"port_output":8192}
if limits!=expected_limits or kit["expectations"]!={"directed_swarm_dials":12,"reachable_blocks_per_version":8,"replicas":2,"roles":4}: raise SystemExit(1)
for value in (kubo["image"],kubo["index_digest"],kubo["version"],str(kubo["repository_version"]),platform["docker_minimum_version"],str(timeouts["command"]),str(limits["docker_version"]),str(limits["image_inspect"])): print(value)
PY
)
MANIFEST_STATUS=$?
set -e
[[ $MANIFEST_STATUS -eq 0 ]] || assertion_error
mapfile -t META <<< "$MANIFEST_META"
[[ ${#META[@]} -eq 8 ]] || assertion_error
IMAGE=${META[0]}; INDEX_DIGEST=${META[1]}; KUBO_VERSION=${META[2]}; REPOSITORY_VERSION=${META[3]}; DOCKER_MINIMUM=${META[4]}; COMMAND_TIMEOUT=${META[5]}; DOCKER_VERSION_LIMIT=${META[6]}; IMAGE_INSPECT_LIMIT=${META[7]}

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || assertion_error

python3 - "$REPO" "$REQUESTED_UID" "$REQUESTED_GID" "$REPOSITORY_VERSION" 2>/dev/null <<'PY' >/dev/null || assertion_error
import os,stat,sys
repo,uid_raw,gid_raw,version_raw=sys.argv[1:]; uid=int(uid_raw); gid=int(gid_raw); expected_version=int(version_raw); current="/"
for component in repo.strip("/").split("/"):
    current=os.path.join(current,component); meta=os.lstat(current)
    if stat.S_ISLNK(meta.st_mode): raise SystemExit(1)
meta=os.lstat(repo)
if not stat.S_ISDIR(meta.st_mode) or meta.st_uid!=uid or meta.st_gid!=gid or stat.S_IMODE(meta.st_mode)!=0o700: raise SystemExit(1)
version_path=os.path.join(repo,"version"); version_meta=os.lstat(version_path)
if not stat.S_ISREG(version_meta.st_mode) or stat.S_ISLNK(version_meta.st_mode) or version_meta.st_size>32: raise SystemExit(1)
with open(version_path,"rb") as handle: version_bytes=handle.read(33)
if version_bytes not in {str(expected_version).encode(),str(expected_version).encode()+b"\n"}: raise SystemExit(1)
key_meta=os.lstat(os.path.join(repo,"swarm.key"))
if not stat.S_ISREG(key_meta.st_mode) or stat.S_ISLNK(key_meta.st_mode) or stat.S_IMODE(key_meta.st_mode)!=0o600 or key_meta.st_uid!=uid or key_meta.st_gid!=gid: raise SystemExit(1)
PY

validate_local_docker_endpoint
bounded_capture DOCKER_META "$DOCKER_VERSION_LIMIT" "$COMMAND_TIMEOUT" docker version --format '{{println .Client.Version}}{{println .Client.Os}}{{println .Client.Arch}}{{println .Server.Version}}{{println .Server.Os}}{{.Server.Arch}}'
set +e
DOCKER_VERSION_LINES=$(python3 - "$DOCKER_MINIMUM" "$DOCKER_META" 2>/dev/null <<'PY'
import re,sys
minimum=tuple(map(int,sys.argv[1].split("."))); lines=sys.argv[2].splitlines()
if len(lines)!=6: raise SystemExit(1)
def stable(value):
    match=re.fullmatch(r"([0-9]+)\.([0-9]+)\.([0-9]+)(?:\+[0-9A-Za-z.-]+)?",value)
    if match is None: raise SystemExit(1)
    return tuple(map(int,match.groups()))
if stable(lines[0])<minimum or stable(lines[3])<minimum or tuple(lines[1:3]+lines[4:6])!=("linux","amd64","linux","amd64"): raise SystemExit(1)
print(lines[0]); print(lines[3])
PY
)
VERSION_STATUS=$?
set -e
[[ $VERSION_STATUS -eq 0 ]] || assertion_error
mapfile -t OBSERVED_DOCKER_VERSIONS <<< "$DOCKER_VERSION_LINES"
[[ ${#OBSERVED_DOCKER_VERSIONS[@]} -eq 2 ]] || assertion_error

bounded_capture IMAGE_JSON "$IMAGE_INSPECT_LIMIT" "$COMMAND_TIMEOUT" docker image inspect --platform linux/amd64 "$IMAGE"
python3 - "$IMAGE" "$INDEX_DIGEST" "$IMAGE_JSON" 2>/dev/null <<'PY' >/dev/null || assertion_error
import json,re,sys
image,digest,raw=sys.argv[1:]; records=json.loads(raw)
if not isinstance(records,list) or len(records)!=1: raise SystemExit(1)
record=records[0]; repo_digests=record.get("RepoDigests")
if record.get("Os")!="linux" or record.get("Architecture")!="amd64" or re.fullmatch(r"sha256:[0-9a-f]{64}",record.get("Id","")) is None: raise SystemExit(1)
if not isinstance(repo_digests,list) or image not in repo_digests or image.rsplit("@",1)[-1]!=digest: raise SystemExit(1)
PY

python3 - "$ENVIRONMENT_ID" "$ROLE" "${OBSERVED_DOCKER_VERSIONS[0]}" "${OBSERVED_DOCKER_VERSIONS[1]}" "$KUBO_VERSION" "$REPOSITORY_VERSION" <<'PY'
import json,sys
environment_id,role,docker_client,docker_server,kubo,repository=sys.argv[1:]
data={"checks":{"direct_non_nat_endpoint":True,"image_digest_and_platform":True,"local_unix_docker_endpoint":True,"network_attested":True,"owner_only_repository":True,"pnet_metadata":True,"swarm_key_bytes_accessed":False},"environment_id":environment_id,"format":"meshkeep-four-host-preflight-v1","result":"pass","role":role,"versions":{"docker_client":docker_client,"docker_server":docker_server,"kubo":kubo,"repository":int(repository)}}
print(json.dumps(data,sort_keys=True,separators=(",",":")))
PY
