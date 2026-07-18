# Privacy

Status: pre-alpha technical privacy notes, not a legal privacy policy.

## Public By Design

Meshkeep publishes static websites through IPFS. Operators and publishers should assume the following can become public or observable:

- Website files and every reachable block
- Root and intermediate CIDs
- IPNS names and signed update records
- Peer IDs, network addresses, provider announcements, and connection timing
- Which content a peer requests, provides, or retains
- Requests sent to a replica or gateway, including client network metadata
- Publication and update timing and approximate content size

Content addressing does not encrypt content. A hard-to-guess CID is not an access-control mechanism.

## Roles And Visibility

### Publisher

The publisher sees the source static directory, local paths, publication timing, the publishing identity, and Kubo activity. Only selected site files should enter the UnixFS graph. Source files, environment files, credentials, build caches, private keys, and unrelated host paths must be excluded before import.

### Origin

The origin Kubo node sees and initially provides the published graph. Going offline removes that node from the path but does not erase records or copies already propagated to peers.

### Replica

A replica operator can inspect all retained content, its CIDs, the subscribed IPNS identity, synchronization timing, and clients using its gateway. Replica retention is voluntary and governed by local policy.

### Network And Gateway Observers

IPFS peers, routing systems, network providers, and gateway operators may correlate addresses, identities, CIDs, and timing. A remote gateway also sees client request metadata and can return stale responses. Meshkeep does not hide these relationships.

## Data Meshkeep Should Not Collect

The current design has no accounts, hosted dashboard, remote telemetry, analytics, or metrics service. The planned CLI and replicator should operate locally and should not contact a Meshkeep-operated endpoint for correctness.

Local logs and machine-readable output should minimize host paths and must never contain private keys, credentials, environment values, or unpublished file contents. Local operational state can still be sensitive and should be protected by normal host access controls.

Future metrics, crash reporting, hosted services, or dashboards require a privacy review, explicit operator choice, documented retention, and a roadmap decision. They are not part of the MVP.

## Identity Is Not Anonymity

An IPNS key proves authority over updates; it does not prove a civil identity and does not make the publisher anonymous. Reusing keys, peers, addresses, gateways, or timing patterns can link publications and operators. Meshkeep provides no traffic obfuscation, onion routing, mixing, or protection against network-level correlation.

## Retention And Deletion

A publisher can stop announcing or serving a version, and a replica can unpin its local copy. Neither action guarantees deletion from other replicas, gateways, caches, archives, or IPFS peers. Do not publish personal, confidential, regulated, or revocable data unless this persistence risk is acceptable.

## Operator Guidance

- Publish only material intended for unrestricted public distribution.
- Review the exact import directory and use non-sensitive fixtures during pre-alpha work.
- Keep publishing keys outside the content tree, logs, shell history, and shared archives.
- Run Kubo RPC on loopback or an equivalent private interface.
- Avoid public gateways when request privacy matters; a local gateway still exposes IPFS network activity.
- Document local replica logs and retention policy for users of that replica.
- Treat abuse and removal requests as operator matters; Meshkeep cannot remove third-party copies.

See [SECURITY.md](../SECURITY.md) and the [Threat Model](threat-model.md) for operational controls and accepted risks.
