# Meshkeep Roadmap

A living plan, not a release promise. An item is checked only when it is implemented and tested, with evidence in the progress log.

## Goal

Static websites that anyone can publish for free under a key-based address, that volunteers can keep alive without the publisher, and that people can visit through names in their own address book. No servers to rent, no registrars, no blockchain, and no Meshkeep service on the critical path. See [ADR 0002](docs/adr/0002-resilient-sites-and-address-book.md).

## v0.1 Core — in progress

- [x] Protocol package: Ed25519 key encoding, address derivation checked against Kubo, CID and address parsing, petnames, `meshkeep-address-book-v1` with canonical encoding and fixtures.
- [x] Kubo RPC adapter that refuses non-loopback endpoints by default.
- [x] CLI: `key create/list/export/import`, `publish`, `resolve`, `replicate`, `sync`, `verify`, `book add/remove/list/export/import`, `doctor`, `--json` output.
- [x] Automated integration test on a private five-node Kubo network: publish v1, two complete replicas, publisher offline, key moved, v2, sync, every publisher offline with a fresh visitor still resolving and loading the site, rejection of tampered and rolled-back records, and fail-closed `verify`.
- [ ] Integration job green in GitHub Actions.
- [ ] Operator guide: Kubo setup for publishers and replicas, `sync` scheduling, key backup.
- [ ] Bounded replication: per-site size and block limits, plus tests for interrupted transfers and timeouts.

## v0.2 Replica Daemon

- [ ] `meshkeep replica run`: periodic sync and record re-put with backoff, limits, and structured local logs.
- [ ] Retention policy (keep latest N versions) and safe pruning.
- [ ] Follow a published address book: replicate every site a trusted curator lists, with explicit opt-in.
- [ ] Container image and systemd unit for volunteers running replicas.

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
