# Architecture

Meshkeep turns a static directory into an immutable, content-addressed version, points a key-based address at it with a signed record, and lets volunteer replicas keep both alive. Decisions and trade-offs are recorded in [ADR 0002](adr/0002-resilient-sites-and-address-book.md). The normative rules are in [the specification](../spec/README.md).

## Roles

- **Publisher:** holds the site key and signs records. Authority follows the key, not a machine: export the key, import it elsewhere, and keep publishing.
- **Replica:** a volunteer Kubo node that follows a site. It verifies each record, keeps every block of every version, re-puts the record so the address keeps resolving, and serves blocks and gateway requests.
- **Visitor:** any IPFS client (a Kubo node today, the browser extension later) that resolves the address and fetches the content, verifying blocks by CID.

One machine can play several roles. None of them is a coordinator.

## Flow

```text
                 meshkeep publish                     meshkeep replicate / sync
static dir ──► read safely ──► Kubo add ──► pin ──► find newest record ──► publish seq+1
                (no symlinks,     (profile                (continue after a key moves)
                 no dotfiles)      checked)
                                                              │ DHT + bitswap
                                                              ▼
                     replica: name/get ──► verify signature, value is /ipfs/, no rollback
                              pin recursively ──► dag/stat offline (complete or fail)
                              name/put same record (keeps the address alive)
                                                              │
                                                              ▼
                     visitor: resolve address (DHT, served by replicas) ──► fetch blocks
```

## Components

| Package | Owns | Must not |
| --- | --- | --- |
| `@meshkeep/protocol` | Address derivation, key encoding, CID and address parsing, petnames, address book format, policy constants | Use Node-only APIs, talk to Kubo, print anything |
| `@meshkeep/kubo` | HTTP calls to Kubo RPC, response validation, loopback guard | Make policy decisions |
| `@meshkeep/cli` | Commands, keystore, address book file, replica state, publish and replicate workflows | Reimplement protocol validation |

### Local State

`$MESHKEEP_HOME` (default `~/.config/meshkeep`) holds the following, with directories at mode 0700 and files at 0600, all written atomically:

- `keys/<label>.key`: `libp2p-protobuf-cleartext` Ed25519 keys. Kubo receives a copy named `meshkeep-<label>` when publishing.
- `address-book.json`: the user's address book, in canonical `meshkeep-address-book-v1` format.
- `replicas.json`: the sites this node replicates, with the newest verified sequence and every pinned version. This is the replica's rollback guard.

### Kubo Configuration

Publishers need the `unixfs-v1-2025` import profile; `meshkeep doctor` and `meshkeep publish` check it. Kubo RPC must listen on loopback only. The CLI refuses other endpoints unless `--allow-remote-api` is given.

## Access

- **Today:** any Kubo gateway, for example `http://127.0.0.1:8080/ipns/<address>/` on a replica or on the visitor's own node.
- **Planned:** a browser extension that resolves petnames from the address book and fetches content with an embedded verified-retrieval client. Replica gateways stay optional.

Different gateways are different browser origins. Sites should use relative links and must not assume a fixed hostname.

## Testing

`pnpm test:integration` starts five Kubo containers: two publishers, two replicas, and a visitor. They run on a Docker network with a random swarm key, no bootstrap peers, and no delegated routing, with RPC and gateway published only on host loopback. The test drives the real CLI through the whole lifecycle. The fixture sites under `tests/fixtures/` have known root CIDs that pin the import profile.
