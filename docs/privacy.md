# Privacy

Technical privacy notes, not a legal privacy policy.

## Public By Design

Publishing with Meshkeep is public distribution. Assume all of the following can be observed by peers, DHT nodes, gateway operators, and network providers:

- Every file in the site and every block, CID, and site address.
- Signed records: which version an address points to, its sequence, and when it was published.
- Peer IDs and IP addresses of publishers, replicas, and visitors, and which content each one requests, provides, or keeps.
- Timing and approximate size of publications and updates.

Content addressing does not encrypt anything. A hard-to-guess CID or address is not access control.

## Roles

- **Publisher:** the publishing node announces the content it imports. Meshkeep refuses symlinks and dotfiles (`.env`, `.git`, …) unless `--include-hidden` is passed, but reviewing what goes into the directory is still the publisher's job.
- **Replica:** an operator can read everything it replicates and sees the gateway requests it serves. Its peer ID and IP address are visible to anyone fetching from it.
- **Visitor:** the peers or gateway a visitor uses learn what the visitor asked for. A remote gateway sees the visitor's HTTP metadata. The planned extension fetches from peers directly, which avoids a gateway but exposes the visitor's IP address to those peers.

## Address Books

A local address book stays on the device. A shared or published address book reveals the sites its author follows. Publish a book only if you are comfortable with that.

## Identity Is Not Anonymity

A site key proves control over the address, not who someone is. Reusing a key, a node, or a network address links activities. Meshkeep offers no onion routing, mixing, or traffic obfuscation.

## What Meshkeep Does Not Collect

There are no accounts, analytics, telemetry, or hosted services. The CLI talks only to the local Kubo node. Its local state (keys, address book, replica list) is protected only by file permissions (0600/0700) and normal host security. Machine output and logs never contain private keys.

## Deletion

Unpinning or ceasing to publish does not remove copies from other replicas, caches, or archives. Do not publish personal, confidential, or revocable data.
