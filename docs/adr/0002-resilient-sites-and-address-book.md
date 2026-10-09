# ADR 0002: Resilient Sites, Key-Based Addresses, And Address Books

- Status: Accepted
- Date: 2026-10-09
- Supersedes: [ADR 0001](0001-mvp-scope.md)

## Context

ADR 0001 framed Meshkeep as a narrow publication-and-replication workflow and gated all product work behind a manual four-host lab. That produced thorough Bash labs and documentation but no usable tool, and the gate depended on logistics (four independent machines and operators), not on engineering.

The goal of the project is now broader and clearer: anyone should be able to put a static website on the network without renting a server or buying a domain, and no single party should be able to take it down. Visitors should reach sites through human-friendly names kept in a personal address book, much like a contact list, with a browser extension planned for everyday use. The model is closer to BitTorrent than to web hosting: whoever holds a copy can serve it.

## Decisions

### 1. Claim

A Meshkeep site stays reachable while at least one replica that holds it can reach the visitor. There is no server, registrar, DNS name, or Meshkeep-operated service whose removal takes a site down.

Meshkeep does not claim anonymity, resistance to network-level blocking of IPFS traffic, guaranteed permanence, or deletion. Replica IP addresses are visible to peers, as in BitTorrent. Anonymous transports may be researched later.

### 2. Addresses are keys

A site address is the IPNS name of an Ed25519 key, written in its canonical form as a base36 CIDv1 with the `libp2p-key` codec (`k51…`). Creating an address is free and local. Whoever holds the private key controls the address, and nobody can register, seize, or revoke it.

Blockchain naming systems (ENS, Handshake, and similar) are rejected: tokens and consensus ledgers remain out of scope.

### 3. Human names are petnames

A globally unique, human-readable, and decentralized name system is not possible without a consensus ledger (Zooko's triangle). Meshkeep therefore uses petnames: each user maps their own local names (`my-blog`) to addresses in an address book. Two people can use different petnames for the same site, and the same petname for different sites.

Address books use the `meshkeep-address-book-v1` format specified in [spec/README.md](../../spec/README.md). They are plain, canonical JSON files that can be shared. A curator can publish an address book as an ordinary Meshkeep site under their own key, so others can import it, and later subscribe to it, the same way people share torrent lists. There is no global registry.

### 4. Meshkeep owns key custody

Meshkeep generates keys and stores them in its own keystore as `libp2p-protobuf-cleartext` files with mode 0600. It imports them into Kubo under the prefix `meshkeep-` when publishing. To move the publisher to another machine, the operator exports the key file, moves it over a secure channel, and imports it. Kubo 0.42 does not expose key export over RPC; this was verified, and it keeps the Meshkeep keystore authoritative.

### 5. Signed records live a long time and replicas keep them alive

- Publishers sign records with a default lifetime of one year (`8760h`) and a five-minute TTL.
- A publisher continues the sequence from the newest valid record it can find on the network (sequence + 1), so a key that has moved to a new machine never publishes a losing record.
- Replicas fetch the newest record and verify its signature against the address. They refuse records that point anywhere other than an immutable `/ipfs/` CID and records older than one they have already verified. They pin and verify the complete graph, then re-put the same signed record into the DHT.
- DHT nodes drop records after about 48 hours, so replicas should run `meshkeep sync` at least every 12 hours.

Trade-off: a long lifetime means a peer that isolates a visitor can keep serving an older valid record. Wherever both records are seen, the higher sequence wins. Once a record's lifetime ends without a new publication, the address stops resolving, but every version remains retrievable by CID from the replicas that hold it.

### 6. Replication is complete or it failed

A replica reports a version only after Kubo can walk the whole DAG offline (`dag/stat` with `offline=true`). It keeps every version it has replicated pinned. Retention and pruning policy belongs to the replica daemon phase.

### 7. Browser access through an extension

The planned extension holds the user's address book and resolves petnames to addresses. It fetches content with an embedded verified-retrieval client (Helia / `@helia/verified-fetch`), which checks every block against its CID. No trusted gateway is involved. Replica-local Kubo gateways remain a valid access path. The protocol package stays free of Node-only APIs so that the extension can reuse it.

### 8. Verification is automated

Automated integration tests replace the manual Bash labs and the four-host kit. The tests run a disposable private network of Kubo containers and exercise the CLI. Runs across real separate hosts become an operational check, not a gate for writing code.

### 9. Removed

- The unsigned deployment manifest draft. The signed IPNS record already is the release record, and the manifest depended on wall-clock time.
- The rule that every protocol change needs an issue, RFC, ADR, specification, fixtures, and a downgrade analysis. An ADR plus fixtures is required when a change touches formats, identity, or trust.

## Consequences

### Positive

- Meshkeep is usable: publish, replicate, resolve, and address books work end to end and are tested against real Kubo.
- Addresses cost nothing and cannot be seized from a registrar.
- Taking a site down requires reaching every replica, or blocking IPFS for each visitor.

### Negative

- Petnames are not globally unique. Sharing a site still means sharing its long address once, or sharing an address book that contains it.
- If the key is lost, the address can no longer be updated. If the key is stolen, the thief controls the address. There is no rotation or recovery yet.
- Availability still depends on volunteers choosing to replicate, and on visitors being able to reach IPFS peers.
- A record lifetime of a year makes freshness weaker for isolated visitors.
