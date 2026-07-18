# AGENTS.md

Operational guidance for automated contributors working in this repository.

## Mission

Meshkeep is open-source peer-to-peer hosting and replication for static websites. It publishes an immutable static version through a signed name update and lets independently operated replicas preserve the complete content graph.

The honest promise is limited: a publisher can go offline after publication while willing, connected replicas continue to retain and serve that version.

Meshkeep does not promise anonymity, censorship resistance, permanent availability, deletion from the network, or a canonical HTTP origin. It does not use a blockchain.

## Current Phase

The current focus is the protocol, CLI, and a reproducible manual Kubo lab. The hard MVP is defined in [ROADMAP.md](ROADMAP.md).

Do not add a dashboard, framework detection, build automation, Tauri, SQLite, metrics, DNSLink, or key rotation unless the roadmap phase and a recorded decision explicitly authorize it.

## Architecture Boundaries

- Kubo/IPFS provides content addressing, UnixFS storage, peer discovery, transfer, pinning, gateways, and IPNS.
- Use the `unixfs-v1-2025` import profile. A CAR file may transport the same graph but must not define a different release identity.
- TypeScript owns the protocol model, CLI, and any future UI.
- Rust is deferred to a future Tauri shell and Kubo sidecar lifecycle only. Do not duplicate protocol rules in Rust.
- The protocol layer must not depend on CLI presentation, Kubo process management, or a UI.
- The CLI may orchestrate protocol and Kubo adapters but must not reimplement validation or signature rules.
- A future replicator may resolve, validate, recursively pin, and synchronize. It must not become a required coordinator.
- The publishing origin is disposable after propagation. No Meshkeep-operated service may be required to resolve or retrieve a published version.

## Directory Ownership

These are the intended ownership boundaries as the repository is populated:

- `packages/protocol/`: protocol types, canonical encoding, validation, naming, and signature semantics. No CLI or daemon concerns.
- `packages/cli/`: commands, local configuration, orchestration, and human-readable output. No duplicated protocol rules.
- `packages/replicator/`: future headless replica policy and lifecycle. No desktop UI.
- `apps/desktop/`: future Linux desktop shell only after the v0.3 gate.
- `spec/`: normative protocol text, schemas, and interoperability fixtures.
- `examples/`: non-normative examples and lab fixtures.
- `docs/`: architecture, operations, privacy, threats, and ADRs.

Before editing, inspect the current tree and package-local instructions. Do not change files outside the assigned task, even to fix nearby issues. Concurrent work may add files while an agent is active; re-read relevant files before editing and never overwrite unrelated changes.

## Commands

Use repository scripts when their manifests exist:

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format
pnpm check
```

`pnpm check` is the expected aggregate CI validation. `pnpm format` may modify files; inspect its diff. If a script or manifest has not landed, report it as unavailable rather than inventing configuration or claiming it passed.

## Code And Style Rules

- Prefer the smallest change that satisfies the current roadmap item.
- Keep protocol behavior deterministic and independent of wall-clock time, host paths, locale, gateway hostname, and object key insertion order.
- Validate all untrusted network, filesystem, manifest, and command input at its boundary.
- Keep machine-readable output stable and separate it from diagnostics.
- Do not silently fall back to a centralized gateway, resolver, pinning service, telemetry collector, or update service.
- Do not introduce another storage, naming, discovery, or transport protocol without an accepted ADR.
- Do not add blockchain, token, cryptocurrency, or consensus-ledger dependencies.
- Follow existing formatter, linter, TypeScript strictness, and package conventions once present. Do not weaken checks to make a change pass.

## Testing Rules

- Add unit tests for validation, canonicalization, signatures, and failure paths.
- Add interoperability fixtures for every normative protocol encoding.
- Integration tests that use Kubo must use isolated repositories and must not depend on public gateways or a specific public peer.
- Test recursive completeness, not only root-CID pinning.
- Test publisher shutdown, stale updates, invalid signatures, missing blocks, and interrupted synchronization where relevant.
- Never mark a roadmap acceptance item complete without reproducible evidence from the stated environment.

## Security Rules

- Never commit, log, print, fixture, or transmit private keys, seed phrases, tokens, credentials, or real user content.
- Use generated disposable keys and content in tests.
- Treat publisher keys as the authority for mutable updates. Fail closed on invalid signatures, malformed records, and ambiguous versions.
- Bind Kubo RPC to loopback or an equivalent private boundary. Never expose it to the public network or browser content.
- Do not pass untrusted values through a shell. Constrain paths, archive extraction, resource use, and content graph traversal.
- Gateways and replicas are untrusted for freshness and availability. Content addressing detects changed bytes; it does not prove freshness or benign content.
- Follow [SECURITY.md](SECURITY.md) for reporting. Do not place vulnerability details in public issues.

## Protocol Changes

Any change to wire formats, canonical encoding, signing input, key identity, version ordering, IPNS mapping, UnixFS import behavior, compatibility, or trust assumptions requires:

1. An issue or RFC describing the problem and alternatives.
2. An ADR in `docs/adr/` for the decision and migration impact.
3. Updated normative specification and deterministic fixtures.
4. Compatibility and downgrade analysis.
5. Tests proving valid and invalid behavior across implementations where applicable.

Do not merge a protocol change based only on matching implementation behavior. Unknown protocol versions and unsupported profiles must fail explicitly.

## Repository Discipline

- Do not commit unless the user explicitly asks for a commit.
- Do not amend, rewrite, or discard work you did not create.
- Keep dependency additions justified and scoped. Prefer platform and existing dependency capabilities.
- Update [ROADMAP.md](ROADMAP.md) when, and only when, a tracked milestone has been implemented and verified. Add dated evidence to the progress log.

## Definition Of Done

A change is done when its scoped behavior is implemented, relevant tests and fixtures pass, `pnpm check` passes when available, security and privacy effects are addressed, user-facing and protocol documentation agree with behavior, no central dependency or scope expansion was introduced, and any completed roadmap item has reproducible evidence recorded. Report unavailable checks and residual risks explicitly.
