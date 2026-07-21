# Meshkeep Roadmap

This is a living plan, not a release promise. Checkboxes record verified repository or lab outcomes, not work in progress or intent.

## Status Legend

- [x] Complete and verified. Evidence belongs in the progress log.
- [ ] Not complete or not yet verified.
- **IN PROGRESS** means active work but remains unchecked.
- **BLOCKED** means a stated dependency or decision prevents progress.
- **CONDITIONAL** means the work is considered only after its decision gate passes.

## Current Focus

Build the protocol and CLI only after proving the core lifecycle in a reproducible manual Kubo lab. The immediate target is v0.0, with the hard MVP scenario retained as the acceptance boundary for subsequent automation.

No implementation package is considered complete merely because files appear in the repository. It must satisfy its phase checks and produce repeatable evidence.

## Hard MVP Acceptance Criteria

The MVP is accepted only when one documented lab run demonstrates all of the following without a Meshkeep-operated central service:

- [ ] Import a static site with the `unixfs-v1-2025` profile and publish immutable version v1 under a signed IPNS name.
- [ ] Have two independently configured replicas resolve v1, validate the signed update, and pin the complete reachable UnixFS graph.
- [ ] Shut down the publishing origin, including its Kubo node.
- [ ] Open v1 from each replica and verify expected content while the publishing origin remains offline.
- [ ] Move the publishing key securely to a second publisher machine and publish changed immutable version v2 under the same identity.
- [ ] Have both replicas detect the signed update, synchronize the complete v2 graph, and retain it according to the stated policy.
- [ ] Open and verify v2 from both replicas, with v1/v2 identity and synchronization evidence recorded.
- [ ] Perform the run from a clean, documented environment using only committed instructions and disposable test keys.

Replica-local CID and IPNS gateway URLs are valid acceptance URLs. A shared DNS name, canonical hostname, DNSLink, or the original publisher URL is not required. See [ADR 0001](docs/adr/0001-mvp-scope.md).

## v0.0 Manual Proof

Goal: prove Kubo and IPNS behavior before fixing a Meshkeep protocol or automating it.

- [x] Initialize the Git repository.
- [x] Establish project, governance, architecture, threat, privacy, and MVP scope documentation.
- [x] Establish the technical and configuration baseline for the workspace, initial packages, fixtures, and CI.
- [x] Define a disposable static fixture and expected file checksums. (`examples/lab-fixtures/v1` + `v2`; eight SHA-256 values in the lab manifest)
- [x] Record exact Kubo and environment versions for the lab. (Kubo 0.42.0/repo 18; image pinned as `sha256:8907cb0c…`)
- [x] Document deterministic import steps for `unixfs-v1-2025` and confirm repeatable root CIDs. (v1 repeated on publisher and independently hashed on a replica; v2 independently hashed on a second replica)
- [ ] Publish v1 through IPNS and recursively pin it on two isolated replicas. (recursive pin is proven for the immutable CID; IPNS is not exercised)
- [x] Demonstrate v1 retrieval from both replicas after origin shutdown. (all reachable refs and four file hashes verified on each replica with the publisher stopped)
- [ ] Transfer a disposable publishing key to a second machine and publish v2.
- [ ] Demonstrate signed update resolution, complete synchronization, and v2 retrieval from both replicas.
- [x] Capture commands, expected outputs, failure notes, and cleanup steps in a manual lab guide. (`examples/lab/README.md`)

Exit gate: the hard MVP lifecycle works manually and remaining Kubo/IPNS limitations are documented. If it fails, revise assumptions before designing the CLI.

## v0.1 Protocol And CLI

Goal: specify and automate the proven publication and replication workflow without adding a resident service or UI.

- [ ] Define publisher identity, release identity, supported IPNS mapping, and version/freshness semantics.
- [ ] Specify deterministic encodings, validation limits, error behavior, and compatibility rules.
- [ ] Add normative valid and invalid fixtures for signed updates and imported content.
- [ ] Implement TypeScript protocol primitives without Kubo process or CLI dependencies.
- [ ] Implement CLI capabilities to publish, inspect, verify, resolve, recursively pin, and synchronize.
- [ ] Keep human output separate from stable machine-readable output.
- [ ] Run the hard MVP scenario through the CLI on two isolated replicas and two publisher machines.
- [ ] Publish operator documentation for keys, local Kubo RPC boundaries, recovery, and cleanup.

Exit gate: protocol fixtures are reproducible, the CLI completes the hard MVP, and no central gateway, resolver, coordinator, or pinning service is required.

## v0.2 Headless Replicator

Goal: allow a volunteer operator to maintain selected sites without interactive CLI polling.

- [ ] Define explicit subscription, retention, update, retry, and resource-limit policy.
- [ ] Implement a headless TypeScript process that resolves, validates, recursively pins, and synchronizes.
- [ ] Make restarts and interrupted synchronization safe without requiring SQLite.
- [ ] Provide structured local logs without telemetry or published private data.
- [ ] Test stale, invalid, unavailable, oversized, and partially transferred releases.
- [ ] Demonstrate unattended v1-to-v2 synchronization on both replicas.

