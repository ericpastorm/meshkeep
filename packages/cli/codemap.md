# `packages/cli/`

## Responsibility

Owns the `meshkeep` command-line surface: Commander wiring, local prerequisite reporting, orchestration, and human-readable output. Protocol rules remain in `@meshkeep/protocol`; this package must not duplicate canonicalization, validation, naming, or signature semantics.

## Package entry points and lifecycle

- `package.json` maps the package export to `dist/index.js` and the `meshkeep` executable to `dist/bin.js`; declarations are emitted under `dist/`.
- `tsup` builds `src/index.ts` and `src/bin.ts`; TypeScript checks `src/**/*.ts`, and Vitest runs the colocated tests.
- `src/index.ts` constructs Commander programs and exports parsing helpers without launch-time side effects. The dedicated unguarded `src/bin.ts` entry calls `runCli`, so direct and package-manager-symlink execution follow the same path.
- `tsconfig.json` alone activates protocol development types; `vitest.config.ts` aliases protocol source only for CLI tests. Production tsup builds retain the package dependency.

## Dependencies

- `commander`: command registration and asynchronous argv parsing.
- `@meshkeep/protocol`: authoritative Meshkeep `VERSION` value.
- Node.js: process/runtime information and executable startup. Root and CLI engines require the tested stable `>=22.23.1 <23` line, which `doctor` also enforces.

No Kubo client, process manager, storage layer, network service, or centralized fallback is integrated.

## Data and control flow

`process.argv` (or caller-supplied argv) → Commander dispatch → command action → protocol/runtime data → injected command-output writer. Tests inject argv, Node versions, writers, and exit-code setters to keep command behavior deterministic and observable without mutating process status.

## Implemented versus planned

Implemented: version reporting and a local-only `doctor` report for Node support plus an explicit Kubo-not-configured placeholder. Publishing, resolving, pinning, replication, Kubo lifecycle/configuration, and external health checks are not implemented here.

## Invariants

- Importing the package must not execute the CLI.
- Direct and package-manager-symlink executable paths must both invoke the unguarded bin entry.
- Custom command output is injectable; machine-readable output must remain separate from diagnostics as new commands arrive.
- `doctor` does not start processes or perform network/external checks.
- An unsupported `doctor` runtime reports failure through the injected or process exit-code setter.
- Protocol constants and rules come from `@meshkeep/protocol`, not CLI reimplementations.
