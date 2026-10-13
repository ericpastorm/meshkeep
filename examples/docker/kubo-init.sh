#!/bin/sh
# Runs inside the Kubo container before the daemon starts, on every start.
set -eu

# The RPC controls the whole node. Bind it to loopback inside the container's network
# namespace: only the meshkeep container, which shares that namespace, can reach it. It is
# not published, so neither the host nor other containers can.
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001

# The gateway listens on all interfaces inside the container so Docker can publish it; the
# compose file publishes it on the host's loopback only.
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080

# The import profile that defines Meshkeep version identity (needed only for publishing).
ipfs config profile apply unixfs-v1-2025 >/dev/null
