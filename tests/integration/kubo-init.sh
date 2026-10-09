#!/bin/sh
# Runs inside each test container before the Kubo daemon starts. It isolates the node: a private
# swarm (key supplied by the harness), no bootstrap peers, no delegated or HTTP routing, no
# telemetry, and the import profile that defines Meshkeep version identity.
set -eu

ipfs config profile apply unixfs-v1-2025 >/dev/null
ipfs config --json Bootstrap '[]'
ipfs config Routing.Type dhtserver
ipfs config --json Routing.DelegatedRouters '[]'
ipfs config --json Ipns.DelegatedPublishers '[]'
ipfs config --json AutoConf.Enabled false
ipfs config --json AutoTLS.Enabled false
ipfs config --json DNS.Resolvers '{}'
ipfs config --json Discovery.MDNS.Enabled false
ipfs config --json Swarm.DisableNatPortMap true
ipfs config --json Swarm.RelayClient.Enabled false
ipfs config --json Swarm.RelayService.Enabled false
ipfs config --json HTTPRetrieval.Enabled false
ipfs config --json Gateway.NoDNSLink true
ipfs config Plugins.Plugins.telemetry.Config.Mode off
