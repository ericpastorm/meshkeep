#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077

usage_error() { printf 'ERROR: invalid role-verification arguments\n' >&2; exit 2; }
assertion_error() { printf 'ERROR: role verification failed\n' >&2; exit 1; }
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
    if process.wait(timeout=remaining)!=0: raise RuntimeError
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

bounded_status_capture() {
  local variable_name=$1 expected_status=$2 limit=$3 seconds=$4 output status
  shift 4
  set +e
  output=$(python3 - "$expected_status" "$limit" "$seconds" "$@" 2>/dev/null <<'PY'
import os,selectors,subprocess,sys,time
expected=int(sys.argv[1]); limit=int(sys.argv[2]); timeout=float(sys.argv[3]); command=sys.argv[4:]
process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,close_fds=True)
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
    if remaining<=0 or process.wait(timeout=remaining)!=expected: raise RuntimeError
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
    if [[ -n "${DOCKER_CONTEXT:-}" ]]; then context_name=$DOCKER_CONTEXT; else bounded_capture context_name "$CLIENT_CONFIG_LIMIT" 10 docker context show; fi
    [[ "$context_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || assertion_error
    bounded_capture context_json "$CLIENT_CONFIG_LIMIT" 10 docker context inspect "$context_name" --format '{{json .Endpoints.docker.Host}}'
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

declare -A SEEN=() KIT_META=()
ROLE=""; PHASE=""; CONTAINER=""; MANIFEST=""; EXPECTED_PEERS=""; ENVIRONMENT_ID=""; RUN_ID=""; IPNS_NAME=""; EVIDENCE_DIR=""
PUBLISHER_A_OFFLINE_ATTESTED=false; PUBLISHER_B_OFFLINE_ATTESTED=false
while (($#)); do
  option=$1
  case "$option" in
    --publisher-a-offline-attested|--publisher-b-offline-attested)
      [[ -z "${SEEN[$option]:-}" ]] || usage_error
      SEEN[$option]=true
      if [[ "$option" == --publisher-a-offline-attested ]]; then PUBLISHER_A_OFFLINE_ATTESTED=true; else PUBLISHER_B_OFFLINE_ATTESTED=true; fi
      shift
      ;;
    --role|--phase|--container|--manifest|--expected-peers|--environment-id|--run-id|--ipns-name|--evidence-dir)
      [[ -z "${SEEN[$option]:-}" && $# -ge 2 && "$2" != --* ]] || usage_error
      SEEN[$option]=true; value=$2; shift 2
      case "$option" in
        --role) ROLE=$value ;;
        --phase) PHASE=$value ;;
        --container) CONTAINER=$value ;;
        --manifest) MANIFEST=$value ;;
        --expected-peers) EXPECTED_PEERS=$value ;;
        --environment-id) ENVIRONMENT_ID=$value ;;
        --run-id) RUN_ID=$value ;;
        --ipns-name) IPNS_NAME=$value ;;
        --evidence-dir) EVIDENCE_DIR=$value ;;
      esac
      ;;
    *) usage_error ;;
  esac
done
[[ -n "$ROLE" && -n "$PHASE" && -n "$CONTAINER" && -n "$MANIFEST" && -n "$EXPECTED_PEERS" && -n "$ENVIRONMENT_ID" && -n "$RUN_ID" ]] || usage_error

python3 - "$ROLE" "$PHASE" "$CONTAINER" "$MANIFEST" "$EXPECTED_PEERS" "$ENVIRONMENT_ID" "$RUN_ID" "$IPNS_NAME" "$EVIDENCE_DIR" "$PUBLISHER_A_OFFLINE_ATTESTED" "$PUBLISHER_B_OFFLINE_ATTESTED" 2>/dev/null <<'PY' >/dev/null || usage_error
import os,re,sys
role,phase,container,manifest,peers,environment_id,run_id,ipns_name,evidence_dir,a_offline,b_offline=sys.argv[1:]
if role not in {"publisher-a","publisher-b","replica1","replica2"} or phase not in {"initial","publisher-a-offline-v1","publisher-b-active-v2","publishers-offline-v2","cleanup"}: raise SystemExit(1)
if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}",container) is None: raise SystemExit(1)
for path in (manifest,peers):
    if not path.startswith("/") or path=="/" or os.path.normpath(path)!=path or len(path)>4096: raise SystemExit(1)
if evidence_dir and (not evidence_dir.startswith("/") or evidence_dir=="/" or os.path.normpath(evidence_dir)!=evidence_dir or len(evidence_dir)>4096 or phase=="cleanup"): raise SystemExit(1)
if re.fullmatch(r"env-[0-9a-f]{32}",environment_id) is None or re.fullmatch(r"run-[0-9a-f]{32}",run_id) is None: raise SystemExit(1)
if phase in {"initial","cleanup"}:
    if ipns_name: raise SystemExit(1)
elif re.fullmatch(r"k[0-9a-z]{20,}",ipns_name) is None: raise SystemExit(1)
expected={"initial":("false","false"),"publisher-a-offline-v1":("true","false"),"publisher-b-active-v2":("true","false"),"publishers-offline-v2":("true","true"),"cleanup":("false","false")}
if (a_offline,b_offline)!=expected[phase]: raise SystemExit(1)
PY

for required_command in docker sha256sum timeout; do require_command "$required_command"; done

