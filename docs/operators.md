# Operator Guide

How to run a Meshkeep publisher or replica on your own machine. Every command below was checked against Kubo 0.42.0. Meshkeep is in early development, so use it only for public content you can afford to lose control of, and back up your keys.

- **Publisher:** owns a site key and publishes versions of a static directory.
- **Replica:** keeps complete copies of other people's sites and keeps their addresses resolvable.

One machine can be both.

## 1. Install

You need Node.js 22.12 or later, pnpm, Git, and [Kubo](https://docs.ipfs.tech/install/command-line/) (tested with 0.42.0).

```sh
git clone https://github.com/ericpastorm/meshkeep.git
cd meshkeep
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.local/bin
ln -s "$PWD/packages/cli/dist/bin.js" ~/.local/bin/meshkeep
meshkeep version
```

The launcher runs `node` from your `PATH`. Meshkeep keeps its state in `$MESHKEEP_HOME`, which defaults to `~/.config/meshkeep`.

## 2. Set Up Kubo

Do this once per machine:

```sh
ipfs init
ipfs config profile apply unixfs-v1-2025
ipfs daemon            # keep it running, ideally under your service manager
```

Then check the setup:

```sh
meshkeep doctor
```

`doctor` checks Node.js, that Kubo answers on its RPC port, and that the import profile is active. Publishing refuses to run without the profile, because it is what makes the same files always produce the same version CID.

Network rules:

- **RPC (`127.0.0.1:5001`) stays on loopback.** It controls the node completely: keys, pins, and config. A fresh `ipfs init` already binds it to loopback. Never publish it, never put it behind a proxy, and never make it reachable from web pages. Meshkeep refuses non-loopback RPC URLs unless you pass `--allow-remote-api`.
- **Gateway (`127.0.0.1:8080`)** is for your own browser. Exposing it publicly turns your machine into a public gateway for any IPFS content, so don't do that unless you mean to.
- **Swarm (port 4001, TCP and UDP)** is how peers fetch from you. A replica is only useful if others can reach it, so allow inbound 4001 on replicas where you can. Kubo also tries NAT traversal and relays, but direct reachability is more reliable.

## 3. Publish A Site

```sh
meshkeep key create blog                 # prints the site address, k51…
meshkeep publish ./public --key blog
```

`publish` imports the directory, pins it, checks it is complete, and signs a record that points the address at the new version. The record is valid for one year (`--lifetime`) and may be cached for 5 minutes (`--ttl`). Publish again whenever the site changes: the address stays the same, and the sequence number goes up.

What gets published:

- Every regular file and directory under `./public`.
- Symlinks and special files are refused, not followed.
- Dotfiles (`.env`, `.git`, …) are refused unless you pass `--include-hidden`. `.well-known` is always allowed.
- At most 2 GiB and 100,000 files.

Review the directory anyway. Everything you publish is public and cannot be recalled.

### Keep The Address Alive

A record expires after its lifetime, and then the address stops resolving. The versions themselves stay reachable by CID from the replicas that hold them. To keep the address alive, do either of these:

- **Publish at least once a year.** Republishing the same directory is enough: same CID, new sequence, new expiry.
- **Keep the publisher's Kubo daemon running.** Kubo re-puts the records of its own keys every 4 hours (`Ipns.RepublishPeriod`). On Kubo 0.42.0 we verified that this keeps Meshkeep's one-year expiry rather than shortening it to Kubo's 48-hour default.

Replicas also re-put the last record on every `sync`, so the address keeps resolving while the publisher is offline, until the record expires.

### Back Up The Key

The key **is** the address. If you lose it, the site can never be updated again. If someone copies it, they can publish under your address, and there is no revocation.

- Meshkeep stores it at `~/.config/meshkeep/keys/<label>.key` (mode 0600).
- After the first publish, Kubo also holds a copy named `meshkeep-<label>` in its own keystore (`~/.ipfs/keystore`).

Keep an encrypted offline backup of the Meshkeep file, for example with `gpg --symmetric` or `age -p`. Don't put the plain file in cloud storage, Git, or the published directory.

### Move Publishing To Another Machine

```sh
# old machine
meshkeep key export blog blog.key        # unencrypted private key, mode 0600
# move blog.key over an encrypted channel (e.g. scp), then on the new machine:
meshkeep key import blog blog.key
rm blog.key
meshkeep publish ./public --key blog     # continues from the newest record it finds
```

Then remove the key from the old machine:

```sh
rm ~/.config/meshkeep/keys/blog.key
ipfs key rm meshkeep-blog
```

Also delete the exported file there. Ordinary deletion is not secure erasure, so treat a disk that held the key as sensitive.

The new machine looks up the newest record on the network and publishes the next sequence number. Make sure it can reach the network, or a replica that holds the record, when you publish.

## 4. Run A Replica

Pick the sites you want to keep, give them petnames, and replicate them:

```sh
meshkeep book add their-blog k51qzi5uqu5d…
meshkeep replicate their-blog
```

`replicate` does the following, and stops at the first step that fails:

1. Fetches the newest signed record and verifies it against the address.
2. Refuses records that point anywhere other than an immutable `/ipfs/` CID, and records older than the last one it verified.
3. Fetches the version within the site's limits.
4. Pins it, then confirms every block is stored locally.
5. Re-puts the signed record into the DHT.

Nothing is recorded unless every step passes. Previous versions stay pinned unless you set a retention policy (below).

### Limits

Each site has a size limit and a block limit. The defaults are 2 GiB and 250,000 blocks, which fit anything `meshkeep publish` accepts. Set them per site:

```sh
meshkeep replicate their-blog --max-size 512MiB --max-blocks 50000
```

Limits are remembered and applied by `sync`. A version over the limit is refused and left unpinned. Fetches give up after `--fetch-timeout` seconds (default 1800). An interrupted fetch records nothing, and the next run resumes from the blocks already downloaded.

### Keep Sites Current

DHT nodes forget records after about 48 hours, so every replicated site has to be re-checked and its record re-put at least every 12 hours. Choose **one** of these.

**The replica daemon (recommended).** `meshkeep replica run` stays running and handles every site on its own. Each site is re-checked every `--interval` seconds (default 21600, i.e. 6 hours). A failing site is retried after 1, 2, 4… minutes, up to the interval, without delaying the others. Sites you add with `replicate` or remove with `unreplicate` are picked up on the next cycle, and manual commands can run at the same time. SIGTERM or Ctrl-C stops it cleanly. As a systemd user service:

```sh
cp examples/systemd/meshkeep-replica.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now meshkeep-replica.service
journalctl --user -u meshkeep-replica.service -o cat      # logs
```

It logs one JSON object per line to stderr, for example:

```json
{"time":"2026-10-14T06:00:00.000Z","level":"info","event":"updated","name":"k51…","cid":"bafy…","sequence":3,"versions":2,"pruned":[],"nextRunSeconds":21600}
{"time":"2026-10-14T06:00:05.000Z","level":"warn","event":"failed","name":"k51…","error":"no valid record found for k51…","failures":1,"retryInSeconds":60}
```

Events: `started`, `current` (nothing new), `updated` (new version replicated), `failed` (will retry), `book-refreshed` and `book-failed` (followed address books, refreshed before the sites), `state-unreadable`, `interval-too-long` (warning when `--interval` exceeds 12 hours), and `stopped`. Filter with `jq`, for example `journalctl --user -u meshkeep-replica -o cat | jq 'select(.level != "info")'`. Unexpected internal errors exit the process, and the unit's `Restart=on-failure` brings it back.

**A timer or cron job running `meshkeep sync`.** Use this if you prefer not to keep a process running. With systemd, copy the timer units from [`examples/systemd/`](../examples/systemd/):

```sh
cp examples/systemd/meshkeep-sync.service examples/systemd/meshkeep-sync.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now meshkeep-sync.timer
systemctl --user list-timers meshkeep-sync.timer   # next run
journalctl --user -u meshkeep-sync.service         # past runs
```

The timer runs every 6 hours.

With cron:

```cron
# cron's PATH is minimal: include the directory that contains `node`.
PATH=/usr/local/bin:/usr/bin:/bin
0 */6 * * * $HOME/.local/bin/meshkeep sync >> $HOME/.local/state/meshkeep-sync.log 2>&1
```

Create the log directory first with `mkdir -p ~/.local/state`.

`sync` exits 1 if any site failed and prints one line per site. Add `--json` for machine-readable output.

In both cases, if `node` is not in `/usr/bin` or `/usr/local/bin`, uncomment the `Environment=PATH=…` line in the service. To keep user services running while you are logged out, run `loginctl enable-linger "$USER"`.

### Disk Space

Pinned versions are never removed automatically. Blocks from refused or interrupted fetches stay in Kubo's blockstore unpinned until garbage collection runs:

```sh
ipfs repo gc     # frees unpinned blocks; an interrupted fetch then starts over
```

Alternatively, run the daemon with `ipfs daemon --enable-gc`, which collects garbage periodically according to `Datastore.StorageMax` and `Datastore.GCPeriod`.

### Keep Fewer Versions

By default a replica keeps every version it has replicated, which is the most useful thing for an archive. To keep only the most recent ones:

```sh
meshkeep replicate their-blog --keep 3      # or --keep all to go back to keeping everything
```

The setting is remembered and applied by `sync`. Old versions are dropped only after the new one is complete, and the current version is never dropped, even if the publisher points the address back at an older one.

### Stop Replicating A Site

```sh
meshkeep unreplicate their-blog             # --keep-pins leaves every pin in place
```

Retention and `unreplicate` unpin a version only when **this replica created the pin** and no other replicated site still uses it. A pin you made yourself, or one `meshkeep publish` made for your own site on the same node, is never removed. Sites replicated before Meshkeep tracked pin ownership (v0.1) report their old pins as `kept`; unpin those yourself with `ipfs pin rm <cid>` if you no longer want them. If an unpin fails, the site stays recorded and you can simply run the command again.

### Follow A Published Address Book

A curator publishes an address book as a site, and a replica can follow it to replicate everything it lists ([ADR 0003](adr/0003-published-address-books.md)).

Curators publish their local address book with:

```sh
meshkeep book add some-site k51…               # build the list
meshkeep book publish --key my-list            # publishes .well-known/meshkeep/address-book.json
```

`book publish` creates a site containing only the book. To keep a homepage too, put the canonical book (`meshkeep book export`) at `.well-known/meshkeep/address-book.json` in your own site and `meshkeep publish` it. Like any site, the book stays alive while replicas hold it, and following replicates it automatically.

Replicas follow it with:

```sh
meshkeep follow k51…curator --max-sites 50 --max-size 512MiB --keep 3
meshkeep follows                               # what you follow
meshkeep unfollow k51…curator                  # --keep-pins leaves the pins in place
```

What following means:

- **It is trust.** You let the curator choose what your machine hosts. `--max-sites` (default 100) refuses books that grow too big, as a whole and never truncated. `--max-size`, `--max-blocks`, and `--keep` set the limits for every site the follow adds. Sites you already replicate keep your own settings.
- **It follows changes.** `sync` and `replica run` re-read the book from the curator's newly verified version. Sites the book adds are replicated. Sites it removes are dropped and their pins released, unless you replicate them yourself or another followed book lists them.
- **It fails safe.** If the book cannot be fetched or read, the follow keeps its last known list, so an outage or a withheld book never makes you drop sites.
- `unreplicate` refuses a site a followed book lists; unfollow the book instead.

### Run A Replica With Docker

If you only want to be a replica, Docker is the shortest path: [`examples/docker/compose.yaml`](../examples/docker/compose.yaml) runs Kubo and the Meshkeep replica daemon together.

```sh
cd examples/docker
docker compose up -d
docker compose exec meshkeep meshkeep replicate k51qzi5uqu5d…    # add sites
docker compose exec meshkeep meshkeep book add their-blog k51…   # petnames work too
docker compose logs -f meshkeep                                  # JSON-line daemon log
```

How it is wired:

- The Meshkeep container shares Kubo's network namespace (`network_mode: service:kubo`), so it reaches the RPC on `127.0.0.1:5001`. [`kubo-init.sh`](../examples/docker/kubo-init.sh) binds the RPC to that loopback, and the port is not published. Neither the host nor other containers can reach it; we verified that another container on the same network gets "connection refused".
- Swarm port 4001 (TCP and UDP) is published so other peers can fetch from you; open it in your firewall. The gateway is published on the host's `127.0.0.1:8080` only.
- The Meshkeep container runs as an unprivileged user with a read-only root filesystem, no capabilities, and `no-new-privileges`. Its state (`replicas.json`, address book) lives in the `meshkeep-data` volume, and Kubo's in `kubo-data`.
- Kubo runs with `--enable-gc`, so blocks from refused or interrupted fetches are reclaimed. Pins are never collected.
- If you recreate the `kubo` container (for example after changing its image), recreate `meshkeep` too (`docker compose up -d --force-recreate`), because it lives in Kubo's network namespace.

The image is published to GitHub Container Registry as `ghcr.io/ericpastorm/meshkeep` for `linux/amd64` and `linux/arm64`, with the tags `0.2.0`, `0.2`, and `latest`. It contains Node.js and a single bundled `meshkeep.mjs`, plus the licenses of everything bundled into it (`/app/licenses`). The compose file pins it by digest, like Kubo, so `docker compose up -d` always runs the image the file was tested with. To upgrade, update your checkout and run `docker compose up -d` again.

Each published image carries a signed build provenance attestation that ties it to the release tag and the workflow that built it. To check it with the GitHub CLI:

```sh
gh attestation verify oci://ghcr.io/ericpastorm/meshkeep:0.2.0 \
  --repo ericpastorm/meshkeep --source-ref refs/tags/v0.2.0
```

To build the image from your checkout instead (`Dockerfile` at the repository root), add the override file: `docker compose -f compose.yaml -f compose.build.yaml up -d --build`.

## 5. Visit Sites

Through your own Kubo gateway, either form works:

```text
http://<address>.ipns.localhost:8080/     each site gets its own browser origin (preferred)
http://127.0.0.1:8080/ipns/<address>/     path form; all sites share one origin
```

`meshkeep resolve their-blog` prints the CID the address currently points to. The browser extension does this from its own address book: type `mk their-blog` in the address bar. If your gateway is not on port 8080, set the port on the extension's address book page. See the [README](../README.md#browser-extension-preview).

## 6. Troubleshooting

| Message | Meaning and fix |
| --- | --- |
| `Kubo Import config does not match unixfs-v1-2025` | Run `ipfs config profile apply unixfs-v1-2025` and restart the daemon. |
| `kubo …: unreachable at 127.0.0.1:5001` | The daemon is not running, or `--api`/`MESHKEEP_API` points to the wrong place. |
| `no valid record found for k51…` | Nobody reachable has the record: the publisher never got it out, the record expired, or your node has no peers (`ipfs swarm peers`). |
| `stale record for …` | The network served a record older than one this replica already verified. Nothing changes; try again later. |
| `… declares … bytes, over this replica's limit` | The version is bigger than you allowed. Raise `--max-size` if you want it. |
| `fetching … timed out` | No reachable peer had all the blocks. Run again later, or raise `--fetch-timeout`. |
| `refusing hidden path .env` | Remove the file, or pass `--include-hidden` if it is meant to be public. |

Run `meshkeep doctor` first when anything looks wrong.
