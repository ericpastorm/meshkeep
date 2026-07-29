# Meshkeep

Publish a signed static website version and let volunteer replicas keep it available after the publisher goes offline.

> **Status: pre-alpha.** The repository contains the documentation baseline, initial protocol/CLI scaffolding, a reproducible immutable-CID Kubo lab, and a separate same-host native-Kubo signed-IPNS/key-transfer precursor that recursively pins complete graphs on two replicas. Independent-environment acceptance and the hard MVP remain open, and the protocol/CLI workflows are not implemented. Do not use Meshkeep for production data or availability.

## What Meshkeep Is

Meshkeep is an open-source peer-to-peer publication and replication workflow for static websites. A publisher imports static files into IPFS, uses a signed IPNS update to select an immutable content root, and asks independently operated replicas to retain the complete UnixFS graph. A replica can then serve that version through its own Kubo gateway even when the publishing origin is offline.

The planned baseline uses:

- Kubo/IPFS for content addressing, transfer, pinning, and gateway access.
- UnixFS with the `unixfs-v1-2025` import profile for static content.
- IPNS for signed mutable discovery of the current immutable version.
- CAR files as an optional transport, not a separate identity system.
- TypeScript for protocol code, CLI, and future UI code.
- Rust only later, if needed for a Tauri shell and Kubo sidecar lifecycle.

## What Meshkeep Is Not

- It is not an anonymity or privacy network.
- It cannot make content indestructible or guarantee that volunteers will retain it.
- It cannot guarantee deletion after content has reached IPFS peers.
- It is not a blockchain, cryptocurrency, token, or consensus system.
- It is not hosting for dynamic servers, databases, or arbitrary application containers.
- It does not require a Meshkeep-operated gateway, coordinator, account service, or cloud.
- It does not promise one canonical URL or browser origin across replicas.

## Target MVP Demo

The hard MVP is one repeatable lab scenario:

1. On publisher machine A, import a static site and publish signed version v1.
2. On two independently configured replicas, resolve v1 and pin its complete graph.
3. Shut down machine A and its Kubo node.
4. Open and verify v1 through each replica's own CID or IPNS gateway URL.
5. Move the publishing key securely to publisher machine B and publish changed version v2 under the same identity.
6. Have both replicas verify the update, synchronize the complete v2 graph, and serve it.

Alternative CID/IPNS URLs are expected. The demo proves content integrity, signed update authority, replication, and origin independence. It does not prove anonymity, permanent availability, or a canonical hostname.

## Architecture Summary

Static files form an immutable UnixFS graph identified by a root CID. The CID commits to the graph's bytes. A publisher-controlled IPNS key signs mutable records that select the current root. Replicas resolve and validate the signed update, fetch every reachable block, and recursively pin the version according to local policy. Once propagation is complete, the initial Kubo origin is not required for retrieval.

Kubo remains behind an adapter and private local RPC boundary. The protocol does not depend on a public gateway or hosted Meshkeep service. A CAR archive may move the same content graph between nodes without changing its root CID.

See [Architecture](docs/architecture.md), [Threat Model](docs/threat-model.md), [Privacy](docs/privacy.md), and [ADR 0001](docs/adr/0001-mvp-scope.md).

## Expected Repository Layout

The repository currently has protocol and CLI scaffolds, a draft unsigned manifest schema, and a demo fixture. Later paths remain planned boundaries. Their presence does not mean the hard MVP workflow is implemented.

```text
packages/
  protocol/       # Initial TypeScript types/constants; protocol behavior is planned
  cli/            # Initial version/doctor scaffold; Kubo workflows are planned
  replicator/     # Planned v0.2 headless replica
apps/
  desktop/        # Planned v0.3 Linux Tauri shell
spec/             # Draft schema; normative protocol fixtures are planned
examples/         # Demo site plus the immutable-CID Kubo lab and fixtures
docs/
  adr/            # Architecture decision records
```

## Development

### Prerequisites

- Git
- Node.js `>=22.23.1 <23`; `.node-version` pins the tested 22.23.1 security baseline
- pnpm 10.34.5, as declared by the root `packageManager` field
- Docker for the Kubo lab; `ipfs/kubo` 0.42.0 is pinned by digest in its manifest
- Linux or another environment capable of running isolated Kubo repositories for that lab

Rust is not a current prerequisite.

### Setup

Install the workspace and run its aggregate check:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Focused scripts are `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, and `pnpm smoke:artifacts`. The aggregate check builds before the artifact smoke test, which packs both packages, creates a frozen offline consumer from the current pnpm store, verifies runtime and TypeScript export conditions, exercises the installed bin shim, and preserves direct/symlinked built-bin regression coverage. The current CLI only provides version output and a prerequisite report; `doctor` accepts stable Node `>=22.23.1 <23`, reports unsupported runtimes with a nonzero status, and does not perform external checks.

The root pnpm override temporarily keeps tsup on esbuild 0.28.1 so the workspace has one esbuild release line; remove it when tsup's declared dependency range advances.

The first manual proof covers immutable CIDs and offline replica retention only:

```sh
./examples/lab/run-lab.sh
```

See [the lab guide](examples/lab/README.md) and its explicit IPNS/key-transfer limitations.

## Principles

- Make a narrow, testable promise and report limitations plainly.
- Prefer immutable content identity plus signed mutable discovery.
- Keep the publisher origin disposable and replicas independently operated.
- Require complete recursive retention, not a root-only pin.
- Avoid central services, hidden gateway fallbacks, and protocol proliferation.
- Treat interoperability fixtures and failure behavior as protocol requirements.
- Add complexity only after the manual proof demonstrates a need.

## Security And Privacy

Publishing to IPFS is public distribution. Content, CIDs, IPNS names, peer identifiers, IP addresses, request timing, and provider activity may be observable. A signing key controls future updates and its loss or theft can be permanent. Replica and gateway operators can inspect requests and retained content.

Never expose Kubo RPC to the public network or untrusted browser content. Use only disposable keys and non-sensitive content during pre-alpha testing. Read [SECURITY.md](SECURITY.md), [the threat model](docs/threat-model.md), and [the privacy notes](docs/privacy.md) before operating a node.

## Roadmap

The [roadmap](ROADMAP.md) contains the hard MVP acceptance criteria, phase gates, and explicit exclusions. Unchecked items are not implemented commitments.

## Contributing

Contributions are welcome after reading [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Protocol and trust-model changes require discussion and an ADR before implementation. Security reports must follow [SECURITY.md](SECURITY.md).

Meshkeep code is licensed under the [Mozilla Public License 2.0](LICENSE). Documentation and repository license notices should be checked before redistributing non-code material.
