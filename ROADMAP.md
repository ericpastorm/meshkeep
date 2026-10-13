# Meshkeep Roadmap

A living plan, not a release promise. An item is checked only when it is implemented and tested, with evidence in the progress log.

## Goal

Static websites that anyone can publish for free under a key-based address, that volunteers can keep alive without the publisher, and that people can visit through names in their own address book. No servers to rent, no registrars, no blockchain, and no Meshkeep service on the critical path. See [ADR 0002](docs/adr/0002-resilient-sites-and-address-book.md).

## v0.1 Core — in progress

- [x] Protocol package: Ed25519 key encoding, address derivation checked against Kubo, CID and address parsing, petnames, `meshkeep-address-book-v1` with canonical encoding and fixtures.
- [x] Kubo RPC adapter that refuses non-loopback endpoints by default.
- [x] CLI: `key create/list/export/import`, `publish`, `resolve`, `replicate`, `sync`, `verify`, `book add/remove/list/export/import`, `doctor`, `--json` output.
- [x] Automated integration test on a private five-node Kubo network: publish v1, two complete replicas, publisher offline, key moved, v2, sync, every publisher offline with a fresh visitor still resolving and loading the site, rejection of tampered and rolled-back records, and fail-closed `verify`.
- [x] Integration job green in GitHub Actions.
- [x] Operator guide ([docs/operators.md](docs/operators.md)): Kubo setup, network rules, publishing and keeping an address alive, key backup and transfer, replica limits, `sync` scheduling with verified systemd units and cron, disk space, troubleshooting.
- [x] Bounded replication: per-site size and block limits checked on the declared size, during the fetch, and after it; fetch timeouts; an interrupted transfer records nothing and resumes on the next run.

## v0.2 Replica Daemon

- [x] `meshkeep replica run`: periodic replication and record re-put per site, exponential backoff for failing sites, stored limits and retention, JSON-line logs, clean stop on SIGTERM/SIGINT.
- [x] Retention policy (`replicate --keep N`, remembered for `sync`) and safe pruning: only pins the replica created, never a version another site uses, never the current version.
- [x] `meshkeep unreplicate`: stop following a site and release the pins it created (`--keep-pins` to leave them).
- [x] Locking of the replica state, so a daemon and manual commands never overwrite each other.
- [ ] Follow a published address book: replicate every site a trusted curator lists, with explicit opt-in.
- [x] systemd user unit for the replica daemon (`examples/systemd/meshkeep-replica.service`).
- [x] Container image for volunteers running replicas: `Dockerfile` (Node.js + one bundled file, non-root) and `examples/docker/compose.yaml` (Kubo + daemon sharing a network namespace, RPC on loopback only).
- [ ] Publish the image to GitHub Container Registry from CI, so volunteers do not have to build it.

## v0.3 Browser Extension

- [ ] Address book UI (the "contact list"): add, rename, import, export, and subscribe to published books.
- [ ] Open `petname` or `k51…` addresses with an embedded verified-retrieval client (Helia / `@helia/verified-fetch`). No trusted gateway.
- [ ] Isolation review: site content never gets extension privileges or access to local services.
- [ ] Use a local Kubo gateway when one is available.

## v0.4 Publishing Ergonomics

- [ ] GitHub Action that publishes an already-built directory, with a key custody guide.
- [ ] Optional desktop app bundling Kubo for one-click publishing and replication.

## Later / Research

These items need an ADR before any work starts:

- Anonymous transports (Tor or I2P) for replicas and visitors.
- Key rotation and recovery for addresses.
- A DNSLink bridge for owners of existing domains.
- Replica discovery and mutual-replication circles, without tokens.

## Out Of Scope

- Blockchain, tokens, or consensus ledgers.
- Dynamic sites, server-side code, or hosted databases.
- A required Meshkeep cloud, gateway, registry, or account system.
- Guaranteed permanence or deletion.

## Progress Log

- 2026-07-18: Repository, documentation baseline, and TypeScript workspace created.
- 2026-07-21: Same-host Kubo lab showed deterministic `unixfs-v1-2025` CIDs and complete replica retention with the origin offline.
- 2026-07-29: Same-host lab showed signed IPNS v1 and v2 under one key moved between publishers, plus native rejection of invalid, stale, and malformed records.
- 2026-10-09: Direction changed by [ADR 0002](docs/adr/0002-resilient-sites-and-address-book.md). Manual Bash labs replaced by `pnpm test:integration`, which passed 9/9 locally (Docker 29.7.2, Kubo 0.42.0 pinned by digest, Node 26.8.2) in about 30 seconds with full cleanup. `pnpm check` passed with 83 unit tests. The fixture root CIDs match the earlier labs.
- 2026-10-09: CI green on GitHub for the first time since July. Both `check` and `integration` passed on PR #1 and again on `main` (`c4675dc`).
- 2026-10-13: Bounded replication. `pnpm check` passed with 122 unit tests. `pnpm test:integration` passed 12/12 in three consecutive local runs (Docker 29.7.2, Kubo 0.42.0), with no leftover containers or networks. The new suite covers refusal by declared size, refusal by block count during the fetch with the pin removed, and a fetch interrupted by publisher shutdown that records nothing and later resumes to a complete replica.
- 2026-10-13: Operator guide. Its claims were checked on Kubo 0.42.0: a fresh `ipfs init` binds RPC and gateway to loopback; with the daemon running, Kubo's republisher re-signed the record (debug log: `republishing ipns entry`) and kept the one-year expiry rather than shortening it to 48 hours; both `<address>.ipns.localhost` and `/ipns/<address>` gateway forms serve the site; the systemd units pass `systemd-analyze --user verify`; the symlinked launcher runs. A new integration test confirms that republishing an unchanged directory renews the record (higher sequence, same CID). `pnpm check` passed with 122 tests, and `pnpm test:integration` passed 13/13 twice.
- 2026-10-14: Retention and `unreplicate`. The replica now records the pins it creates and never unpins anything else. `pnpm check` passed with 147 unit tests, covering ownership, `--keep`, shared versions across sites, rollback to an older CID, failed unpins and re-puts, legacy state, and the PID lock. `pnpm test:integration` passed 15/15; on real Kubo, `--keep 1` unpinned v1 and kept v2, and `unreplicate` released both versions and left no pins.
- 2026-10-14: Replica daemon. `pnpm check` passed with 157 unit tests; the daemon's schedule and backoff are checked on a fake clock. A new integration test on real Kubo saw the daemon notice a v2 publication by itself and replicate it, run alongside a manual `replicate --keep 1` through the state lock, and stop cleanly with no lock left. The built binary stopped with exit 0 on both SIGTERM and SIGINT. The unit passes `systemd-analyze --user verify`.
- 2026-10-14: Container image. `pnpm check` now also bundles the CLI and runs the bundle. A new integration suite builds the image from the checkout and runs it in a Kubo node's network namespace (non-root, read-only, no capabilities): `doctor` passed, `docker exec … replicate` worked, the daemon replicated a new version by itself, and `docker stop` exited 0. With the compose file's own `kubo-init.sh`, on an internal Docker network, the sidecar reached the RPC while another container on the same network got "connection refused"; the gateway answered. `docker compose config` validates the compose file.
