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

- `@meshkeep/protocol`: the CLI TypeScript development condition resolves shipped types from `protocol/src/index.ts`; development and normal runtime imports use `protocol/dist/index.js`, while normal types use `protocol/dist/index.d.ts`.
- `@meshkeep/cli`: the package root export points to `cli/dist/index.js` with declarations at `cli/dist/index.d.ts`; the `meshkeep` binary launches the separately built `cli/dist/bin.js`.
- The protocol builds `src/index.ts` and packages `dist/` plus that exact source type entry; the CLI builds side-effect-free `src/index.ts` plus unguarded `src/bin.ts` and packages only `dist/`.

The protocol entry point currently exports literals and TypeScript manifest interfaces. The importable CLI entry point exposes program construction and execution helpers without parsing arguments; only the dedicated executable entry calls `runCli`.

## Build, test, and typecheck integration

The root manifest delegates `build`, `test`, and `typecheck` recursively to workspace packages with `--if-present`. Both packages provide the same lifecycle shape:

- `build`: tsup emits package ESM and declarations; the CLI includes both `src/index.ts` and `src/bin.ts`
- `test`: `vitest run`, discovering colocated source tests
- `typecheck`: `tsc --project tsconfig.json --noEmit`

The root `check` runs Biome across the repository, workspace typechecking, tests, builds, and a packed/offline-installed artifact smoke test. Shared TypeScript, Vitest, tsup, Node typings, and Biome versions are owned by the root manifest; root and CLI engines require the tested `>=22.23.1 <23` line, `.node-version` pins Node 22.23.1, and the root `packageManager` pins pnpm 10.34.5. A narrow temporary override keeps tsup's esbuild dependency on 0.28.1.

## Architectural boundaries

- Protocol rules flow outward from `@meshkeep/protocol`; the CLI may orchestrate them but must not duplicate validation, canonicalization, naming, version ordering, or signature behavior.
- The protocol layer must not depend on CLI presentation, Kubo process management, replica policy, or UI code. Its behavior must remain deterministic and independent of wall-clock time, host paths, locale, gateway hostnames, and object insertion order.
- Kubo/IPFS owns content addressing, UnixFS storage, discovery, transfer, recursive pinning, gateways, and IPNS. Workspace packages must not replace those responsibilities or introduce a required Meshkeep-operated coordinator.
- Network, filesystem, manifest, and command inputs are untrusted and must be validated at their boundaries. TypeScript manifest shapes are not runtime validation.
- Machine-readable CLI output must remain stable and separate from diagnostics; importing the CLI must remain side-effect free.
- Protocol wire-format or trust changes require the repository's RFC/ADR, specification, fixture, compatibility, and test process rather than implementation-only changes.
