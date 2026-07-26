# `packages/cli/src/`

## Files and responsibility

- `index.ts`: executable/library entry point, public CLI helpers, Commander assembly, and direct-launch guard.
- `index.test.ts`: unit coverage for injected `version` output and deterministic `doctor` reporting.

## Commander lifecycle and entry points

1. `createProgram(options)` creates a new `Command`, applies the `meshkeep` name, description, and protocol-owned version, then registers `version` and `doctor` actions.
2. Callers may parse the returned program directly; `runCli(argv = process.argv)` is the production wrapper and awaits `parseAsync`.
3. The `import.meta.url`/`pathToFileURL(process.argv[1])` comparison calls `runCli()` only when those paths match. Library imports expose helpers without consuming argv, but the raw comparison does not resolve symlinks and can make an installed bin invocation exit without parsing arguments.

The explicit `version` subcommand is distinct from Commander's built-in `--version` option. The subcommand uses the injected writer; Commander retains control of its own help, option-version, and error output.

## Output and data flow

- `CliOptions.write` defaults to `console.log` and is captured by command actions; tests replace it with an array sink.
- `CliOptions.nodeVersion` defaults to `process.versions.node` and is captured when the program is created.
- `doctor` calls `getDoctorReport(nodeVersion)` and writes each returned line in order.
- `getDoctorReport` parses the leading dotted-version component, accepts integer majors at least `MINIMUM_NODE_MAJOR` (`22`), and returns both `nodeSupported` and immutable-by-type output lines. Unsupported or malformed versions are reported but do not currently change exit status.

## Dependencies and boundaries

`VERSION` comes from `@meshkeep/protocol`; `Command` comes from Commander; `pathToFileURL` is the only Node utility import. There is no Kubo invocation, filesystem mutation, network access, protocol validation, publishing, or replication implementation. The Kubo line is deliberately a placeholder for planned CLI orchestration.

## Invariants

- Construct a fresh program per `createProgram` call; do not share mutable Commander state.
- Keep direct execution guarded and `runCli` asynchronous.
- Route custom action output through `write` so tests and embedders need not patch globals.
- Keep prerequisite reporting side-effect free and free of external checks until explicit Kubo integration exists.
- Consume protocol authority through `@meshkeep/protocol`; do not reproduce protocol rules in this package.