Exit gate: a replica can run unattended with bounded resources and recover safely from interruption. Its failure does not affect publishers or other replicas.

## v0.3 Linux Desktop MVP

Goal: package the proven headless behavior for a Linux operator.

- [ ] Pass a packaging ADR covering Tauri, update trust, process ownership, and Kubo distribution.
- [ ] Build a minimal Tauri shell around the TypeScript application behavior.
- [ ] Use Rust only for shell integration and Kubo sidecar lifecycle.
- [ ] Keep Kubo RPC private and inaccessible to remote hosts and rendered web content.
- [ ] Expose replica status and explicit operator actions without introducing a hosted dashboard.
- [ ] Verify install, first run, restart, update, and uninstall on supported Linux targets.

Exit gate: the desktop package adds no protocol fork, hidden central service, or unsafe RPC exposure.

## v0.4 GitHub Action And Documentation

Goal: make static publication reproducible in CI after the CLI and key model are stable.

- [ ] Pass an ADR for CI key custody, least privilege, logs, and failure recovery.
- [ ] Provide a GitHub Action workflow that consumes an already-built static directory.
- [ ] Do not add framework detection or general build automation.
- [ ] Prevent secrets, private keys, and sensitive paths from appearing in logs or artifacts.
- [ ] Publish end-to-end publisher, replica, migration, and troubleshooting guides.
- [ ] Test the documented workflow in a disposable repository and identity.

Exit gate: CI publication is optional, reproducible, and no more trusted than local publication.

## v0.5 Conditional Hardening

Goal: address measured operational needs without weakening the original architecture.

- [ ] **CONDITIONAL:** add SQLite only if file-based state is shown to be insufficient and migration/backup behavior is designed.
- [ ] **CONDITIONAL:** add local metrics only after a privacy review, with no remote telemetry by default.
- [ ] **CONDITIONAL:** add DNSLink only if its DNS trust, freshness, and operational value are documented.
- [ ] **CONDITIONAL:** add key rotation only after recovery, revocation, rollback, and compatibility semantics are specified.
- [ ] **CONDITIONAL:** add framework detection or build helpers only for demonstrated publisher demand and outside the core protocol.
- [ ] Perform resource exhaustion, fuzzing, malformed graph, rollback, and long-running replica tests.
- [ ] Define compatibility and deprecation policy from observed protocol evolution.

Exit gate: each conditional feature has independent evidence, an accepted ADR, and a safe migration path. Features may remain omitted indefinitely.

## Explicitly Out Of Scope

- Anonymity, traffic obfuscation, or protection from peer/network metadata exposure.
- Guaranteed permanence, indestructibility, universal availability, or deletion from IPFS.
- Blockchain, cryptocurrency, token incentives, proof-of-storage, or distributed consensus ledgers.
- Dynamic applications, server-side execution, databases for hosted sites, or arbitrary containers.
- A required Meshkeep cloud, gateway, directory, coordinator, account system, or hosted control plane.
- Content moderation adjudication or an abuse-reporting service in the MVP.
- A canonical domain or same-origin guarantee across replicas.
- Mobile, macOS, and Windows desktop applications before the Linux MVP is proven.
- Dashboard, framework detection, build automation, Tauri, SQLite, metrics, DNSLink, and key rotation in the current phase.

## Decision Gates

1. **Manual proof to protocol:** confirm deterministic import, recursive availability, IPNS update behavior, key transfer, and alternative-URL serving.
2. **Protocol to headless service:** freeze v0.1 compatibility and validation rules; demonstrate safe repeated synchronization and bounded graph handling.
3. **Headless service to desktop:** prove unattended operation first; approve sidecar lifecycle and desktop update trust in an ADR.
4. **CLI to GitHub Action:** stabilize non-interactive output and error semantics; approve CI key custody before workflow implementation.
5. **Any conditional hardening:** require observed need, privacy/security review, migration design, and an accepted ADR.
6. **Any new network or naming protocol:** show why Kubo/IPFS/IPNS cannot satisfy a verified requirement and how interoperability remains testable.

## Progress Log

- 2026-07-18: Git repository initialization observed.
- 2026-07-18: Initial project, contribution, conduct, security, architecture, threat model, privacy, roadmap, and MVP scope documentation created.
- 2026-07-18: Technical baseline verified: pnpm workspace on Node.js 22; Biome, TypeScript, Vitest, and tsup configuration; initial protocol and CLI packages; draft schema; demo fixture; CI; frozen-lockfile installation; and `pnpm check` passing with 3 tests. No publication, replication, protocol, Kubo, or lab milestone is complete.
- 2026-07-21: Immutable-CID Kubo lab passed with Kubo 0.42.0 pinned by digest. Three disposable repos applied `unixfs-v1-2025`; two replicas matched complete 8-block v1/v2 graphs and file checksums after origin shutdown; v1 remained retained after v2. The network was Docker-internal with no host ports/bootstrap/telemetry, and cleanup was verified. IPNS, signatures, key transfer, and independent machines remain unproven, so the hard MVP is still open.
