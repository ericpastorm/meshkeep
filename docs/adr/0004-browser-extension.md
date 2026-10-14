# ADR 0004: Browser Extension Over A Local Gateway

- Status: Accepted
- Date: 2026-10-14
- Amends: [ADR 0002](0002-resilient-sites-and-address-book.md), section 7

## Context

ADR 0002 planned an extension that fetches sites with an embedded verified-retrieval client, with no gateway involved. Before building it, we measured what a Manifest V3 extension can do in Chromium 156 (Playwright, headless), serving a test site from the extension's service worker:

| How the site document is served | CSS, images, scripts load | Site gets extension privileges |
| --- | --- | --- |
| Plain extension page | yes | yes: `chrome.runtime`, `chrome.storage`, the extension's files |
| `Content-Security-Policy: sandbox allow-scripts allow-same-origin` | yes | yes |
| `Content-Security-Policy: sandbox allow-scripts` (opaque origin) | no: the service worker does not control the document, so every subresource fails | no |
| `<iframe sandbox="allow-scripts">` in an extension page | no: the navigation is not intercepted at all | no |

An extension on its own can either run a site with the extension's privileges or show a broken site. It cannot give each site its own origin either. Rewriting HTML to load resources from `blob:` URLs breaks `fetch()`, CSS `url()`, `srcset`, and storage. A service-worker gateway on a web domain (like `inbrowser.link`) works, but needs a wildcard domain with TLS, which is a single point of takedown.

Opening sites on a local Kubo subdomain gateway works. Measured the same way, against Kubo 0.42.0: each site gets its own origin (`http://<address>.ipns.localhost:8080`), which browsers treat as a secure context. A page has no `chrome.runtime` and cannot fetch the extension's files. Its `localStorage` is separate from other sites'. A CORS request to the Kubo RPC is blocked, and a `no-cors` POST to `/api/v0/key/gen` gets 403 and creates no key. Kubo verifies every block against its CID and every record's signature.

## Decision

1. **The extension is the address book and the way in.** It keeps the user's petnames, offers them in the address bar (keyword `mk`) and in a popup, and opens `http://<address>.ipns.localhost:<port>/<path>`. It does not fetch or render site content itself.
2. **A local gateway serves the sites.** That is any Kubo node on the visitor's machine: the Docker replica in `examples/docker`, a plain Kubo daemon, or IPFS Desktop. The gateway is always `localhost`; only the port is configurable (default 8080). The extension never falls back to a remote gateway, because a remote gateway would have to be trusted with the content.
3. **Same address book format.** The extension stores the book as canonical `meshkeep-address-book-v1` JSON and imports and exports the same files as `meshkeep book`. All validation comes from `@meshkeep/protocol`.
4. **Least privilege.** No content scripts, no web-accessible resources, and no `externally_connectable`, so no page can reach the extension. The only permission is `storage`. The background service worker owns all state and applies every change in order, and it accepts messages only from the extension's own pages.
5. **Chromium first.** Firefox can follow with the same code, using a background script instead of a service worker.

## Consequences

- Visitors need a local node. One extension and one `docker compose up -d` is the shortest path today. The optional desktop app (v0.4) can bundle Kubo so that this happens automatically.
- Isolation comes from the browser's origin model, not from code we maintain, and it works for every static site.
- All sites share the registrable domain `localhost`. A site can set a cookie for `ipns.localhost` that other sites then receive (measured). Sites must not trust cookies; removing such cookies is planned as part of the isolation review.
- Rollback protection is Kubo's: the gateway resolves the newest record it can find. The extension does not see records.
- The embedded verified retrieval of ADR 0002 moves to research. It becomes possible when browsers let an extension give generated content its own origin.