set +e
META_OUTPUT=$(python3 - "$MANIFEST" 2>/dev/null <<'PY'
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
if set(kit)!={"format","references","platform","kubo","container_contract","roles","ports","phases","timeouts_seconds","limits_bytes","expectations"} or kit.get("format")!="meshkeep-four-host-kubo-kit-v1": raise SystemExit(1)
refs=kit["references"]; expected_refs={"immutable_manifest":{"path":"../manifest.json","sha256":"09c9b23033fd4df6197abec7d2e86f4edb8f59a51fd886d4ef331c2a0c6436f3"},"ipns_manifest":{"path":"../ipns-manifest.json","sha256":"377bd94a6b03e7fa724ad9abffd06ff2b91116d632467b44bfe13bcb6e3f850a"}}
if refs!=expected_refs: raise SystemExit(1)
base_path=pathlib.Path(os.path.normpath(str(path.parent/refs["immutable_manifest"]["path"]))); ipns_path=pathlib.Path(os.path.normpath(str(path.parent/refs["ipns_manifest"]["path"])))
if str(base_path)!=str(path.parent.parent/"manifest.json") or str(ipns_path)!=str(path.parent.parent/"ipns-manifest.json"): raise SystemExit(1)
base=json.loads(safe_file(base_path,refs["immutable_manifest"]["sha256"]).decode()); ipns=json.loads(safe_file(ipns_path,refs["ipns_manifest"]["sha256"]).decode())
required_import={"CidVersion":1,"HashFunction":"sha2-256","UnixFSChunker":"size-1048576","UnixFSDAGLayout":"balanced","UnixFSDirectoryMaxLinks":0,"UnixFSFileMaxLinks":1024,"UnixFSHAMTDirectoryMaxFanout":256,"UnixFSHAMTDirectorySizeEstimation":"block","UnixFSHAMTDirectorySizeThreshold":"256KiB","UnixFSRawLeaves":True}
if set(base)!={"format","kubo","profile","fixtures"} or base.get("format")!="meshkeep-immutable-cid-lab-v2" or base.get("profile")!={"name":"unixfs-v1-2025","import":required_import}: raise SystemExit(1)
if set(base.get("kubo",{}))!={"version","repo_version","image","index_digest","requested_platform"}: raise SystemExit(1)
if set(base.get("fixtures",{}))!={"v1","v2"}: raise SystemExit(1)
for version in ("v1","v2"):
    item=base["fixtures"][version]
    if set(item)!={"root_cid","files"} or re.fullmatch(r"b[a-z2-7]{20,}",item["root_cid"]) is None or not isinstance(item["files"],dict) or len(item["files"])!=4: raise SystemExit(1)
    for relative,digest in item["files"].items():
        if relative.startswith("/") or ".." in relative.split("/") or re.fullmatch(r"[A-Za-z0-9._/-]+",relative) is None or re.fullmatch(r"[0-9a-f]{64}",digest) is None: raise SystemExit(1)
expected_ipns={"format":"meshkeep-ipns-key-transfer-lab-v1","immutable_manifest":"manifest.json","network":{"dht_record_count":4,"dht_timeout":"20s","http_request_timeout_seconds":10,"resolve_attempts":8,"resolve_retry_delay_seconds":2},"ipns":{"key_name":"meshkeep-publisher","key_type":"ed25519","lifetime":"10m","ttl":"1s","eol_bracket_tolerance_seconds":2,"v1_sequence":0,"v2_sequence":1},"expectations":{"reachable_blocks_per_version":8,"replicas":2,"publishers":2}}
if ipns!=expected_ipns: raise SystemExit(1)
kubo=kit["kubo"]
if kubo!={"image":base["kubo"]["image"],"index_digest":base["kubo"]["index_digest"],"repository_version":base["kubo"]["repo_version"],"requested_platform":base["kubo"]["requested_platform"],"version":base["kubo"]["version"]}: raise SystemExit(1)
if kit["platform"]!={"architecture":"amd64","docker_minimum_version":"28.0.0","endpoint_mode":"direct-non-nat","network_family":"ipv4","operating_system":"linux","pnet_required":True,"transport":"tcp"}: raise SystemExit(1)
if kit["roles"]!=["publisher-a","publisher-b","replica1","replica2"] or kit["ports"]!={"container":{"api_tcp":5001,"gateway_tcp":8080,"swarm_tcp":4001},"host":{"publishers":{"api":"unpublished","gateway":"unpublished","swarm_tcp":4001},"replicas":{"api":"unpublished","gateway_bind":"loopback","gateway_tcp":8080,"swarm_tcp":4001}}}: raise SystemExit(1)
contract=kit["container_contract"]
if contract!={"cap_drop":["ALL"],"cmd":["daemon"],"entrypoint":["ipfs"],"memory_bytes":402653184,"nano_cpus":500000000,"network_mode":"bridge","no_new_privileges":True,"pids_limit":256,"privileged":False,"publish_all_ports":False,"readonly_rootfs":True,"repository_destination":"/data/ipfs","restart_policy":{"maximum_retry_count":0,"name":"no"},"stop_timeout_seconds":10,"tmpfs":{"destination":"/tmp","options":["rw","nosuid","nodev","noexec","size=32m"]}}: raise SystemExit(1)
expected_phases={"initial":[["publisher-a","publisher-b","replica1","replica2"],[],3],"publisher-a-offline-v1":[["publisher-b","replica1","replica2"],["publisher-a"],2],"publisher-b-active-v2":[["publisher-b","replica1","replica2"],["publisher-a"],2],"publishers-offline-v2":[["replica1","replica2"],["publisher-a","publisher-b"],1],"cleanup":[[],[],0]}
if set(kit["phases"])!=set(expected_phases): raise SystemExit(1)
for name,(active,stopped,count) in expected_phases.items():
    if kit["phases"][name]!={"active_roles":active,"expected_peer_count_per_active_role":count,"stopped_roles":stopped}: raise SystemExit(1)
timeouts=kit["timeouts_seconds"]; limits=kit["limits_bytes"]
if timeouts!={"command":30,"gateway":20,"outer":40,"pin":90,"transport_probe":10}: raise SystemExit(1)
expected_limits={"api_body":262144,"client_config_output":8192,"container_inspect":262144,"diagnostic":8192,"docker_version":8192,"evidence":65536,"expected_peer_file":16384,"gateway_body":1048576,"image_inspect":131072,"ipns_inspect":262144,"kubo_output":262144,"manifest":65536,"port_output":8192}
if limits!=expected_limits or kit["expectations"]!={"directed_swarm_dials":12,"reachable_blocks_per_version":8,"replicas":2,"roles":4}: raise SystemExit(1)
values={"IMAGE":kubo["image"],"DIGEST":kubo["index_digest"],"KUBO":kubo["version"],"REPO_VERSION":str(kubo["repository_version"]),"DOCKER_MIN":kit["platform"]["docker_minimum_version"],"SWARM_PORT":"4001","API_PORT":"5001","GATEWAY_PORT":"8080","COMMAND_TIMEOUT":"30","GATEWAY_TIMEOUT":"20","OUTER_TIMEOUT":"40","PIN_TIMEOUT":"90","TRANSPORT_TIMEOUT":"10","API_LIMIT":str(limits["api_body"]),"CLIENT_LIMIT":str(limits["client_config_output"]),"CONTAINER_LIMIT":str(limits["container_inspect"]),"DIAGNOSTIC_LIMIT":str(limits["diagnostic"]),"DOCKER_VERSION_LIMIT":str(limits["docker_version"]),"EVIDENCE_LIMIT":str(limits["evidence"]),"GATEWAY_LIMIT":str(limits["gateway_body"]),"IMAGE_LIMIT":str(limits["image_inspect"]),"IPNS_LIMIT":str(limits["ipns_inspect"]),"KUBO_LIMIT":str(limits["kubo_output"]),"PORT_LIMIT":str(limits["port_output"]),"PEER_LIMIT":str(limits["expected_peer_file"]),"BLOCKS":"8","V1":base["fixtures"]["v1"]["root_cid"],"V2":base["fixtures"]["v2"]["root_cid"],"V1_SEQUENCE":"0","V2_SEQUENCE":"1","DHT_COUNT":"4","DHT_TIMEOUT":"20s","BASE_PATH":str(base_path),"IPNS_PATH":str(ipns_path)}
for key,value in values.items(): print("META",key,value,sep="\t")
for version in ("v1","v2"):
    for relative,digest in sorted(base["fixtures"][version]["files"].items()): print("FIXTURE",version,relative,digest,sep="\t")
PY
)
META_STATUS=$?
set -e
[[ $META_STATUS -eq 0 ]] || assertion_error
FIXTURE_LINES=()
while IFS=$'\t' read -r kind key value extra; do
  if [[ "$kind" == META ]]; then KIT_META[$key]=$value; elif [[ "$kind" == FIXTURE ]]; then FIXTURE_LINES+=("$kind"$'\t'"$key"$'\t'"$value"$'\t'"$extra"); else assertion_error; fi
