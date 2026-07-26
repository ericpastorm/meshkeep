# `packages/protocol/src/`

## Responsibility

Source and colocated unit tests for the public `@meshkeep/protocol` API. At present, `index.ts` is both the complete implementation and the sole package entry point.

## Exact exports

`index.ts` exports:

- `VERSION = "0.0.0"` — runtime package/protocol implementation version literal.
- `SCHEMA_ID = "https://meshkeep.dev/spec/manifest-v1.schema.json"` — runtime v1 manifest schema literal.
- `UNIXFS_PROFILE = "unixfs-v1-2025"` — runtime required import-profile literal.
- `DeploymentStatsV1` — compile-time `{ files: number; bytes: number }` shape.
- `DeploymentManifestV1` — compile-time shape with `schema`, `siteId`, `sequence`, `contentCid`, `previousManifestCid`, `createdAt`, `unixfsProfile`, and `stats` fields. `schema` and `unixfsProfile` are tied to the exported literal types.

There are no default exports, functions, classes, validators, serializers, or internal submodule entry points.

## Data and control flow

Imports flow directly through `index.ts`; no state or side effects are created. Runtime consumers receive only the three constants. The two interfaces are erased during compilation and constrain callers only during TypeScript checking. `index.test.ts` imports the public symbols through `./index.js`, constructs a typed manifest, and asserts the version/schema/profile literals.

## Integration and boundaries

`tsup` bundles `index.ts` to `dist/index.js` and emits declarations; package export conditions expose source during type resolution/development and built output for normal ESM imports. Vitest discovers the colocated `index.test.ts`; TypeScript includes all source-tree `.ts` files.

The source currently models only an unsigned initial deployment manifest. It does not enforce CID format, RFC 3339 timestamps, non-negative/integer sequence or statistics, previous-manifest linkage, canonical key/byte encoding, signatures, freshness, or supported-version rejection. Those are planned protocol concerns and must not be assumed from structural typing.

## Important invariants

- Preserve the exact schema and UnixFS profile literals unless a protocol change is approved and reflected in specification, ADR, fixtures, compatibility analysis, and tests.
- Treat all manifest fields as untrusted at runtime until explicit validation exists; a TypeScript assertion is not validation.
- Keep protocol code independent of wall-clock behavior, host paths, locale, gateways, CLI output, Kubo process management, and UI concerns.
