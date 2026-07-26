# `packages/`

## Workspace responsibility

`packages/` contains the TypeScript workspace packages that implement Meshkeep's current protocol and command-line surfaces. `pnpm-workspace.yaml` includes each direct child through `packages/*`; currently the workspace contains two private, ESM-only packages:

- [`protocol/`](protocol/codemap.md) (`@meshkeep/protocol`): protocol-owned constants and deployment-manifest types. This is the authority for protocol models and, as the implementation grows, canonical encoding, validation, naming, and signature semantics.
- [`cli/`](cli/codemap.md) (`@meshkeep/cli`): the `meshkeep` executable and importable CLI helpers. It owns command registration, local prerequisite reporting, orchestration, and human-readable output.

Source-level details are documented in the [`protocol/src/`](protocol/src/codemap.md) and [`cli/src/`](cli/src/codemap.md) maps.

## Dependency direction and flow

The dependency graph is one-way:

```text
@meshkeep/cli -> @meshkeep/protocol
```

The CLI declares `@meshkeep/protocol` through `workspace:*` and currently consumes its authoritative `VERSION` constant. Commander dispatches process or caller-provided arguments to CLI actions, which may consume protocol-owned data and send results to an injectable output writer. The protocol package has no workspace dependencies and must remain usable without the CLI. No package currently integrates a Kubo client, daemon manager, storage implementation, network service, or centralized fallback.

## Entry points

- `@meshkeep/protocol`: the package root export points type and development resolution at `protocol/src/index.ts` and normal ESM imports at `protocol/dist/index.js`.
- `@meshkeep/cli`: the package root export points to `cli/dist/index.js` with declarations at `cli/dist/index.d.ts`; the `meshkeep` binary also launches `cli/dist/index.js`.
- Both builds begin at `src/index.ts`, emit ESM JavaScript and declarations under `dist/`, and publish only `dist/` if packaging is enabled.

The protocol entry point currently exports literals and TypeScript manifest interfaces. The CLI entry point exposes program construction and execution helpers, and its direct-launch guard prevents imports from parsing process arguments.

## Build, test, and typecheck integration

The root manifest delegates `build`, `test`, and `typecheck` recursively to workspace packages with `--if-present`. Both packages provide the same lifecycle shape:

- `build`: `tsup src/index.ts --format esm --dts --clean`
- `test`: `vitest run`, discovering colocated source tests
- `typecheck`: `tsc --project tsconfig.json --noEmit`

The root `check` runs Biome across the repository, then workspace typechecking, tests, and builds. Shared TypeScript, Vitest, tsup, Node typings, and Biome versions are owned by the root manifest; Node 22 or newer and pnpm 10.30.3 are the declared repository toolchain.

## Architectural boundaries

- Protocol rules flow outward from `@meshkeep/protocol`; the CLI may orchestrate them but must not duplicate validation, canonicalization, naming, version ordering, or signature behavior.
- The protocol layer must not depend on CLI presentation, Kubo process management, replica policy, or UI code. Its behavior must remain deterministic and independent of wall-clock time, host paths, locale, gateway hostnames, and object insertion order.
- Kubo/IPFS owns content addressing, UnixFS storage, discovery, transfer, recursive pinning, gateways, and IPNS. Workspace packages must not replace those responsibilities or introduce a required Meshkeep-operated coordinator.
- Network, filesystem, manifest, and command inputs are untrusted and must be validated at their boundaries. TypeScript manifest shapes are not runtime validation.
- Machine-readable CLI output must remain stable and separate from diagnostics; importing the CLI must remain side-effect free.
- Protocol wire-format or trust changes require the repository's RFC/ADR, specification, fixture, compatibility, and test process rather than implementation-only changes.
