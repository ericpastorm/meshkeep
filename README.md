# Meshkeep

**English** · [Español](README.es.md)

Host static websites on a peer-to-peer network: free addresses, no servers to rent, and no single point anyone can switch off.

> **Status: early development (v0.2).** Publishing, replication, the replica daemon, and address books work end to end and are tested against real Kubo nodes. The browser extension is a preview. Interfaces and formats may still change. Use disposable keys and public content only.

## The Idea

- **Your address is a key.** `meshkeep key create blog` gives you an address like `k51qzi5uqu5d…`. Nobody sells it, nobody can take it from you, and it costs nothing.
- **Your site is content-addressed.** Each version is an immutable IPFS directory identified by its hash. Whoever has a copy can serve it, and every visitor can check that the bytes are right.
- **Anyone can keep it alive.** Replicas, which are other people's machines, keep a full copy and keep your signed address record circulating. Once replicas hold it, the site stays up even if your own computer is gone, the way a torrent outlives its first seeder.
- **People use names, not hashes.** Everyone keeps an address book (`book add blog k51…`) that maps their own nicknames to addresses. Books can be shared and imported. A browser extension works like a contact list: type `mk their-blog` in the address bar.

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
meshkeep replica run                     # stays running: re-checks every site every 6 hours
```

Instead of `replica run`, you can run `meshkeep sync` from cron at least every 12 hours. Or run a whole replica, Kubo included, with Docker: `cd examples/docker && docker compose up -d` pulls the published image (`ghcr.io/ericpastorm/meshkeep`, amd64 and arm64) and Kubo (see the [operator guide](docs/operators.md#run-a-replica-with-docker)).

Replicas only fetch what they agreed to hold. Each site has a size and block limit (by default 2 GiB and 250,000 blocks). Set it with `replicate --max-size 512MiB --max-blocks 50000`; the value is remembered, and `sync` applies it. Versions over the limit are refused and left unpinned. An interrupted or timed-out fetch (`--fetch-timeout`, default 30 minutes) records nothing, and the next run resumes from the blocks already downloaded.

Every version stays pinned unless you choose otherwise: `replicate --keep 3` keeps the three most recent versions (remembered for `sync`), and `meshkeep unreplicate their-blog` stops following a site. Both only ever unpin versions this replica pinned itself, never a pin you or `meshkeep publish` made on the same node.

Help keep a whole community online by following a curator's published address book, the way you would subscribe to a torrent list:

```sh
meshkeep book publish --key my-list      # curator: publish your address book as a site
meshkeep follow k51…curator              # replica: replicate every site it lists, and keep up
meshkeep unfollow k51…curator            # stop, releasing the sites only that book wanted
```

`sync` and `replica run` pick up the curator's changes. Sites the book stops listing are dropped unless you replicate them yourself or another followed book lists them. `--max-sites` (default 100) and per-site limits bound what a curator can ask of you. See [ADR 0003](docs/adr/0003-published-address-books.md).

Visit a site through any Kubo node's gateway: `http://127.0.0.1:8080/ipns/k51…/`.

### Browser Extension (Preview)

The extension is your address book in the browser. Type `mk`, a space, and a petname in the address bar, or use its toolbar popup. Sites open on the IPFS gateway on your own computer (`http://<address>.ipns.localhost:8080/`), so each site gets its own browser origin and Kubo checks every block. It needs a local Kubo node, such as the Docker replica above. It imports and exports the same files as `meshkeep book`, and never uses a remote gateway. [ADR 0004](docs/adr/0004-browser-extension.md) explains why it works this way.

Until it is published in a store, load it unpacked in Chrome, Brave, or Edge: run `pnpm install && pnpm build`, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `packages/extension/dist`.

Move publishing to another machine:

```sh
meshkeep key export blog blog.key        # unencrypted, so move it securely and delete it after
# on the other machine:
meshkeep key import blog blog.key
meshkeep publish ./public --key blog     # continues from the latest version
```

Add `--json` to any command for machine-readable output on stdout. Diagnostics go to stderr. Meshkeep keeps its state in `$MESHKEEP_HOME` (default `~/.config/meshkeep`).

Running a publisher or replica for real? Read the [operator guide](docs/operators.md): Kubo setup, key backup, scheduling `sync` with systemd or cron, disk space, and troubleshooting.

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
packages/extension  browser extension: address book and opener over the local gateway
spec/               normative rules, JSON schema, interoperability fixtures
tests/integration   private Kubo network in Docker, full lifecycle test
docs/               operator guide, architecture, threat model, privacy, ADRs
examples/           demo site, Docker Compose replica, systemd units for the daemon and scheduled sync
Dockerfile          the meshkeep image (Node.js + one bundled file), runs the replica daemon
```

## Development

```sh
pnpm install
pnpm check              # lint, typecheck, unit tests, build
pnpm test:integration   # needs Docker; starts five Kubo containers on a private network
```

The extension tests drive Playwright's Chromium; install it once with `pnpm exec playwright install chromium`.

The integration test publishes v1 and replicates it to two replicas, then shuts the publisher down. It moves the key to a second publisher, publishes v2 and syncs. Finally it shuts every publisher down and checks that a brand-new visitor can still resolve and load the site from the replicas alone. It also checks that tampered and rolled-back records are rejected. Further suites cover replica size and block limits with an interrupted fetch that resumes later, the replica daemon, the container image (built from the checkout and run next to Kubo as compose runs it), and the browser extension against a real Kubo gateway.

## Roadmap

Next up: subscribing to published address books from the extension, and its isolation review. See [ROADMAP.md](ROADMAP.md).

## Contributing And Security

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Code is licensed under the [Mozilla Public License 2.0](LICENSE).
