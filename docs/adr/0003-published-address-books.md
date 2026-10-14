# ADR 0003: Published Address Books And Following Them

- Status: Accepted
- Date: 2026-10-14
- Builds on: [ADR 0002](0002-resilient-sites-and-address-book.md)

## Context

ADR 0002 made address books shareable files and anticipated that a curator could publish one as a Meshkeep site. So far, a replica operator who wants to help keep a community's sites alive has to run `replicate` once per site, and has to notice by hand when the community adds or drops a site. The equivalent of subscribing to a torrent list is missing.

Two questions need an answer: where a published book lives, so any client can find it, and what following one means for a replica.

## Decisions

### 1. A published book is a file at a well-known path in an ordinary site

A site publishes an address book by containing the file `.well-known/meshkeep/address-book.json` at its root, in the canonical `meshkeep-address-book-v1` format. There is no new signature or envelope. The book is authenticated by the signed IPNS record of the site that contains it, and its integrity comes from the version CID. The curator's address *is* the book's identity.

`.well-known` is already the one hidden path `meshkeep publish` accepts. `meshkeep book publish --key <label>` publishes the local address book as a site containing only that file. Curators who want a homepage can put the file in their own site instead.

### 2. Following is explicit trust in a curator

`meshkeep follow <curator>` means "replicate what this curator lists". The replica:

- replicates the curator's site itself, so the book stays available without the curator;
- reads the book from that site's newly verified version, from local blocks only, after the normal record verification, rollback refusal, and complete-graph check;
- replicates every listed address, using the limits and retention given to the follow.

Petnames in a followed book are ignored by the replica. They are labels for people, and they never change the operator's own address book.

### 3. A replica tracks why it keeps each site

Each replicated site records its sources: `manual` (the operator ran `replicate`) and/or `follow:<curator>` (a followed book lists it). When a refresh finds that a book no longer lists a site, that follow's source is removed. A site with no sources left is unreplicated, which releases only the pins this replica created (ADR 0002 / pin ownership). `unreplicate` refuses a site that a followed book still lists, and says which book lists it, so a follow cannot be silently undone.

Sites replicated before this ADR load with the source `manual`.

### 4. Following is bounded

A follow has `--max-sites` (default 100). A book listing more is refused as a whole; it is never truncated, because the order of entries carries no priority. The per-site limits (`--max-size`, `--max-blocks`) and retention (`--keep`) given to `follow` apply to every site it adds. Failures of individual listed sites do not fail the follow; they are retried like any other site.

### 5. Refresh runs with replication

`sync` and `replica run` refresh every follow before replicating sites, at the same cadence. A book that cannot be fetched or read leaves the follow's last known site list in place, so a temporary outage, or an attacker withholding the book, never makes a replica drop sites.

## Consequences

### Positive

- One command turns a volunteer into a replica for a whole community, and it keeps up with the community's changes.
- No new protocol: a published book is a site, so it is replicated, verified, and rollback-protected like any other.
- Curators' books themselves become as hard to take down as the sites they list.

### Negative

- Following delegates a choice of what to host. A curator whose key is stolen can make followers fetch unwanted content. This is bounded by `--max-sites` and the per-site limits, but not prevented. The remedy is `unfollow`.
- A malicious curator can make followers drop sites they only had through that book. Sites the operator replicated themselves, or that another followed book lists, are kept.
- Book listings are public, and following one reveals interest in its sites, as replicating them already does.
