# Repository Atlas: Meshkeep

## Project responsibility

Meshkeep is a pre-alpha peer-to-peer static-site publication and replication project. Its
bounded goal is to publish immutable UnixFS content through a signed mutable name and let
independently operated replicas retain and serve complete versions after the publisher goes
offline. Kubo/IPFS owns content addressing, UnixFS storage, transfer, discovery, recursive
pinning, gateways, and IPNS; Meshkeep owns the protocol model, validation and trust rules,
operator CLI, and future replica policy.

The current repository is an architecture-validation scaffold rather than a working publisher
or replicator. It contains protocol types and constants, a minimal CLI, a draft unsigned manifest
schema, and a reproducible one-host Kubo lab for the immutable-content subset. Signed IPNS
updates, key transfer, runtime protocol validation, synchronization, independent-host proof, a
replicator, and a desktop application are not implemented.

## System entry points

- `packages/protocol/src/index.ts`: public protocol constants and compile-time manifest models.
- `packages/cli/src/index.ts`: side-effect-free, importable CLI assembly and public helpers.
- `packages/cli/src/bin.ts`: unguarded `meshkeep` executable entry point.
- `examples/lab/run-lab.sh`: manual Docker/Kubo integration workflow and evidence generator.
- `spec/manifest-v1.schema.json`: draft structural contract for an unsigned deployment manifest.
- `package.json`: workspace scripts, toolchain versions, and aggregate `pnpm check` pipeline.
- `scripts/smoke-artifacts.mjs`: built and packed/offline-installed package release-path smoke test.
- `.github/workflows/ci.yml`: Node/pnpm CI installation and aggregate workspace validation.
- `ROADMAP.md`: hard-MVP gates, phase ordering, acceptance criteria, and progress evidence.
- `AGENTS.md`: repository-wide architecture, security, testing, and protocol-change rules.

## Architecture and dependency direction

```text
specification ──> @meshkeep/protocol ──> @meshkeep/cli
       │                    │                    │
       └──── protocol truth ┴── no Kubo yet ───┘

fixture bytes + pinned Kubo platform/index/import profile
       └──> examples/lab/run-lab.sh ──> CIDs, recursive pins, verified cleanup, and bounded evidence
```

- Protocol rules flow outward from `spec/` and `@meshkeep/protocol`; presentation and
  orchestration layers must not reimplement them.
- The current Kubo lab is deliberately standalone and does not exercise the TypeScript protocol
  or CLI packages. It proves deterministic import, complete recursive retention, and
  origin-offline reads only.
- No Meshkeep-operated gateway, resolver, pinning service, telemetry collector, coordinator, or
  canonical HTTP origin participates in correctness.
- Wire formats, signing inputs, identity, ordering, IPNS mapping, compatibility, and trust changes
  require an issue/RFC, ADR, normative specification and fixtures, downgrade analysis, and tests.

## Repository directory map

| Directory | Responsibility | Detailed map |
| --- | --- | --- |
| `packages/` | TypeScript workspace containing the protocol authority and CLI orchestration surface. | [packages/codemap.md](packages/codemap.md) |
| `packages/protocol/` | Protocol constants, manifest types, and the future home of deterministic runtime validation, canonicalization, naming, and signatures. | [packages/protocol/codemap.md](packages/protocol/codemap.md) |
| `packages/protocol/src/` | Exact public protocol exports and colocated unit-test context. | [packages/protocol/src/codemap.md](packages/protocol/src/codemap.md) |
| `packages/cli/` | Commander-based executable/package boundary and local orchestration policy. | [packages/cli/codemap.md](packages/cli/codemap.md) |
| `packages/cli/src/` | Side-effect-free CLI construction plus the dedicated executable entry module. | [packages/cli/src/codemap.md](packages/cli/src/codemap.md) |
| `spec/` | Draft and future normative schemas, protocol text, and interoperability fixtures. | [spec/codemap.md](spec/codemap.md) |
| `examples/` | Non-normative demo bytes, deterministic lab fixtures, and manual integration assets. | [examples/codemap.md](examples/codemap.md) |
| `examples/lab/` | Hardened one-host Docker/Kubo workflow, pinned expectations, and recorded evidence. | [examples/lab/codemap.md](examples/lab/codemap.md) |

Supporting areas without separate codemaps:

- `docs/`: architecture, threat model, privacy guidance, and accepted ADRs.
- `.github/workflows/`: CI orchestration.
- `examples/lab-fixtures/`: identity-bearing fixture bytes; changes affect hashes and CIDs.
- `examples/lab/results/`: generated evidence snapshots, not protocol truth.

## Build and verification flow

The pnpm workspace includes `packages/*`. Both packages use strict NodeNext TypeScript, tsup for
ESM/declaration builds, and Vitest for colocated tests. Root commands delegate recursively:

```text
pnpm check
  ├── biome check .
  ├── pnpm typecheck
  ├── pnpm test
  ├── pnpm build
  └── pnpm smoke:artifacts
```

The Docker/Kubo lab is manual and is not part of `pnpm check` or pull-request CI. Its result v2 is
made atomically visible with `os.replace` only after status-preserving global/name/label queries
verify captured resources and the temporary root absent. It records sanitized input/environment
provenance without expanding the lab's claim. Generated
`dist/`, dependency directories, and lab results are not source entry points. The hard MVP is not
complete until signed-name continuity, key migration, independent environments, complete graph
retention, origin shutdown, gateway access, and required negative paths have reproducible evidence.

## Repository invariants

- Keep protocol behavior deterministic and independent of wall-clock time, locale, host paths,
  gateway hostnames, and object insertion order.
- Validate all network, filesystem, manifest, and command input at its boundary; TypeScript types
  alone are not runtime validation.
- Fail closed on malformed or unsupported protocol data, ambiguous versions, invalid signatures,
  stale updates, missing blocks, and incomplete graphs.
- Keep Kubo RPC private and never silently fall back to a public centralized service.
- Do not add deferred UI, desktop, storage, metrics, DNSLink, key-rotation, or build-automation
  scope without the roadmap gate and a recorded decision.