done <<< "$META_OUTPUT"
for required_meta in IMAGE DIGEST KUBO REPO_VERSION DOCKER_MIN SWARM_PORT API_PORT GATEWAY_PORT COMMAND_TIMEOUT GATEWAY_TIMEOUT OUTER_TIMEOUT PIN_TIMEOUT TRANSPORT_TIMEOUT API_LIMIT CLIENT_LIMIT CONTAINER_LIMIT DIAGNOSTIC_LIMIT DOCKER_VERSION_LIMIT EVIDENCE_LIMIT GATEWAY_LIMIT IMAGE_LIMIT IPNS_LIMIT KUBO_LIMIT PORT_LIMIT PEER_LIMIT BLOCKS V1 V2 V1_SEQUENCE V2_SEQUENCE DHT_COUNT DHT_TIMEOUT BASE_PATH IPNS_PATH; do [[ -n "${KIT_META[$required_meta]:-}" ]] || assertion_error; done
[[ ${#FIXTURE_LINES[@]} -eq 8 ]] || assertion_error

IMAGE=${KIT_META[IMAGE]}; INDEX_DIGEST=${KIT_META[DIGEST]}; KUBO_VERSION=${KIT_META[KUBO]}; REPOSITORY_VERSION=${KIT_META[REPO_VERSION]}; DOCKER_MINIMUM=${KIT_META[DOCKER_MIN]}
SWARM_PORT=${KIT_META[SWARM_PORT]}; API_PORT=${KIT_META[API_PORT]}; GATEWAY_PORT=${KIT_META[GATEWAY_PORT]}; COMMAND_TIMEOUT=${KIT_META[COMMAND_TIMEOUT]}; GATEWAY_TIMEOUT=${KIT_META[GATEWAY_TIMEOUT]}; OUTER_TIMEOUT=${KIT_META[OUTER_TIMEOUT]}; PIN_TIMEOUT=${KIT_META[PIN_TIMEOUT]}; TRANSPORT_TIMEOUT=${KIT_META[TRANSPORT_TIMEOUT]}
API_BODY_LIMIT=${KIT_META[API_LIMIT]}; CLIENT_CONFIG_LIMIT=${KIT_META[CLIENT_LIMIT]}; CONTAINER_INSPECT_LIMIT=${KIT_META[CONTAINER_LIMIT]}; DIAGNOSTIC_LIMIT=${KIT_META[DIAGNOSTIC_LIMIT]}; DOCKER_VERSION_LIMIT=${KIT_META[DOCKER_VERSION_LIMIT]}; EVIDENCE_LIMIT=${KIT_META[EVIDENCE_LIMIT]}; GATEWAY_BODY_LIMIT=${KIT_META[GATEWAY_LIMIT]}; IMAGE_INSPECT_LIMIT=${KIT_META[IMAGE_LIMIT]}; IPNS_INSPECT_LIMIT=${KIT_META[IPNS_LIMIT]}; KUBO_OUTPUT_LIMIT=${KIT_META[KUBO_LIMIT]}; PORT_OUTPUT_LIMIT=${KIT_META[PORT_LIMIT]}; PEER_FILE_LIMIT=${KIT_META[PEER_LIMIT]}; EXPECTED_BLOCKS=${KIT_META[BLOCKS]}
V1=${KIT_META[V1]}; V2=${KIT_META[V2]}; V1_SEQUENCE=${KIT_META[V1_SEQUENCE]}; V2_SEQUENCE=${KIT_META[V2_SEQUENCE]}; DHT_RECORD_COUNT=${KIT_META[DHT_COUNT]}; DHT_TIMEOUT=${KIT_META[DHT_TIMEOUT]}; BASE_MANIFEST_PATH=${KIT_META[BASE_PATH]}; IPNS_MANIFEST_PATH=${KIT_META[IPNS_PATH]}

set +e
PEER_META=$(python3 - "$EXPECTED_PEERS" "$PEER_FILE_LIMIT" "$ROLE" "$PHASE" "$SWARM_PORT" 2>/dev/null <<'PY'
import ipaddress,json,os,re,stat,sys
path=sys.argv[1]; limit=int(sys.argv[2]); role=sys.argv[3]; phase=sys.argv[4]; port=int(sys.argv[5])
if not path.startswith("/") or os.path.normpath(path)!=path: raise SystemExit(1)
current="/"
for component in path.strip("/").split("/"):
    current=os.path.join(current,component); meta=os.lstat(current)
    if stat.S_ISLNK(meta.st_mode): raise SystemExit(1)
parent=os.path.dirname(path); parent_meta=os.lstat(parent)
if not stat.S_ISDIR(parent_meta.st_mode) or parent_meta.st_uid!=os.geteuid() or stat.S_IMODE(parent_meta.st_mode)!=0o700: raise SystemExit(1)
flags=os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)
fd=os.open(path,flags)
with os.fdopen(fd,"rb") as handle:
    meta=os.fstat(handle.fileno())
    if not stat.S_ISREG(meta.st_mode) or stat.S_IMODE(meta.st_mode)!=0o600 or meta.st_uid!=os.geteuid() or not 0<meta.st_size<=limit: raise SystemExit(1)
    data=handle.read(limit+1)
if len(data)!=meta.st_size: raise SystemExit(1)
sheet=json.loads(data.decode("utf-8"))
if set(sheet)!={"format","peers"} or sheet["format"]!="meshkeep-four-host-peer-sheet-v1" or not isinstance(sheet["peers"],list) or len(sheet["peers"])!=4: raise SystemExit(1)
roles=["publisher-a","publisher-b","replica1","replica2"]; records={}; ids=set(); endpoints=set()
for item in sheet["peers"]:
    if not isinstance(item,dict) or set(item)!={"role","peer_id","dial_addr"}: raise SystemExit(1)
    item_role=item["role"]; peer=item["peer_id"]; address=item["dial_addr"]
    if item_role not in roles or item_role in records or not isinstance(peer,str) or re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{20,100}",peer) is None or peer in ids: raise SystemExit(1)
    match=re.fullmatch(r"/ip4/([^/]+)/tcp/([0-9]+)/p2p/([^/]+)",address if isinstance(address,str) else "")
    if match is None or match.group(3)!=peer or int(match.group(2))!=port: raise SystemExit(1)
    parsed=ipaddress.ip_address(match.group(1))
    if parsed.version!=4 or parsed.is_unspecified or parsed.is_loopback or parsed.is_multicast or parsed.is_link_local: raise SystemExit(1)
    endpoint=(str(parsed),port)
    if endpoint in endpoints: raise SystemExit(1)
    records[item_role]=(peer,str(parsed)); ids.add(peer); endpoints.add(endpoint)
active={"initial":["publisher-a","publisher-b","replica1","replica2"],"publisher-a-offline-v1":["publisher-b","replica1","replica2"],"publisher-b-active-v2":["publisher-b","replica1","replica2"],"publishers-offline-v2":["replica1","replica2"],"cleanup":[]}[phase]
expected=[records[target][0] for target in active if target!=role]
print(records[role][0]); print(records[role][1]); print(len(expected))
for peer in expected: print(peer)
PY
)
PEER_STATUS=$?
set -e
[[ $PEER_STATUS -eq 0 ]] || assertion_error
mapfile -t PEER_LINES <<< "$PEER_META"
[[ ${#PEER_LINES[@]} -ge 3 ]] || assertion_error
OWN_PEER=${PEER_LINES[0]}; OWN_SWARM_IP=${PEER_LINES[1]}; EXPECTED_PEER_COUNT=${PEER_LINES[2]}; EXPECTED_PEER_IDS=("${PEER_LINES[@]:3}")
[[ ${#EXPECTED_PEER_IDS[@]} -eq $EXPECTED_PEER_COUNT ]] || assertion_error

EVIDENCE_DESTINATION=""
if [[ -n "$EVIDENCE_DIR" ]]; then
  set +e
  EVIDENCE_DESTINATION=$(python3 - "$EVIDENCE_DIR" "$RUN_ID" "$ROLE" "$PHASE" "$MANIFEST" "$EXPECTED_PEERS" "$BASE_MANIFEST_PATH" "$IPNS_MANIFEST_PATH" 2>/dev/null <<'PY'
import os,stat,sys
directory,run_id,role,phase,*inputs=sys.argv[1:]
current="/"
for component in directory.strip("/").split("/"):
    current=os.path.join(current,component); meta=os.lstat(current)
    if stat.S_ISLNK(meta.st_mode): raise SystemExit(1)
meta=os.lstat(directory)
if not stat.S_ISDIR(meta.st_mode) or meta.st_uid!=os.geteuid() or stat.S_IMODE(meta.st_mode)!=0o700: raise SystemExit(1)
def related(left,right):
    common=os.path.commonpath([left,right])
    return common==left or common==right
for value in inputs:
    if related(directory,value): raise SystemExit(1)
destination=os.path.join(directory,f"meshkeep-{run_id}-{role}-{phase}.json")
if destination in inputs or os.path.lexists(destination): raise SystemExit(1)
print(destination)
PY
)
  EVIDENCE_STATUS=$?
  set -e
  [[ $EVIDENCE_STATUS -eq 0 && -n "$EVIDENCE_DESTINATION" ]] || assertion_error
fi

validate_local_docker_endpoint
bounded_capture DOCKER_META "$DOCKER_VERSION_LIMIT" "$OUTER_TIMEOUT" docker version --format '{{println .Client.Version}}{{println .Client.Os}}{{println .Client.Arch}}{{println .Server.Version}}{{println .Server.Os}}{{.Server.Arch}}'
set +e
DOCKER_VERSIONS=$(python3 - "$DOCKER_MINIMUM" "$DOCKER_META" 2>/dev/null <<'PY'
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
DOCKER_VERSION_STATUS=$?
set -e
[[ $DOCKER_VERSION_STATUS -eq 0 ]] || assertion_error
mapfile -t OBSERVED_DOCKER_VERSIONS <<< "$DOCKER_VERSIONS"
[[ ${#OBSERVED_DOCKER_VERSIONS[@]} -eq 2 ]] || assertion_error

write_or_print_evidence() {
  local evidence_output writer_status
  set +e
  evidence_output=$(python3 - "$EVIDENCE_DIR" "$EVIDENCE_DESTINATION" "$EVIDENCE_LIMIT" "$ENVIRONMENT_ID" "$RUN_ID" "$ROLE" "$PHASE" "$IPNS_NAME" "$KUBO_VERSION" "$REPOSITORY_VERSION" "${OBSERVED_DOCKER_VERSIONS[0]}" "${OBSERVED_DOCKER_VERSIONS[1]}" "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" "${13}" "${14}" "${15}" 2>/dev/null <<'PY'
import errno,json,os,sys,tempfile
(directory,destination,limit_raw,environment_id,run_id,role,phase,ipns_name,kubo,repository,docker_client,docker_server,container_absent,running,config_checks,peer_count,api_positive,host_api_absent,pin_count,reachable_versions,fixture_hash_checks,ipns_valid,gateway_ipfs_checks,gateway_ipns_checks,a_offline,b_offline,pnet_metadata)=sys.argv[1:]
def boolean(value):
    if value not in {"true","false"}: raise SystemExit(1)
    return value=="true"
data={"environment_id":environment_id,"format":"meshkeep-four-host-role-evidence-v1","observations":{"api":{"container_loopback_positive":boolean(api_positive),"host_loopback_transport_absent":boolean(host_api_absent)},"config_keys_verified":int(config_checks),"container_absent":boolean(container_absent),"expected_peer_set_verified":int(peer_count),"fixture_hash_checks":int(fixture_hash_checks),"gateway":{"ipfs_http_200_hash_checks":int(gateway_ipfs_checks),"ipns_http_200_hash_checks":int(gateway_ipns_checks)},"ipns_record_valid":boolean(ipns_valid),"pins_verified":int(pin_count),"pnet_forced_and_key_metadata_verified":boolean(pnet_metadata),"publisher_offline_attestations":{"publisher_a":boolean(a_offline),"publisher_b":boolean(b_offline)},"reachable_versions_verified":int(reachable_versions),"running":boolean(running)},"phase":phase,"public_ipns_name":ipns_name or None,"result":"pass","role":role,"run_id":run_id,"versions":{"docker_client":docker_client,"docker_server":docker_server,"kubo":kubo,"repository":int(repository)},"limitations":["This object records one local role check only; operators must reconcile four independent environments and cross-host attestations manually.","A validated local Unix socket does not prove physical daemon locality.","Peer identities, addresses, filesystem paths, host identity, API bodies, raw records, full config, and key material are excluded."]}
encoded=(json.dumps(data,sort_keys=True,separators=(",",":"))+"\n").encode(); limit=int(limit_raw)
if len(encoded)>limit: raise SystemExit(1)
if destination:
    expected=os.path.join(directory,f"meshkeep-{run_id}-{role}-{phase}.json")
    if destination!=expected or os.path.lexists(destination): raise SystemExit(1)
    temporary=None; published=False
    try:
        fd,temporary=tempfile.mkstemp(dir=directory,prefix=".meshkeep-role-evidence.",suffix=".tmp")
        with os.fdopen(fd,"wb") as handle: handle.write(encoded); handle.flush(); os.fsync(handle.fileno())
        os.chmod(temporary,0o600)
        os.link(temporary,destination,follow_symlinks=False); published=True
        dfd=os.open(directory,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
        try:
            try: os.fsync(dfd)
            except OSError as error:
                if error.errno not in {errno.EINVAL,errno.ENOTSUP,errno.EROFS}: raise
        finally: os.close(dfd)
    except Exception:
        if published:
            try: os.unlink(destination)
            except FileNotFoundError: pass
        raise
    finally:
        if temporary is not None:
            try: os.unlink(temporary)
            except FileNotFoundError: pass
sys.stdout.buffer.write(encoded)
PY
)
  writer_status=$?
  set -e
  [[ $writer_status -eq 0 ]] || assertion_error
  printf '%s\n' "$evidence_output"
}

if [[ "$PHASE" == cleanup ]]; then
  bounded_status_capture CLEANUP_OUTPUT 1 "$DIAGNOSTIC_LIMIT" "$OUTER_TIMEOUT" docker container inspect "$CONTAINER"
  python3 - "$CLEANUP_OUTPUT" 2>/dev/null <<'PY' >/dev/null || assertion_error
import re,sys
if re.search(r"(?i)(no such object|no such container)",sys.argv[1]) is None: raise SystemExit(1)
PY
  write_or_print_evidence true false 0 0 false false 0 0 0 false 0 0 false false false
  exit 0
fi

bounded_capture IMAGE_JSON "$IMAGE_INSPECT_LIMIT" "$OUTER_TIMEOUT" docker image inspect --platform linux/amd64 "$IMAGE"
set +e
IMAGE_ID=$(python3 - "$IMAGE" "$INDEX_DIGEST" "$IMAGE_JSON" 2>/dev/null <<'PY'
import json,re,sys
image,digest,raw=sys.argv[1:]; records=json.loads(raw)
if not isinstance(records,list) or len(records)!=1: raise SystemExit(1)
record=records[0]; image_id=record.get("Id","")
if record.get("Os")!="linux" or record.get("Architecture")!="amd64" or image not in record.get("RepoDigests",[]) or image.rsplit("@",1)[-1]!=digest or re.fullmatch(r"sha256:[0-9a-f]{64}",image_id) is None: raise SystemExit(1)
print(image_id)
PY
)
IMAGE_META_STATUS=$?
set -e
[[ $IMAGE_META_STATUS -eq 0 ]] || assertion_error

bounded_capture CONTAINER_JSON "$CONTAINER_INSPECT_LIMIT" "$OUTER_TIMEOUT" docker container inspect "$CONTAINER"
EXPECTED_RUNNING=false
case "$PHASE" in
  initial) EXPECTED_RUNNING=true ;;
  publisher-a-offline-v1|publisher-b-active-v2) if [[ "$ROLE" != publisher-a ]]; then EXPECTED_RUNNING=true; fi ;;
  publishers-offline-v2) if [[ "$ROLE" == replica* ]]; then EXPECTED_RUNNING=true; fi ;;
esac

set +e
CONTAINER_META=$(python3 - "$CONTAINER_JSON" "$IMAGE_JSON" "$IMAGE" "$IMAGE_ID" "$EXPECTED_RUNNING" "$REPOSITORY_VERSION" "$ROLE" "$OWN_SWARM_IP" "$SWARM_PORT" "$GATEWAY_PORT" 2>/dev/null <<'PY'
import json,os,re,stat,sys
raw,image_raw,image,image_id,expected_running,repo_version,role,swarm_ip,swarm_port,gateway_port=sys.argv[1:]; records=json.loads(raw); image_records=json.loads(image_raw)
if not isinstance(records,list) or len(records)!=1: raise SystemExit(1)
if not isinstance(image_records,list) or len(image_records)!=1: raise SystemExit(1)
record=records[0]; config=record.get("Config",{}); host=record.get("HostConfig",{}); state=record.get("State",{})
image_config=image_records[0].get("Config",{})
if not isinstance(config,dict) or not isinstance(image_config,dict): raise SystemExit(1)
if config.get("Image")!=image or record.get("Image")!=image_id or state.get("Running")!=(expected_running=="true"): raise SystemExit(1)
if config.get("Entrypoint")!=["ipfs"] or config.get("Cmd")!=["daemon"] or config.get("StopTimeout")!=10: raise SystemExit(1)
match=re.fullmatch(r"([1-9][0-9]*):([0-9]+)",config.get("User",""))
if match is None: raise SystemExit(1)
uid=int(match.group(1)); gid=int(match.group(2))
def environment_map(entries):
    if not isinstance(entries,list): raise SystemExit(1)
    result={}
    for item in entries:
        if not isinstance(item,str) or "=" not in item: raise SystemExit(1)
        key,value=item.split("=",1)
        if not key or key in result: raise SystemExit(1)
        result[key]=value
    return result
expected_environment=environment_map(image_config.get("Env"))
expected_environment.update({"IPFS_PATH":"/data/ipfs","LIBP2P_FORCE_PNET":"1"})
if environment_map(config.get("Env"))!=expected_environment: raise SystemExit(1)
if host.get("ReadonlyRootfs") is not True or host.get("Privileged") is not False or host.get("PublishAllPorts") is not False or host.get("NetworkMode")!="bridge": raise SystemExit(1)
if host.get("CapAdd") not in (None,[]) or not isinstance(host.get("CapDrop"),list) or set(host["CapDrop"])!={"ALL"} or len(host["CapDrop"])!=1: raise SystemExit(1)
security=host.get("SecurityOpt")
if not isinstance(security,list) or len(security)!=1 or security[0] not in {"no-new-privileges","no-new-privileges:true"}: raise SystemExit(1)
tmpfs=host.get("Tmpfs")
if not isinstance(tmpfs,dict) or set(tmpfs)!={"/tmp"}: raise SystemExit(1)
tokens=tmpfs["/tmp"].split(",")
if len(tokens)!=len(set(tokens)): raise SystemExit(1)
sizes=[token for token in tokens if token.startswith("size=")]
if len(sizes)!=1: raise SystemExit(1)
size=sizes[0].split("=",1)[1].lower()
if size not in {"32m","33554432"} or set(tokens)-set(sizes)!={"rw","nosuid","nodev","noexec"}: raise SystemExit(1)
if host.get("Memory")!=402653184 or host.get("NanoCpus")!=500000000 or host.get("PidsLimit")!=256: raise SystemExit(1)
if host.get("RestartPolicy")!={"Name":"no","MaximumRetryCount":0}: raise SystemExit(1)
mounts=record.get("Mounts")
if not isinstance(mounts,list) or len(mounts)!=1: raise SystemExit(1)
mount=mounts[0]
if mount.get("Type")!="bind" or mount.get("Destination")!="/data/ipfs" or mount.get("RW") is not True: raise SystemExit(1)
repo=mount.get("Source")
if not isinstance(repo,str) or not repo.startswith("/") or os.path.normpath(repo)!=repo: raise SystemExit(1)
binds=host.get("Binds")
if binds!=[f"{repo}:/data/ipfs:rw"]: raise SystemExit(1)
current="/"
for component in repo.strip("/").split("/"):
    current=os.path.join(current,component); meta=os.lstat(current)
    if stat.S_ISLNK(meta.st_mode): raise SystemExit(1)
repo_meta=os.lstat(repo)
if not stat.S_ISDIR(repo_meta.st_mode) or repo_meta.st_uid!=uid or repo_meta.st_gid!=gid or stat.S_IMODE(repo_meta.st_mode)!=0o700: raise SystemExit(1)
version_path=os.path.join(repo,"version"); version_meta=os.lstat(version_path)
if not stat.S_ISREG(version_meta.st_mode) or stat.S_ISLNK(version_meta.st_mode) or version_meta.st_size>32: raise SystemExit(1)
with open(version_path,"rb") as handle: version=handle.read(33)
if version not in {repo_version.encode(),repo_version.encode()+b"\n"}: raise SystemExit(1)
key_meta=os.lstat(os.path.join(repo,"swarm.key"))
if not stat.S_ISREG(key_meta.st_mode) or stat.S_ISLNK(key_meta.st_mode) or stat.S_IMODE(key_meta.st_mode)!=0o600 or key_meta.st_uid!=uid or key_meta.st_gid!=gid: raise SystemExit(1)
expected={f"{swarm_port}/tcp":[{"HostIp":swarm_ip,"HostPort":swarm_port}]}
if role.startswith("replica"): expected[f"{gateway_port}/tcp"]=[{"HostIp":"127.0.0.1","HostPort":gateway_port}]
if host.get("PortBindings")!=expected or "5001/tcp" in host.get("PortBindings",{}): raise SystemExit(1)
print(uid); print(repo)
PY
)
CONTAINER_META_STATUS=$?
set -e
[[ $CONTAINER_META_STATUS -eq 0 ]] || assertion_error
mapfile -t CONTAINER_META_LINES <<< "$CONTAINER_META"
[[ ${#CONTAINER_META_LINES[@]} -eq 2 && "${CONTAINER_META_LINES[0]}" =~ ^[1-9][0-9]*$ ]] || assertion_error
REPOSITORY_PATH=${CONTAINER_META_LINES[1]}

if [[ -n "$EVIDENCE_DIR" ]]; then
  python3 - "$EVIDENCE_DIR" "$REPOSITORY_PATH" 2>/dev/null <<'PY' >/dev/null || assertion_error
import os,sys
left,right=sys.argv[1:]
common=os.path.commonpath([left,right])
if common in {left,right}: raise SystemExit(1)
left_meta=os.lstat(left); right_meta=os.lstat(right)
if (left_meta.st_dev,left_meta.st_ino)==(right_meta.st_dev,right_meta.st_ino): raise SystemExit(1)
PY
fi

bounded_capture PORT_OUTPUT "$PORT_OUTPUT_LIMIT" "$OUTER_TIMEOUT" docker port "$CONTAINER"
python3 - "$PORT_OUTPUT" "$ROLE" "$OWN_SWARM_IP" "$SWARM_PORT" "$GATEWAY_PORT" 2>/dev/null <<'PY' >/dev/null || assertion_error
import sys
output,role,swarm_ip,swarm_port,gateway_port=sys.argv[1:]; lines=output.splitlines() if output else []
expected={f"{swarm_port}/tcp -> {swarm_ip}:{swarm_port}"}
if role.startswith("replica"): expected.add(f"{gateway_port}/tcp -> 127.0.0.1:{gateway_port}")
if len(lines)!=len(set(lines)) or set(lines)!=expected: raise SystemExit(1)
PY

if [[ "$EXPECTED_RUNNING" != true ]]; then
  write_or_print_evidence false false 0 0 false false 0 0 0 false 0 0 "$PUBLISHER_A_OFFLINE_ATTESTED" "$PUBLISHER_B_OFFLINE_ATTESTED" true
  exit 0
fi

capture_exec() { local variable_name=$1; shift; bounded_capture "$variable_name" "$KUBO_OUTPUT_LIMIT" "$OUTER_TIMEOUT" docker exec "$CONTAINER" "$@"; }
capture_exec OBSERVED_KUBO ipfs version --number
[[ "$OBSERVED_KUBO" == "$KUBO_VERSION" ]] || assertion_error

CONFIG_CHECKS=0
config_expect() {
  local key=$1 expected=$2 actual
  bounded_capture actual "$KUBO_OUTPUT_LIMIT" "$OUTER_TIMEOUT" docker exec "$CONTAINER" ipfs config "$key" --json
  python3 - "$expected" "$actual" 2>/dev/null <<'PY' >/dev/null || assertion_error
import json,sys
if json.loads(sys.argv[2])!=json.loads(sys.argv[1]): raise SystemExit(1)
PY
  ((CONFIG_CHECKS += 1))
}
if [[ "$ROLE" == replica* ]]; then EXPECTED_GATEWAY='"/ip4/0.0.0.0/tcp/8080"'; else EXPECTED_GATEWAY='"/ip4/127.0.0.1/tcp/8080"'; fi
ANNOUNCE_JSON=$(python3 - "$OWN_SWARM_IP" "$SWARM_PORT" <<'PY'
import json,sys
print(json.dumps([f"/ip4/{sys.argv[1]}/tcp/{sys.argv[2]}"],separators=(",",":")))
PY
)
config_expect Addresses.API '"/ip4/127.0.0.1/tcp/5001"'; config_expect Addresses.Gateway "$EXPECTED_GATEWAY"; config_expect Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001"]'; config_expect Addresses.Announce "$ANNOUNCE_JSON"; config_expect Bootstrap '[]'; config_expect Routing.Type '"dhtserver"'; config_expect Routing.DelegatedRouters '[]'; config_expect Provide.Enabled 'false'; config_expect AutoConf.Enabled 'false'; config_expect AutoTLS.Enabled 'false'; config_expect DNS.Resolvers '{}'; config_expect Ipns.DelegatedPublishers '[]'; config_expect Ipns.UsePubsub 'false'; config_expect Discovery.MDNS.Enabled 'false'; config_expect Swarm.DisableNatPortMap 'true'; config_expect Swarm.EnableHolePunching 'false'; config_expect Swarm.RelayClient.Enabled 'false'; config_expect Swarm.RelayService.Enabled 'false'; config_expect Swarm.Transports.Network.QUIC 'false'; config_expect Swarm.Transports.Network.WebTransport 'false'; config_expect Swarm.Transports.Network.Websocket 'false'; config_expect Swarm.Transports.Network.WebRTCDirect 'false'; config_expect Swarm.Transports.Network.TCP 'true'; config_expect HTTPRetrieval.Enabled 'false'; config_expect Gateway.NoFetch 'true'; config_expect Gateway.NoDNSLink 'true'; config_expect Gateway.ExposeRoutingAPI 'false'; config_expect Swarm.DisableBandwidthMetrics 'true'; config_expect Plugins.Plugins.telemetry.Config.Mode '"off"'

set +e
timeout -k 5 "$OUTER_TIMEOUT" docker exec "$CONTAINER" /bin/busybox wget -q -T "$COMMAND_TIMEOUT" -O - --post-data '' -Y off "http://127.0.0.1:$API_PORT/api/v0/id" 2>/dev/null |
  python3 -c 'import json,sys; limit=int(sys.argv[2]); raw=sys.stdin.buffer.read(limit+1); data=json.loads(raw) if len(raw)<=limit else {}; ok=isinstance(data,dict) and data.get("ID")==sys.argv[1] and isinstance(data.get("PublicKey"),str) and isinstance(data.get("Addresses"),list) and isinstance(data.get("Protocols"),list) and data.get("AgentVersion","").split("/")[:2]==["kubo","0.42.0"]; raise SystemExit(0 if ok else 1)' "$OWN_PEER" "$API_BODY_LIMIT" 2>/dev/null
API_STATUSES=("${PIPESTATUS[@]}")
set -e
[[ ${#API_STATUSES[@]} -eq 2 && ${API_STATUSES[0]} -eq 0 && ${API_STATUSES[1]} -eq 0 ]] || assertion_error
API_POSITIVE=true

python3 - "$API_PORT" "$TRANSPORT_TIMEOUT" 2>/dev/null <<'PY' >/dev/null || assertion_error
import errno,socket,sys
sock=socket.socket(); sock.settimeout(int(sys.argv[2]))
try: result=sock.connect_ex(("127.0.0.1",int(sys.argv[1])))
finally: sock.close()
if result!=errno.ECONNREFUSED: raise SystemExit(1)
PY
HOST_API_ABSENT=true

capture_exec SWARM_PEERS ipfs swarm peers
python3 - "$SWARM_PEERS" "${EXPECTED_PEER_IDS[@]}" 2>/dev/null <<'PY' >/dev/null || assertion_error
import sys
observed=[]
for line in sys.argv[1].splitlines():
    parts=line.split("/")
    if not line or len(parts)<3 or parts[-2]!="p2p" or not parts[-1]: raise SystemExit(1)
    observed.append(parts[-1])
expected=sys.argv[2:]
if len(observed)!=len(set(observed)) or len(expected)!=len(set(expected)) or set(observed)!=set(expected): raise SystemExit(1)
PY

PIN_COUNT=0; REACHABLE_VERSIONS=0; FIXTURE_HASH_CHECKS=0; IPNS_VALID=false; GATEWAY_IPFS_CHECKS=0; GATEWAY_IPNS_CHECKS=0
verify_version() {
  local version=$1 cid=$2 pin_output refs_output hash_output hash_status actual marker extra line_version relative expected_hash
  capture_exec pin_output ipfs pin ls --type=recursive --quiet "$cid"; [[ "$pin_output" == "$cid" ]] || assertion_error; ((PIN_COUNT += 1))
  capture_exec refs_output ipfs refs --recursive --unique "/ipfs/$cid"
  python3 - "$cid" "$EXPECTED_BLOCKS" "$refs_output" 2>/dev/null <<'PY' >/dev/null || assertion_error
import sys
root=sys.argv[1]; expected=int(sys.argv[2]); refs=sys.argv[3].splitlines()
if any(not value or not value.startswith("b") for value in refs) or len(refs)!=len(set(refs)) or root in refs or len(set([root]+refs))!=expected: raise SystemExit(1)
PY
  ((REACHABLE_VERSIONS += 1))
  for line in "${FIXTURE_LINES[@]}"; do
    IFS=$'\t' read -r _ line_version relative expected_hash <<< "$line"; [[ "$line_version" == "$version" ]] || continue
    set +e
    hash_output=$(
      timeout -k 5 "$OUTER_TIMEOUT" docker exec "$CONTAINER" ipfs cat "/ipfs/$cid/$relative" 2>/dev/null | sha256sum
      hash_statuses=("${PIPESTATUS[@]}")
      [[ ${#hash_statuses[@]} -eq 2 && ${hash_statuses[0]} -eq 0 && ${hash_statuses[1]} -eq 0 ]]
    )
    hash_status=$?
    set -e
    [[ $hash_status -eq 0 ]] || assertion_error
    read -r actual marker extra <<< "$hash_output"; [[ "$actual" == "$expected_hash" && "$marker" == - && -z "$extra" ]] || assertion_error; ((FIXTURE_HASH_CHECKS += 1))
  done
}
gateway_check() {
  local namespace=$1 root=$2 relative=$3 expected_hash=$4
  python3 - "$namespace" "$root" "$relative" "$expected_hash" "$GATEWAY_PORT" "$GATEWAY_TIMEOUT" "$GATEWAY_BODY_LIMIT" 2>/dev/null <<'PY' >/dev/null || assertion_error
import hashlib,http.client,sys
namespace,root,relative,expected,port,timeout,limit=sys.argv[1:]; connection=http.client.HTTPConnection("127.0.0.1",int(port),timeout=int(timeout))
try:
    connection.request("GET",f"/{namespace}/{root}/{relative}",headers={"Cache-Control":"only-if-cached"}); response=connection.getresponse(); body=response.read(int(limit)+1)
    if response.status!=200 or len(body)>int(limit) or hashlib.sha256(body).hexdigest()!=expected: raise SystemExit(1)
finally: connection.close()
PY
  if [[ "$namespace" == ipfs ]]; then ((GATEWAY_IPFS_CHECKS += 1)); else ((GATEWAY_IPNS_CHECKS += 1)); fi
}

if [[ "$ROLE" == replica* && "$PHASE" != initial ]]; then
  timeout -k 5 "$PIN_TIMEOUT" docker exec "$CONTAINER" ipfs pin verify >/dev/null 2>&1 || assertion_error
  verify_version v1 "$V1"; if [[ "$PHASE" != publisher-a-offline-v1 ]]; then verify_version v2 "$V2"; fi
  if [[ "$PHASE" == publisher-a-offline-v1 ]]; then CURRENT_CID=$V1; CURRENT_SEQUENCE=$V1_SEQUENCE; else CURRENT_CID=$V2; CURRENT_SEQUENCE=$V2_SEQUENCE; fi
  capture_exec RESOLVED_VALUE ipfs name resolve --nocache --dht-record-count "$DHT_RECORD_COUNT" --dht-timeout "$DHT_TIMEOUT" "$IPNS_NAME"; [[ "$RESOLVED_VALUE" == "/ipfs/$CURRENT_CID" ]] || assertion_error
  set +e
  timeout -k 5 "$OUTER_TIMEOUT" docker exec "$CONTAINER" ipfs name get "$IPNS_NAME" 2>/dev/null |
    timeout -k 5 "$OUTER_TIMEOUT" docker exec -i "$CONTAINER" ipfs name inspect --enc=json --dump=false --verify "$IPNS_NAME" 2>/dev/null |
    python3 -c 'import json,sys; limit=int(sys.argv[4]); raw=sys.stdin.buffer.read(limit+1); data=json.loads(raw) if len(raw)<=limit else {}; entry=data.get("Entry",{}); validation=data.get("Validation",{}); ok=entry.get("Value")=="/ipfs/"+sys.argv[2] and entry.get("Sequence")==int(sys.argv[3]) and validation.get("Valid") is True and validation.get("Name")==sys.argv[1]; raise SystemExit(0 if ok else 1)' "$IPNS_NAME" "$CURRENT_CID" "$CURRENT_SEQUENCE" "$IPNS_INSPECT_LIMIT" 2>/dev/null
  IPNS_STATUSES=("${PIPESTATUS[@]}"); set -e
  [[ ${#IPNS_STATUSES[@]} -eq 3 && ${IPNS_STATUSES[0]} -eq 0 && ${IPNS_STATUSES[1]} -eq 0 && ${IPNS_STATUSES[2]} -eq 0 ]] || assertion_error; IPNS_VALID=true
  for line in "${FIXTURE_LINES[@]}"; do
    IFS=$'\t' read -r _ line_version relative expected_hash <<< "$line"
    if [[ "$line_version" == v1 ]]; then gateway_check ipfs "$V1" "$relative" "$expected_hash"; fi
    if [[ "$line_version" == v2 && "$PHASE" != publisher-a-offline-v1 ]]; then gateway_check ipfs "$V2" "$relative" "$expected_hash"; fi
    if [[ "$line_version" == v1 && "$PHASE" == publisher-a-offline-v1 ]]; then gateway_check ipns "$IPNS_NAME" "$relative" "$expected_hash"; fi
    if [[ "$line_version" == v2 && "$PHASE" != publisher-a-offline-v1 ]]; then gateway_check ipns "$IPNS_NAME" "$relative" "$expected_hash"; fi
  done
fi

write_or_print_evidence false true "$CONFIG_CHECKS" "$EXPECTED_PEER_COUNT" "$API_POSITIVE" "$HOST_API_ABSENT" "$PIN_COUNT" "$REACHABLE_VERSIONS" "$FIXTURE_HASH_CHECKS" "$IPNS_VALID" "$GATEWAY_IPFS_CHECKS" "$GATEWAY_IPNS_CHECKS" "$PUBLISHER_A_OFFLINE_ATTESTED" "$PUBLISHER_B_OFFLINE_ATTESTED" true
