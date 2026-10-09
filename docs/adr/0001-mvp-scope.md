# ADR 0001: MVP Scope And Node Roles

- Status: Superseded by [ADR 0002](0002-resilient-sites-and-address-book.md)
- Date: 2026-07-18
- Decision owners: Meshkeep maintainers

## Context

Meshkeep needs a testable definition of peer-to-peer static publication before its initial scaffolding becomes functional protocol behavior, a resident replicator, a desktop shell, or hosted automation. Terms such as publisher, origin, and replica can otherwise imply a traditional web server or a permanent coordinator. Web access also needs an honest success criterion because independent gateways do not share one hostname or browser origin.

## Decision

### Product claim

The MVP publishes an immutable static website version selected by a signed mutable update and allows two volunteer replicas to preserve and serve its complete content graph after the publishing origin goes offline.

This claim does not include anonymity, guaranteed permanence, deletion, censorship resistance, a canonical hostname, or same-origin continuity. Meshkeep is not a blockchain system.

### Roles

**Publisher** is the actor or tool authorized by the site's private publishing key. The publisher prepares static content, selects an immutable version CID, and authorizes the IPNS update. Publisher authority follows the key, not a particular machine or Kubo repository.

**Origin** is the Kubo node used by a publisher to import, initially pin, announce, and provide a version. It is an initial transfer role. It is not the publishing authority, canonical server, coordinator, or required long-term dependency. The hard MVP deliberately shuts it down.

**Replica** is an independently operated Kubo node whose operator voluntarily selects a site identity to retain. A replica resolves and validates the update, fetches every reachable block, verifies complete availability, applies local retention policy, and may serve the version through its own gateway. A replica is not trusted merely because it claims to have pinned a root CID.

One process may perform more than one role during development, but hard MVP acceptance uses an origin and two independently configured replicas so that role boundaries are observable.

### Technical baseline

- Kubo/IPFS supplies content addressing, UnixFS, transfer, pinning, gateways, peer routing, and IPNS.
- Static directories use the `unixfs-v1-2025` profile so import identity is deliberate and testable.
- An immutable UnixFS root CID identifies each website version.
- A publisher-controlled IPNS key signs the mutable update selecting the current version CID.
- CID verification protects byte integrity; recursive graph verification protects the claim of complete retention.
- CAR is an optional transport for the same graph and must preserve the expected root CID.
- TypeScript is used for the protocol, CLI, and future UI.
- Rust is deferred and may later manage only a Tauri shell and Kubo sidecar lifecycle.

The v0.1 protocol must specify supported IPNS mapping, update ordering/freshness, limits, canonical evidence, and compatibility. This ADR does not approve an additional signed manifest format or a new naming protocol.

### Access URLs

Alternative replica URLs are accepted by design. A successful MVP may use any Kubo-supported URL that identifies the expected version or site identity, for example:

```text
http://replica-a.local/ipfs/<version-cid>/
http://replica-b.local/ipfs/<version-cid>/
http://replica-a.local/ipns/<ipns-name>/
http://replica-b.local/ipns/<ipns-name>/
```

Equivalent subdomain gateway forms are also acceptable where configured. The actual hostnames above are illustrative only.

Acceptance compares the resolved site identity, immutable root CID, complete retained graph, and expected files. It does not require equal URL strings, a public gateway, DNSLink, the original publisher URL, or shared browser storage/security state. The MVP fixture must work under the documented replica-local gateway mode.

### Current implementation scope

The order is:

1. Manual Kubo lab proving v1, two complete replicas, origin shutdown, key transfer, v2, and synchronization.
2. TypeScript protocol and CLI automating only the proven workflow.
3. Headless replicator after the protocol/CLI gate.
4. Linux desktop, GitHub Action, and conditional hardening only at their roadmap gates.

Dashboard, framework detection, build automation, Tauri, SQLite, metrics, DNSLink, and key rotation are not in the current phase.

## Consequences

### Positive

- The origin can disappear without changing publisher authority or immutable version identity.
- Independent replicas avoid a required Meshkeep-operated service.
- CID and IPNS semantics rely on Kubo rather than a new storage or naming protocol.
- The hard MVP can be tested with explicit machines, keys, CIDs, and complete-graph evidence.

### Negative

- IPFS/IPNS routing, caching, and provider availability remain operational dependencies.
- Alternative gateways create different browser origins and may break sites that assume one canonical path or hostname.
- Two volunteer replicas reduce a single-node dependency but provide no permanence guarantee.
- Publishing-key loss or compromise has no MVP rotation or recovery mechanism.
- A browser viewing a gateway response does not independently prove freshness without additional verification.

### Follow-up decisions

- Define v0.1 update freshness, rollback handling, compatibility, and validation limits.
- Decide headless synchronization atomicity and retention policy before v0.2.
- Decide desktop sidecar and update trust before v0.3.
- Require separate ADRs for DNSLink, key rotation, metrics, SQLite, new protocols, or any central service.
