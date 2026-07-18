# Threat Model

Status: pre-alpha MVP baseline. Revisit this document when protocol semantics, Kubo versions, or deployment boundaries change.

## Protected Assets And Claims

Meshkeep aims to protect:

- Publisher authority: only the holder of the publishing key can authorize the next update.
- Version integrity: retrieved bytes match the selected immutable root CID.
- Replication correctness: a replica reports availability only after retaining the complete reachable graph.
- Update correctness: replicas reject invalid, unsupported, ambiguous, and unauthorized updates.
- Local operator security: private keys, host files, credentials, and privileged Kubo RPC are not exposed.
- Honest status: software distinguishes resolved, fetching, complete, stale, and failed states.

Availability is conditional on willing, connected replicas and functioning IPFS/IPNS networking. It is not a protected guarantee.

## Trust Boundaries

- The publisher machine and private key are trusted to authorize intended content.
- The Kubo RPC endpoint is privileged and trusted only inside a local private boundary.
- IPFS peers, DHT participants, providers, gateways, CAR files, IPNS responses, static inputs, and replica operators are untrusted.
- Kubo is a security-critical dependency. Meshkeep relies on its verified CID, UnixFS, IPNS, and pinning behavior but must constrain and verify adapter results.
- Browser-rendered website content is untrusted and must never gain Kubo RPC or host privileges.

## Adversaries

The MVP considers:

- A remote peer returning malformed, incomplete, excessive, or adversarial graphs.
- A gateway or replica serving stale content, denying service, or lying about retention.
- An attacker replaying an older valid update or attempting an unauthorized update.
- A malicious static site attempting browser attacks or access to local services.
- A local or supply-chain attacker seeking publishing keys, credentials, or command execution.
- An observer correlating peer identities, IP addresses, provider records, requests, and timing.
- Accidental operator error, including publishing secrets, losing keys, exposing RPC, or pinning only a root reference.

## Principal Threats And MVP Controls

### Publishing-key theft or loss

Impact: an attacker can authorize future updates, or the legitimate publisher can no longer update the stable identity.

Controls: keep keys separate from content and logs; use disposable lab keys; minimize key presence; transfer and back up keys through an explicit operator procedure; fail closed on invalid identity. Key rotation and revocation are not yet available, so compromise recovery is a known gap.

### Substitution, corruption, and incomplete retention

Impact: a user receives different bytes or a replica claims a version it cannot fully serve.

Controls: bind updates to immutable CIDs; let Kubo verify blocks; traverse and verify the complete reachable graph; record the expected root CID; never equate a root pin request with demonstrated completeness.

### Replay and stale resolution

Impact: a replica or user remains on v1 after v2 was validly published.

Controls: validate IPNS signatures and supported freshness/version semantics; record resolution evidence; expose stale or uncertain state instead of silently accepting it. Detailed ordering, cache, and rollback rules must be fixed during v0.1 before automation is considered safe.

### Resource exhaustion

Impact: large or malformed graphs consume disk, memory, CPU, bandwidth, or file descriptors.

Controls: validate inputs; impose explicit size, depth, block, concurrency, timeout, and retry limits; stage synchronization before declaring success; keep operator quotas authoritative. Exact limits remain a protocol and replicator design task.

### Kubo RPC exposure

Impact: a remote site or attacker controls node operations, reads sensitive node data, or reaches host capabilities.

Controls: bind RPC to loopback or an equivalent private interface; do not publish it through a reverse proxy; do not make it available to browser content; use a narrow adapter; avoid shell interpolation; apply least privilege at the process boundary.

### Malicious website content

Impact: phishing, browser exploitation, tracking, or attacks against local gateway context.

Controls: treat content as untrusted; rely on browser isolation; do not inject privileged Meshkeep APIs; prefer origin-isolating gateway modes where available. Meshkeep authenticates publisher-selected bytes but does not certify that they are safe.

### Central fallback or dependency

Impact: a convenient hosted gateway, resolver, coordinator, or telemetry endpoint becomes a control, privacy, or availability dependency.

Controls: all hard MVP acceptance runs use independently operated Kubo nodes and remain valid when the publisher origin is off. Optional services must not be silent defaults or correctness dependencies.

## Accepted Residual Risks

- Two replicas can both go offline, delete content, collude, or fail.
- IPNS resolution can be slow, partitioned, cached, censored, or observed.
- A valid publisher can intentionally publish harmful content.
- Gateway HTTP responses do not by themselves provide end-to-end freshness proof to a browser.
- Alternative gateway URLs have different browser origins and security state.
- IPFS content can persist beyond publisher or replica deletion attempts.
- Network observers and peers can correlate activity; Meshkeep provides no anonymity.
- The MVP has no key rotation, revocation, or post-compromise recovery protocol.

## Out Of Scope

- Defending against a fully compromised publisher machine while its key is in use
- Anonymity, traffic analysis resistance, or hidden service operation
- Guaranteed content availability or deletion
- Moderation and adjudication of third-party content
- Dynamic server-side code isolation
- Blockchain or economic incentive attacks

## Validation Before MVP Acceptance

- Exercise invalid signatures, stale updates, missing blocks, malformed graphs, and interrupted transfers.
- Confirm both replicas serve the expected CID after origin shutdown.
- Confirm Kubo RPC is not reachable from a remote interface or hosted website.
- Inspect logs and machine output for secrets, keys, host paths, and sensitive content.
- Repeat v2 publication from another machine using the deliberately transferred disposable key.
