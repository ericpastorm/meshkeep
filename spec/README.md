# Meshkeep Specification

Status: draft v1. The key words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119. The reference implementation is `@meshkeep/protocol`. The fixtures in [`fixtures/`](fixtures/) are part of this specification, and every implementation must pass them.

Meshkeep defines no new network, storage, or signature protocol. It fixes how it uses existing ones: UnixFS for content, IPNS for mutable addresses. On top, it defines one data format: the address book.

## 1. Site Versions

A site version is a directory imported as UnixFS with the `unixfs-v1-2025` profile. These are the Kubo `Import` settings `CidVersion=1`, `HashFunction=sha2-256`, `UnixFSChunker=size-1048576`, `UnixFSDAGLayout=balanced`, `UnixFSDirectoryMaxLinks=0`, `UnixFSFileMaxLinks=1024`, `UnixFSHAMTDirectoryMaxFanout=256`, `UnixFSHAMTDirectorySizeEstimation=block`, `UnixFSHAMTDirectorySizeThreshold=256KiB`, and `UnixFSRawLeaves=true`. The root CID identifies the version.

- A publisher MUST refuse to import when its node's settings differ.
- Version CIDs are written as base32 CIDv1. Implementations MUST upgrade CIDv0 input to CIDv1.
- The fixtures in [`tests/fixtures/site-v1`](../tests/fixtures/site-v1) and [`site-v2`](../tests/fixtures/site-v2) MUST import to `bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki` and `bafybeiczekoh2tsak4wy6hhuxr7tmmaqpjfrh5yqckq4rzmnavkk6k5hwq`, respectively.

## 2. Site Addresses

A site address is the IPNS name of an Ed25519 key: a CIDv1 with the `libp2p-key` codec (`0x72`) and an identity multihash of the libp2p protobuf public key `08 01 12 20 ‖ public key`.

- The canonical text form is base36 (`k51…`). Implementations MUST accept base36 and base32 forms, with or without a `/ipns/` prefix, and MUST output the canonical form.
- Private keys are stored and exchanged as `libp2p-protobuf-cleartext`: `08 01 12 40 ‖ seed ‖ public key`, 68 bytes in total. An implementation that can sign MUST check that the public key derives from the seed before using the key.
- [`fixtures/keys/ed25519-kubo-0.42.json`](fixtures/keys/ed25519-kubo-0.42.json) is a disposable test key whose name was derived by Kubo 0.42.0.

## 3. Signed Records

Records are standard IPNS records (V1+V2 signatures), validated by Kubo.

- A record's value MUST be `/ipfs/<version CID>`. Replicas MUST reject any other value, including `/ipns/` indirection.
- Publishers SHOULD use a lifetime of `8760h` and a TTL of `5m`.
- A publisher MUST look up the newest valid record for its address before publishing. If one exists, the new sequence MUST be its sequence plus one.
- A replica MUST verify the record against the address. It MUST refuse a record whose sequence is lower than one it has already verified. It MUST NOT report a version until every block of the version is stored locally. It SHOULD re-put the latest verified record at least every 12 hours.

## 4. Address Book (`meshkeep-address-book-v1`)

An address book maps local petnames to site addresses. Its JSON Schema is [`address-book-v1.schema.json`](address-book-v1.schema.json).

```json
{
  "format": "meshkeep-address-book-v1",
  "entries": [
    { "petname": "demo", "name": "k51qzi5uqu5dg9ufswxt229ntzdy7p4125xzv5rtyjso89ajdujg6csfxcj260", "note": "Disposable fixture site" }
  ]
}
```

### Validation

A reader MUST reject a book that breaks any of these rules:

- `format` MUST be exactly `meshkeep-address-book-v1`. Other values are unsupported and MUST be rejected, not ignored.
- Unknown fields at any level are invalid.
- `entries` holds at most 10,000 entries, and the encoded book is at most 4 MiB.
- `petname` MUST match `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` and MUST NOT itself be a valid site address. Petnames are unique within a book.
- `name` MUST be a valid site address in any accepted form. Readers normalize it to the canonical form.
- `note` is optional. If present, it is 1–280 Unicode code points with no control characters.

### Canonical Encoding

Writers MUST produce the canonical encoding:

- Keys appear in the order `format`, `entries` at the top level and `petname`, `name`, `note` in each entry.
- Absent notes are omitted.
- Entries are sorted by petname in ascending byte order.
- The document uses two-space JSON indentation and ends with one newline.

Decoding and re-encoding any valid book MUST give the canonical bytes. For example, [`valid/unsorted.json`](fixtures/address-book/valid/unsorted.json) MUST encode to [`valid/canonical.json`](fixtures/address-book/valid/canonical.json).

### Trust

An address book is only as trustworthy as its source. A book received from someone else is a set of suggestions. Clients MUST NOT silently replace an existing petname with an imported one.

## Changing This Specification

A change to a format, the signing input, address derivation, or ordering rules requires an ADR in `docs/adr/` and updated fixtures. New format versions get new `format` strings. Readers keep rejecting versions they do not support.
