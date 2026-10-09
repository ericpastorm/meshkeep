# Threat Model

Revisit this document when record policy, key handling, the extension, or the Kubo version changes.

## What Meshkeep Protects

- **Address authority:** only the holder of a site key can change what its address points to.
- **Content integrity:** retrieved bytes match the version CID the signed record selects.
- **Complete replication:** a replica reports a version only when every block is stored locally.
- **No rollback at replicas:** a replica never moves to a record older than one it has verified.
- **Takedown resistance:** removing any single machine (the publisher, a replica, any service) does not remove the site while another replica is reachable.
- **Operator safety:** keys, host files, and Kubo RPC are not exposed by Meshkeep.

## Trust Boundaries

- The publisher's machine and key are trusted to sign intended content.
- Kubo RPC is privileged and trusted only on loopback.
- Peers, DHT nodes, gateways, replicas, records, address books from others, and site content are untrusted.
- Kubo is a security-critical dependency. Meshkeep relies on its CID, IPNS validation, and pinning, and checks what it returns.

## Adversaries And Controls

### Someone who wants a site gone

- **Seize a domain or server:** none exists. The address is a key, and content lives on every replica.
- **Pressure the publisher:** the site keeps running from replicas, and the key can move.
- **Pressure replica operators:** each operator is independent, so every one of them has to be reached. More replicas mean more resilience.
- **Block IPFS traffic for a visitor:** not defended. Anonymous or obfuscated transports are research items.
- **Let the record expire:** records live one year by default, and replicas re-put them. Without a new publication within the lifetime, the address stops resolving, but versions stay reachable by CID.

### Forged or stale updates

- **Forged record:** IPNS signatures are verified against the address. The integration test rejects a tampered record.
- **Replay of an older record:** Kubo refuses lower sequences on `name/put`, and replicas refuse records older than the newest they have verified.
- **Isolating a visitor and serving an old but valid record:** possible within the record lifetime. A visitor that sees both records takes the higher sequence. This is the main freshness trade-off of long lifetimes.

### Key compromise or loss

A stolen key lets the thief publish under the address, and a lost key freezes it. There is no rotation or recovery yet. Mitigations: keep keys only in the keystore (mode 0600), back them up offline, and delete exported transfer files.

### Malicious or incomplete content from peers

Blocks are verified by CID. A replica that cannot fetch every block fails instead of claiming the version. Size and time limits per site are still to be added (see the roadmap).

### Misleading address books

A shared address book can map a familiar petname to an impostor's address. Importing never overwrites an existing petname without `--replace`. The address itself is the identity; the petname is only a label.

### Malicious site content

Meshkeep proves who signed the content, not that it is safe. Sites are untrusted web content. The extension must isolate them from its own privileges and from local services, and Kubo RPC must never be reachable from a page.

### Local exposure

The CLI refuses non-loopback RPC endpoints by default. It does not follow symlinks or publish dotfiles unless asked, and never prints keys.

## Accepted Risks

- Every replica can go offline or leave.
- Peers and observers can see IP addresses, the content requested or provided, and timing. Meshkeep provides no anonymity.
- Copies cannot be deleted from other people's nodes.
- A valid key holder can publish harmful content.
- Gateways are separate browser origins, and a remote gateway can lie about freshness.
