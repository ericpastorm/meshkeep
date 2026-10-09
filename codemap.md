# Codemap

## Entry Points

- `packages/cli/src/bin.ts` → `runCli()` in `packages/cli/src/index.ts`: the `meshkeep` executable and every command.
- `packages/protocol/src/index.ts`: the public protocol API, re-exported from one module per concern.
- `packages/kubo/src/index.ts`: `KuboClient` and `parseApiUrl`.
- `tests/integration/lifecycle.test.ts`: the end-to-end scenario, running on `tests/integration/cluster.ts`.

## Modules

```text
packages/protocol/src/
  identifiers.ts    parseIpnsName (→ base36), parseContentCid (→ base32 v1), isIpnsName
  keys.ts           libp2p Ed25519 private-key encoding, ipnsNameFromPublicKey
  petname.ts        petname rules (DNS-label-like, never an address)
  address-book.ts   meshkeep-address-book-v1: parse, validate, canonical encode, edit helpers
  policy.ts         import profile values, record lifetime/TTL, re-put interval
  errors.ts         ProtocolError with stable codes

packages/kubo/src/index.ts
  parseApiUrl       loopback-only guard for the privileged RPC
  KuboClient        add, pin, dag/stat offline, name publish/resolve/get/put/inspect, keys, swarm

packages/cli/src/
  index.ts          commander wiring, --json output, error → exit code 1
  workflows.ts      publishSite, replicateSite, verifyComplete, requireImportProfile
  keystore.ts       key files (create, load+verify, import, export)
  state.ts          AddressBookStore (petname resolution), ReplicaStateStore
  site.ts           safe deterministic directory reader (no symlinks, no dotfiles by default)
  files.ts          size-limited reads, atomic private writes, no-clobber creates
```

## Dependency Direction

```text
@meshkeep/protocol  ◄── @meshkeep/cli ──►  @meshkeep/kubo ──► Kubo RPC (loopback)
        ▲
        └── future browser extension (must stay browser-safe)
```

## Invariants

- Untrusted data (records, Kubo responses, address books, key files, site directories) is validated at the boundary, and failures are closed.
- A replica reports a version only after `dag/stat` succeeds offline.
- Records must point to `/ipfs/<cid>`. Replicas never roll back below a verified sequence.
- Formats change only with an ADR, updated `spec/README.md`, and fixtures.
