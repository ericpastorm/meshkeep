# Architecture

Meshkeep turns a static directory into an immutable, content-addressed version, points a key-based address at it with a signed record, and lets volunteer replicas keep both alive. Decisions and trade-offs are recorded in [ADR 0002](adr/0002-resilient-sites-and-address-book.md). The normative rules are in [the specification](../spec/README.md).

## Roles

- **Publisher:** holds the site key and signs records. Authority follows the key, not a machine: export the key, import it elsewhere, and keep publishing.
- **Replica:** a volunteer Kubo node that follows a site. It verifies each record, keeps every block of every version, re-puts the record so the address keeps resolving, and serves blocks and gateway requests.
- **Visitor:** any IPFS client that resolves the address and fetches the content, verifying blocks by CID. Today that is a Kubo node, which the browser extension opens sites through.

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
| `@meshkeep/extension` | The browser's address book, the `mk` omnibox keyword and popup, opening sites on the local gateway | Fetch or render site content, use a remote gateway, reach web pages or local services |

### Local State

`$MESHKEEP_HOME` (default `~/.config/meshkeep`) holds the following, with directories at mode 0700 and files at 0600, all written atomically:

- `keys/<label>.key`: `libp2p-protobuf-cleartext` Ed25519 keys. Kubo receives a copy named `meshkeep-<label>` when publishing.
- `address-book.json`: the user's address book, in canonical `meshkeep-address-book-v1` format.
- `replicas.json`: the sites this node replicates, with the newest verified sequence, the versions kept, the site's limits and retention (`keep`), and `ownedPins`, the versions whose pin this replica created. It is the replica's rollback guard. Every read-modify-write holds `replicas.json.lock`, which contains the holder's PID; a lock whose process no longer exists is taken over.

### Retention And Pin Ownership

Kubo pins have no owner, so the replica records which pins it created. Retention (`--keep N`) and `unreplicate` only unpin those, and only when no other replicated site lists the version, so a pin the operator or `meshkeep publish` made on the same node survives. Old versions are dropped only after the new version is complete and recorded. The current version always moves to the end of the history, so it is never dropped. Unpinning is idempotent, and a failed unpin leaves the version recorded for the next run. A complete version is recorded even if re-putting its record fails, because losing track of a pin this run created would make it impossible to release later.

### Replica Limits

A replica fetches a version only within the site's `maxBytes` and `maxBlocks` (default 2 GiB and 250,000 blocks; set with `replicate --max-size/--max-blocks`, remembered for `sync`). There are three barriers, because the publisher controls the bytes:

1. **Declared size.** The root's `CumulativeSize` is checked before anything else is fetched. It is cheap, but it is the publisher's claim.
2. **While fetching.** `pin/add` progress (blocks and bytes) is watched, and the request is aborted, which cancels the fetch, as soon as either limit is crossed.
3. **Exact size.** After the pin, an offline `dag/stat` gives the real size. A version over the limit is refused.

A refused version is unpinned when this run created the pin; that also covers an abort racing with Kubo finishing the pin. A fetch that times out (`--fetch-timeout`) records nothing. Blocks already fetched stay in the blockstore unpinned, so the next run resumes from them, and Kubo garbage collection can reclaim them.

### Followed Books

A replica can follow a curator's published address book (`.well-known/meshkeep/address-book.json` in the curator's site; [ADR 0003](adr/0003-published-address-books.md)). `replicas.json` records each follow: its curator, the listed addresses at the last successful read, the version they were read from, `maxSites`, and the limits and retention for the sites it adds. Each site records whether the operator asked for it (`manual`). A site is wanted when it is manual or tracked by a follow (listed by its book, or the curator's own site), and the replica keeps exactly the wanted sites. A refresh replicates the curator's site through the normal workflow, reads the book from local blocks with a 4 MiB cap, validates it fully, updates the follow, and drops sites that are no longer wanted. A failed refresh changes nothing.

### Replica Daemon

`meshkeep replica run` is an optional long-running process, not a coordinator. Each cycle it reads `replicas.json` again, refreshes every followed book that is due, and then runs the same `replicateSite` workflow for every wanted site that is due. Each site is due once per interval (default 6 hours). After a failure it is retried with exponential backoff starting at 1 minute and capped at the interval. Operational failures (Kubo, network, limits, state) are logged and retried; unexpected errors exit so a supervisor restarts the process. SIGTERM/SIGINT abort an in-flight record lookup or fetch, and nothing half-done is recorded. Logs are JSON lines on stderr. The loop takes its clock and sleep as parameters, so its schedule is unit-tested without waiting.

### Container Image

The `Dockerfile` builds a Node.js image with the CLI bundled into one ES module (`scripts/bundle-cli.mjs`, using esbuild) and runs `meshkeep replica run` by default. It needs no exception to the loopback rule: the container is meant to share a Kubo node's network namespace, so the RPC stays on loopback (`examples/docker/compose.yaml`). The integration suite builds the image from the checkout and runs it that way against a private Kubo network. A version tag (`vX.Y.Z`) makes CI publish it to `ghcr.io/ericpastorm/meshkeep` for amd64 and arm64, with a build provenance attestation; the workflow refuses a tag that does not match the version in `package.json`. Pull requests build both architectures without publishing.

### Kubo Configuration

Publishers need the `unixfs-v1-2025` import profile; `meshkeep doctor` and `meshkeep publish` check it. Kubo RPC must listen on loopback only. The CLI refuses other endpoints unless `--allow-remote-api` is given.

## Access

- **Any Kubo gateway:** for example `http://127.0.0.1:8080/ipns/<address>/` on a replica or on the visitor's own node.
- **The browser extension** ([ADR 0004](adr/0004-browser-extension.md)): it resolves a petname from the browser's address book and opens `http://<address>.ipns.localhost:<port>/` on the visitor's own Kubo node. The subdomain gateway gives every site its own origin, so the browser keeps sites apart from each other, and Kubo verifies every block and record.

Different gateways are different browser origins. Sites should use relative links and must not assume a fixed hostname.

### Browser Extension

A Manifest V3 extension (`packages/extension`), built with esbuild into `packages/extension/dist`. The background service worker owns the state: the address book, stored in `chrome.storage.local` as canonical `meshkeep-address-book-v1` text, and the gateway port (default 8080). It validates every message and applies changes one at a time. The popup and the address book page only send it requests. The extension never fetches site content. Its only network request is a reachability check for the empty identity CID (`http://bafkqaaa.ipfs.localhost:<port>/`), and its content security policy allows nothing else. It has no content scripts, no web-accessible resources, and no `externally_connectable`, and its only permission is `storage`. We measured why an extension cannot serve sites itself; ADR 0004 has the details.

## Testing

`pnpm test:integration` starts five Kubo containers: two publishers, two replicas, and a visitor. They run on a Docker network with a random swarm key, no bootstrap peers, and no delegated routing, with RPC and gateway published only on host loopback. The test drives the real CLI through the whole lifecycle. The fixture sites under `tests/fixtures/` have known root CIDs that pin the import profile. The extension suite loads the built extension into Playwright's Chromium against a Kubo container's gateway and drives the address book page and the popup like a user.
