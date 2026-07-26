# `packages/cli/`

## Responsibility

Owns the `meshkeep` command-line surface: Commander wiring, local prerequisite reporting, orchestration, and human-readable output. Protocol rules remain in `@meshkeep/protocol`; this package must not duplicate canonicalization, validation, naming, or signature semantics.

## Package entry points and lifecycle

- `package.json` maps the `meshkeep` executable and package export to the ESM build at `dist/index.js`; declarations are emitted at `dist/index.d.ts`.
- `tsup` builds from `src/index.ts`; TypeScript checks `src/**/*.ts`, and Vitest runs the colocated tests.
- At runtime, `src/index.ts` constructs a fresh Commander `Command`, registers commands, and parses argv. Its direct-execution guard compares `import.meta.url` with `process.argv[1]`, so importing the package has no parse-time side effect. Because the comparison does not resolve symlinks, a package-manager bin symlink can currently suppress CLI execution.

## Dependencies

- `commander`: command registration and asynchronous argv parsing.
- `@meshkeep/protocol`: authoritative Meshkeep `VERSION` value.
- Node.js: process/runtime information and ESM entry-point detection. Node 22 is the declared runtime prerequisite checked by `doctor`.

No Kubo client, process manager, storage layer, network service, or centralized fallback is integrated.

## Data and control flow

`process.argv` (or caller-supplied argv) → Commander dispatch → command action → protocol/runtime data → injected command-output writer. Tests inject argv, Node versions, and a writer to keep command behavior deterministic and observable without subprocesses.

## Implemented versus planned

Implemented: version reporting and a local-only `doctor` report for Node support plus an explicit Kubo-not-configured placeholder. Publishing, resolving, pinning, replication, Kubo lifecycle/configuration, and external health checks are not implemented here.

## Invariants

- Importing the package must not execute the CLI.
- The direct-execution check must account for package-manager symlinks before this is a reliable installed binary.
- Custom command output is injectable; machine-readable output must remain separate from diagnostics as new commands arrive.
- `doctor` does not start processes or perform network/external checks.
- Protocol constants and rules come from `@meshkeep/protocol`, not CLI reimplementations.
