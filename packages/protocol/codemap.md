# `packages/protocol/`

## Responsibility

`@meshkeep/protocol` is the TypeScript-owned protocol boundary. It is intended to hold wire-model types, canonical encoding, validation, naming, and signature semantics without depending on CLI presentation, Kubo lifecycle management, daemon policy, or UI code.

## Public entry point and exports

- Package subpath `@meshkeep/protocol` is the only declared export.
- The `development` condition resolves types to `src/index.ts` and runtime imports to `dist/index.js`; normal `types` and ESM `import` resolve to `dist/index.d.ts` and `dist/index.js`.
- `src/index.ts` exports runtime constants `VERSION`, `SCHEMA_ID`, and `UNIXFS_PROFILE`, plus TypeScript interfaces `DeploymentStatsV1` and `DeploymentManifestV1`.
- The package is private and ESM-only. Its artifact includes `dist/` plus only `src/index.ts` for development type resolution; tests and codemaps remain excluded.

## Data and control flow

There is currently no protocol execution pipeline. Consumers import constants and types, then construct or inspect manifest-shaped values themselves. This package does not yet parse, validate, canonicalize, sign, verify, resolve, publish, or fetch data; Kubo and CLI orchestration remain outside this boundary.

## Tooling integration

- `pnpm --filter @meshkeep/protocol build`: `tsup src/index.ts --format esm --dts --clean`, producing ESM JavaScript and declarations under `dist/`.
- `pnpm --filter @meshkeep/protocol test`: runs Vitest; `src/index.test.ts` checks the exported literals and demonstrates a typed initial manifest.
- `pnpm --filter @meshkeep/protocol typecheck`: runs `tsc --project tsconfig.json --noEmit`.
- `tsconfig.json` extends the repository base configuration, limits compilation to `src/**/*.ts`, and maps `src/` to `dist/` with Node and Vitest globals available.

## Implemented versus planned

Implemented: the package/version literal, manifest schema identifier, required UnixFS profile literal, and compile-time v1 deployment manifest/statistics shapes.

Planned but absent: runtime boundary validation, canonical encoding, naming/IPNS mapping, signature and verification semantics, version ordering, and interoperability fixtures. The current manifest is explicitly unsigned; signature semantics require a future ADR rather than inference from these types.

## Invariants

- Manifest `schema` is typed as exactly `SCHEMA_ID`; `unixfsProfile` is typed as exactly `UNIXFS_PROFILE` (`unixfs-v1-2025`).
- `previousManifestCid` is either a string or `null`; statistics contain numeric `files` and `bytes`.
- These are TypeScript constraints only. Strings, numbers, CID syntax, timestamps, sequence ordering, and statistics are not checked at runtime.
- Protocol behavior added here must remain deterministic and must not introduce a required centralized service or duplicate Kubo's storage, transport, discovery, pinning, gateway, or IPNS responsibilities.
