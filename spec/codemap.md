# spec/

## Normative responsibility

This directory owns Meshkeep's normative protocol artifacts: protocol text, JSON
Schemas, and deterministic interoperability fixtures. It defines wire-level
contracts; executable protocol behavior belongs in `packages/protocol/`, and
architecture, operations, and decisions belong in `docs/`.

The only protocol artifact currently present is
`manifest-v1.schema.json`. It is a JSON Schema Draft 2020-12 description of the
initial deployment-manifest shape. Its canonical schema identifier is
`https://meshkeep.dev/spec/manifest-v1.schema.json`.

## Manifest v1 fields and invariants

Every field below is required. The manifest and its nested `stats` object reject
additional properties.

| Field | Schema constraint | Intended role |
| --- | --- | --- |
| `schema` | Exactly the manifest v1 schema identifier | Selects this manifest shape and version. |
| `siteId` | Non-empty string | Identifies the site described by the deployment. The draft does not define a more specific encoding. |
| `sequence` | Integer greater than or equal to zero | Carries deployment ordering metadata. Cross-record ordering and freshness rules are not yet specified. |
| `contentCid` | Non-empty string | Names the immutable content root. The schema does not validate CID syntax or UnixFS graph completeness. |
| `previousManifestCid` | Non-empty string or `null` | Optionally links to a previous manifest. The schema does not constrain this value relative to `sequence`. |
| `createdAt` | String with JSON Schema `date-time` format | Records creation time. Consumers must use a validator that actually enforces the format when validation is required. |
| `unixfsProfile` | Exactly `unixfs-v1-2025` | Pins the supported deterministic UnixFS import profile. |
| `stats.files` | Integer greater than or equal to zero | Descriptive file count. |
| `stats.bytes` | Integer greater than or equal to zero | Descriptive byte count. |

The schema validates structure and these local constraints only. It does not
prove that identifiers are valid CIDs or IPNS names, that statistics match the
reachable graph, that the graph is complete, that timestamps or sequences are
fresh, or that a publisher authorized the record.

## Consumers and integration

- `packages/protocol/` is the TypeScript owner of runtime parsing, validation,
  canonical processing, compatibility, update ordering, identity checks, and
  signature semantics as those rules are specified. It should consume this
  contract rather than redefine it.
- `packages/cli/` may orchestrate protocol operations and Kubo, but must call
  the protocol package for validation and signature rules rather than
  duplicating schema semantics.
- A future `packages/replicator/` may resolve and validate updates, fetch the
  selected graph, and verify recursive completeness using the same protocol
  implementation. It remains optional and is not a coordinator.
- Kubo/IPFS owns UnixFS import, content addressing, transfer, pinning, gateways,
  and signed IPNS records. This manifest is metadata around that workflow; it
  does not replace CID integrity, complete-graph verification, or IPNS update
  authority.

## Current draft status

`manifest-v1.schema.json` explicitly describes an **initial unsigned
manifest**. It is descriptive metadata, not an authority or an authenticated
release record. Signature semantics, canonical signing input, supported IPNS
mapping, freshness and rollback handling, compatibility, validation limits,
and canonical evidence remain future protocol decisions. A signed manifest or
separate signature envelope is not approved without an ADR.

Consequently, the `v1` name identifies the current schema shape but does not
mean the broader v0.1 protocol is complete. Unknown protocol versions and
unsupported import profiles must fail explicitly rather than being accepted by
fallback.

## Implementation alignment

`packages/protocol/src/index.ts` currently mirrors the schema with
`DeploymentManifestV1` and `DeploymentStatsV1`, plus exact `SCHEMA_ID` and
`UNIXFS_PROFILE` constants. The property names, required TypeScript members,
string-or-null previous link, and literal constants align with the JSON Schema.

That package is still a `0.0.0` scaffold. Its interfaces do not provide runtime
validation and cannot enforce JSON Schema constraints such as integer values,
non-negative values, non-empty strings, `date-time`, or rejection of extra
properties at an untrusted boundary. No canonical encoder, manifest signature
rules, or semantic CID/sequence/graph checks are implemented by the current
type declarations. The schema remains the wire-shape reference; implementation
agreement alone does not make unspecified behavior normative.

## Protocol-change governance

Any change to this schema or to wire formats, canonical encoding, signing
input, key identity, version ordering, IPNS mapping, UnixFS import behavior,
compatibility, or trust assumptions requires all of the following:

1. An issue or RFC describing the problem and alternatives.
2. An ADR in `docs/adr/` recording the decision and migration impact.
3. Updated normative specification and deterministic interoperability
   fixtures.
4. Compatibility and downgrade analysis.
5. Tests for valid and invalid behavior across implementations where
   applicable.

Do not derive or merge a protocol change solely from matching TypeScript
behavior. Every normative encoding needs an interoperability fixture, and
validation, canonicalization, signature, and failure paths require tests.
