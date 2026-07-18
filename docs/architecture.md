# Architecture

Status: pre-alpha design baseline. This document describes the intended MVP boundaries, not an implemented system.

## Goal

Meshkeep publishes a static website as immutable, content-addressed data and enables independently operated replicas to retain the complete version after the publishing origin goes offline.

The MVP optimizes for a narrow claim:

1. A publisher controls signed updates for a site identity.
2. Each published version has an immutable UnixFS root CID.
3. Two volunteer replicas can independently preserve and serve the complete version.
4. A second machine holding the same publishing key can publish the next version.

Meshkeep does not provide anonymity, guaranteed permanence, deletion, dynamic application hosting, or a canonical HTTP origin.

## Terms

The normative MVP terms are established in [ADR 0001](adr/0001-mvp-scope.md):

- **Publisher:** the actor or tool authorized by the site's private publishing key.
- **Origin:** the Kubo node used to import and initially announce a version. It is a transport role, not the authority or a permanent dependency.
- **Replica:** an independently operated Kubo node that elects to resolve, validate, fetch, and retain a site's complete version.

## System Model

```text
static directory
      |
      v
publisher CLI ---- private local RPC ---- Kubo origin
      |                                      |
      | signed IPNS update                   | IPFS blocks/providers
      v                                      v
site identity                         volunteer Kubo replicas
                                             |
                                             v
                                  replica-local IPFS gateway
```

Kubo owns IPFS networking, block exchange, UnixFS, pinning, gateway serving, and IPNS record handling. Meshkeep owns workflow policy, input validation, deterministic profile selection, update verification, complete-graph checks, and operator-facing evidence.

No Meshkeep gateway, directory, coordinator, pinning service, or account system is on the required path.

## Content And Identity

### Immutable version

A static directory is imported as UnixFS using the `unixfs-v1-2025` profile. The resulting root CID identifies the version and commits to the reachable bytes and links. Changing content produces a different version CID.

A root CID is not evidence that every block is locally retained. A replica must fetch and verify the complete reachable graph before reporting the version as available.

### Mutable site identity

An IPNS name provides the stable site identity. Its signed record selects an immutable version CID. For the MVP, the authenticity claim is the combination of:

- the IPNS record signature proving authority over the update; and
- the CID integrity checks proving the retrieved graph matches the selected version.

The repository includes a draft unsigned deployment manifest for descriptive metadata. It is not an authority or an authenticated release record. The v0.1 protocol work must define supported record mapping, freshness/version ordering, validation limits, and evidence. Signing that manifest or adding another signature envelope is not assumed until an ADR specifies its need and canonical encoding.

### Optional CAR transport

A CAR file may transfer the same content graph when direct exchange is inconvenient. Importing it must preserve the expected root CID and must not bypass update validation or complete-graph verification.

## Publication Flow

1. Validate that the input is a static directory and exclude secrets by explicit operator review; framework builds are outside the MVP.
2. Import the directory through Kubo using the fixed UnixFS profile.
3. Record the immutable root CID and verify the complete local graph.
4. Publish a signed IPNS update that selects that CID.
5. Provide machine-readable identity and version evidence to replica operators.
6. Keep the origin online only long enough for replicas to fetch and verify every reachable block.

The publisher key is the authority for future updates. It is not content, must never be placed in the published graph, and must be transferable independently of the origin's block store.

## Replication Flow

1. A replica operator explicitly selects an IPNS identity to retain.
2. The replica resolves and validates the signed IPNS update under bounded resource and timeout policy.
3. It obtains the selected immutable root CID and rejects unsupported or ambiguous behavior.
4. Kubo fetches the graph from any available providers, including but not limited to the origin.
5. Meshkeep verifies complete recursive availability before reporting success.
6. The replica pins the version according to its local retention policy and serves it through its own gateway.
7. On a later valid update, the replica synchronizes the new CID without treating an incomplete transfer as current.

The exact atomicity, retry, and retention rules belong to v0.2. The manual proof and v0.1 CLI must still distinguish resolved, fetching, complete, and failed states.

## Access Model

A retained version may be accessed through a replica-local CID or IPNS gateway URL, including path-style or subdomain-style forms supported by that Kubo deployment. URLs can differ across replicas and may represent different browser origins.

Meshkeep verifies version identity, not hostname equality. DNSLink, a shared public gateway, TLS/domain automation, and same-origin preservation are outside the MVP.

## Component Boundaries

### Protocol package

The current TypeScript scaffold defines initial types and constants. This package is intended to own canonical processing, validation, version/freshness rules, and identity checks. It has no CLI formatting, UI, or Kubo process-management responsibilities.

### CLI package

The current CLI scaffold exposes version and prerequisite-report behavior only. Its target role is to orchestrate publication, inspection, verification, recursive pinning, and synchronization through a narrow Kubo adapter while keeping stable machine output separate from diagnostics.

### Headless replicator

Deferred to v0.2. It applies explicit subscription, retention, retry, and resource policy using the same protocol implementation. It is optional and never a network coordinator.

### Desktop shell

Deferred to v0.3. A Linux Tauri application may own local process lifecycle and packaging. Rust must not become a second protocol implementation. Kubo RPC stays private to the application boundary.

## Failure And Trust Boundaries

- Publisher-key compromise permits unauthorized future updates; content CIDs do not prevent this.
- A malicious or stale gateway can misrepresent IPNS freshness. Verification must not rely only on rendered HTTP output.
- A replica may refuse, lose, or remove content. Two replicas reduce a single operator dependency but do not guarantee availability.
- IPFS and IPNS routing can be delayed, partitioned, observed, or unavailable.
- Static content can itself be malicious. Meshkeep authenticates bytes and update authority, not safety or legality.
- Kubo RPC is privileged. It must bind to loopback or an equivalent private boundary and must not be reachable by hosted content.

See [Threat Model](threat-model.md) and [Privacy](privacy.md).

## Deferred Decisions

Dashboard, framework detection, build automation, Tauri, SQLite, metrics, DNSLink, key rotation, and additional network protocols are not part of the current protocol/CLI/manual-lab phase. Each requires the roadmap gate and, where architecture or trust changes, an ADR.
