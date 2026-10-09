# Meshkeep

Host static websites on a peer-to-peer network: free addresses, no servers to rent, and no single point anyone can switch off.

> **Status: early development (v0.1).** Publishing, replication, and address books work end to end and are tested against real Kubo nodes. Interfaces and formats may still change. Use disposable keys and public content only.

## The Idea

- **Your address is a key.** `meshkeep key create blog` gives you an address like `k51qzi5uqu5d…`. Nobody sells it, nobody can take it from you, and it costs nothing.
- **Your site is content-addressed.** Each version is an immutable IPFS directory identified by its hash. Whoever has a copy can serve it, and every visitor can check that the bytes are right.
- **Anyone can keep it alive.** Replicas, which are other people's machines, keep a full copy and keep your signed address record circulating. Once replicas hold it, the site stays up even if your own computer is gone, the way a torrent outlives its first seeder.
- **People use names, not hashes.** Everyone keeps an address book (`book add blog k51…`) that maps their own nicknames to addresses. Books can be shared and imported. A browser extension that works like a contact list is planned.

There is no blockchain, no token, no central registry, and no Meshkeep server. Under the hood, [Kubo](https://github.com/ipfs/kubo) (IPFS) does the storage, transfer, and signed names. Meshkeep adds the workflow, the rules, and the address book.

Meshkeep is **not** anonymous: peers can see the IP addresses of the nodes they talk to. It does not guarantee permanence (a site lives while someone replicates it) or deletion (copies can't be recalled). See [the threat model](docs/threat-model.md).

## Quick Start

You need Node.js 22.12 or later, pnpm, and a running [Kubo](https://docs.ipfs.tech/install/command-line/) daemon whose RPC API listens on `127.0.0.1:5001`.

```sh
pnpm install && pnpm build
alias meshkeep="node $PWD/packages/cli/dist/bin.js"

# Once per Kubo node: use the import profile that makes versions reproducible.
ipfs config profile apply unixfs-v1-2025   # then restart the daemon
meshkeep doctor
```

Publish a site:

```sh
meshkeep key create blog                 # prints your address, k51…
meshkeep publish ./public --key blog     # imports, pins, and signs v1
# edit ./public, then publish again: same address, new version
```

Replicate someone's site, with a petname:

```sh
meshkeep book add their-blog k51qzi5uqu5d…
meshkeep replicate their-blog            # full copy + keeps the address alive
meshkeep sync                            # run this from cron at least every 12 hours
```

Visit a site through any Kubo node's gateway: `http://127.0.0.1:8080/ipns/k51…/`.

Move publishing to another machine:

```sh
meshkeep key export blog blog.key        # unencrypted, so move it securely and delete it after
# on the other machine:
meshkeep key import blog blog.key
meshkeep publish ./public --key blog     # continues from the latest version
```

Add `--json` to any command for machine-readable output on stdout. Diagnostics go to stderr. Meshkeep keeps its state in `$MESHKEEP_HOME` (default `~/.config/meshkeep`).

## How It Works

```text
publisher                         replicas                         visitor
─────────                         ────────                         ───────
static dir ─► UnixFS CID
key ─► signed IPNS record ──────► verify signature + sequence
                                  pin every block, verify offline
                                  re-put record into the DHT ────► resolve address
                                  serve blocks ──────────────────► fetch + verify by CID
```

See [the architecture](docs/architecture.md), [the specification](spec/README.md), and [ADR 0002](docs/adr/0002-resilient-sites-and-address-book.md) for the reasoning.

## Repository

```text
packages/protocol   addresses, keys, petnames, address book (pure TS, browser-safe)
packages/kubo       narrow Kubo RPC client (loopback-only by default)
packages/cli        the meshkeep command
spec/               normative rules, JSON schema, interoperability fixtures
tests/integration   private Kubo network in Docker, full lifecycle test
docs/               architecture, threat model, privacy, ADRs
```

## Development

```sh
pnpm install
pnpm check              # lint, typecheck, unit tests, build
pnpm test:integration   # needs Docker; starts five Kubo containers on a private network
```

The integration test publishes v1 and replicates it to two replicas, then shuts the publisher down. It moves the key to a second publisher, publishes v2 and syncs. Finally it shuts every publisher down and checks that a brand-new visitor can still resolve and load the site from the replicas alone. It also checks that tampered and rolled-back records are rejected.

## Roadmap

Next up: a replica daemon, then the browser extension with an address-book UI and in-browser verified retrieval. See [ROADMAP.md](ROADMAP.md).

## Contributing And Security

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Code is licensed under the [Mozilla Public License 2.0](LICENSE).
