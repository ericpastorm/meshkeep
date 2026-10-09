# AGENTS.md

Guidance for automated contributors working in this repository.

## Mission

Meshkeep lets anyone publish a static website under a free, key-based address (an IPNS name) and lets volunteer replicas keep it reachable without the publisher, like torrent seeders. People reach sites through petnames in their own address book. There are no servers to rent, no registrars, no blockchain, and no Meshkeep service on the critical path. [ADR 0002](docs/adr/0002-resilient-sites-and-address-book.md) records the decisions; [ROADMAP.md](ROADMAP.md) records the phases.

Be honest about limits: Meshkeep is not anonymous, does not guarantee permanence or deletion, and cannot stop network-level blocking of IPFS.

## Layout

- `packages/protocol/`: addresses, key encoding, petnames, the address book, and policy constants. Pure TypeScript with no Node-only APIs, because the browser extension will reuse it. No Kubo or CLI code.
- `packages/kubo/`: the narrow Kubo RPC client. No business rules.
- `packages/cli/`: commands, local state (keystore, address book, replica state), and the publish and replicate workflows. Do not duplicate protocol rules here.
- `spec/`: normative rules, the JSON schema, and fixtures. Fixtures are the interoperability contract.
- `tests/integration/`: Docker-based private Kubo network and lifecycle tests.
- `docs/`: architecture, threat model, privacy, ADRs.

Read [codemap.md](codemap.md) for the data flow before larger changes.

## Commands

```sh
pnpm install
pnpm check              # biome, typecheck, unit tests, build, CLI smoke
pnpm test:integration   # needs Docker; Kubo 0.42.0 pinned by digest
pnpm format             # rewrites files; review the diff
```

Run `pnpm check` before calling a change done. Run `pnpm test:integration` when you touch `packages/kubo`, the workflows, or anything Kubo-facing. If Docker is unavailable, say so rather than claiming it passed.

## Rules

- Keep changes small and in scope. Re-read files before editing; other work may be in progress.
- Validate untrusted input (network responses, records, files, address books, CLI arguments) at the boundary, and fail closed.
- Protocol behavior must be deterministic: no dependence on wall-clock time, host paths, locale, or key insertion order.
- Keep `--json` output stable and on stdout, and send diagnostics to stderr.
- Never fall back silently to a public gateway, resolver, pinning service, or telemetry endpoint.
- Kubo RPC stays on loopback. Never expose it to the network or to web content.
- Never commit, log, or print private keys, tokens, or real user content. Tests use generated keys or the disposable fixture key in `spec/fixtures/keys/`.
- Do not add dependencies without a reason. Prefer the platform and existing dependencies.

## Decisions

Changes to a format, address derivation, signing input, record ordering, or trust assumptions need a short ADR in `docs/adr/`, updated `spec/README.md`, and updated fixtures. New format versions get new `format` strings, and readers reject versions they do not know.

## Testing

- Unit tests sit next to the code (`*.test.ts`). Cover validation, encoding, and failure paths.
- Integration tests use isolated containers with a private swarm key, never public peers or gateways, and must clean up after themselves.
- Check complete-graph retention, not just root pins.

## Repository Discipline

- Do not commit unless asked. Never rewrite or discard work you did not create.
- Update ROADMAP.md only for verified milestones, with a dated progress-log entry.
