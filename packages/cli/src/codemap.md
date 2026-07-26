# `packages/cli/src/`

## Files and responsibility

- `index.ts`: side-effect-free library entry point, public CLI helpers, and Commander assembly.
- `bin.ts`: shebang-preserving executable entry that unconditionally awaits `runCli()`.
- `index.test.ts`: unit coverage for injected `version` output and strict deterministic `doctor` reporting.

## Commander lifecycle and entry points

1. `createProgram(options)` creates a new `Command`, applies the `meshkeep` name, description, and protocol-owned version, then registers `version` and `doctor` actions.
2. Callers may parse the returned program directly; `runCli(argv = process.argv)` is the production wrapper and awaits `parseAsync`.
3. `bin.ts` imports `runCli` and invokes it unconditionally. Library imports target `index.ts` and never consume argv, while direct and symlinked executable launches both target the dedicated bin module.

The explicit `version` subcommand is distinct from Commander's built-in `--version` option. The subcommand uses the injected writer; Commander retains control of its own help, option-version, and error output.

## Output and data flow

- `CliOptions.write` defaults to `console.log` and is captured by command actions; tests replace it with an array sink.
- `CliOptions.nodeVersion` defaults to `process.versions.node` and is captured when the program is created.
- `CliOptions.setExitCode` defaults to setting `process.exitCode`; tests inject a recorder instead of mutating global state.
- `doctor` calls `getDoctorReport(nodeVersion)`, writes each returned line in order, and sets exit code 1 when unsupported.
- `getDoctorReport` requires stable semantic version syntax and accepts only the tested `>=22.23.1 <23` line. It rejects lower Node 22 versions, prereleases, malformed strings, and untested majors; build metadata does not alter precedence.

## Dependencies and boundaries

`VERSION` comes from `@meshkeep/protocol`, and `Command` comes from Commander. There is no Kubo invocation, filesystem mutation, network access, protocol validation, publishing, or replication implementation. The Kubo line is deliberately a placeholder for planned CLI orchestration.

## Invariants

- Construct a fresh program per `createProgram` call; do not share mutable Commander state.
- Keep `index.ts` import-safe, the bin entry unguarded, and `runCli` asynchronous.
- Route custom action output through `write` so tests and embedders need not patch globals.
- Keep prerequisite reporting side-effect free and free of external checks until explicit Kubo integration exists.
- Consume protocol authority through `@meshkeep/protocol`; do not reproduce protocol rules in this package.
