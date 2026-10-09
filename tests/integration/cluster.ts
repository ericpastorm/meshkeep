import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { KuboClient } from "@meshkeep/kubo";

const run = promisify(execFile);

/** Kubo 0.42.0, pinned by index digest so every run uses identical bytes. */
export const KUBO_IMAGE =
  "ipfs/kubo@sha256:8907cb0cc1ad5798f6bb1bb1341a800990c268e021cedfa317e8aa1a33864214";

const INIT_SCRIPT = fileURLToPath(new URL("./kubo-init.sh", import.meta.url));
const READY_TIMEOUT_MS = 60_000;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export interface KuboNode {
  readonly role: string;
  readonly container: string;
  readonly peerId: string;
  readonly apiUrl: string;
  readonly gatewayUrl: string;
  readonly kubo: KuboClient;
}

/**
 * A disposable private IPFS network of Kubo containers. Containers share a random swarm key, so
 * they can only talk to each other; RPC and gateway ports are published on host loopback only.
 */
export class KuboCluster {
  readonly nodes = new Map<string, KuboNode>();
  private readonly runId = randomBytes(6).toString("hex");
  private readonly network = `meshkeep-it-${this.runId}`;
  private readonly label = `dev.meshkeep.test-run=${this.runId}`;
  private workDir = "";
  private swarmKeyFile = "";

  async init(): Promise<void> {
    this.workDir = await mkdtemp(join(tmpdir(), "meshkeep-it-"));
    this.swarmKeyFile = join(this.workDir, "swarm.key");
    const key = randomBytes(32).toString("hex");
    await writeFile(this.swarmKeyFile, `/key/swarm/psk/1.0.0/\n/base16/\n${key}\n`, {
      mode: 0o644,
    });
    await docker("network", "create", "--label", this.label, this.network);
  }

  node(role: string): KuboNode {
    const node = this.nodes.get(role);
    if (node === undefined) {
      throw new Error(`no node ${role}`);
    }
    return node;
  }

  /** Starts a node and connects it to `peers` (default: every running node). */
  async start(role: string, options: { peers?: readonly string[] } = {}): Promise<KuboNode> {
    const container = `meshkeep-it-${this.runId}-${role}`;
    await docker(
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      this.label,
      "--network",
      this.network,
      "--network-alias",
      role,
      "--env",
      "LIBP2P_FORCE_PNET=1",
      "--env",
      "IPFS_SWARM_KEY_FILE=/run/meshkeep/swarm.key",
      "--volume",
      `${this.swarmKeyFile}:/run/meshkeep/swarm.key:ro`,
      "--volume",
      `${INIT_SCRIPT}:/container-init.d/010-meshkeep.sh:ro`,
      "--publish",
      "127.0.0.1::5001",
      "--publish",
      "127.0.0.1::8080",
      KUBO_IMAGE,
    );
    const node = await this.attach(role, container);
    await this.connect(role, options.peers);
    return node;
  }

  /** Stops a node's container; its repository survives for a later `restart`. */
  async stop(role: string): Promise<void> {
    await docker("stop", "--time", "10", this.node(role).container);
  }

  async restart(role: string, options: { peers?: readonly string[] } = {}): Promise<KuboNode> {
    const { container } = this.node(role);
    await docker("start", container);
    const node = await this.attach(role, container);
    await this.connect(role, options.peers);
    return node;
  }

  private async attach(role: string, container: string): Promise<KuboNode> {
    const hostPort = async (port: number) => {
      const binding = await docker("port", container, `${port}/tcp`);
      const match = /^127\.0\.0\.1:(\d+)$/m.exec(binding);
      if (match === null) {
        throw new Error(`${role}: port ${port} is not bound to host loopback: ${binding}`);
      }
      return `http://127.0.0.1:${match[1]}`;
    };
    const apiUrl = await hostPort(5001);
    const gatewayUrl = await hostPort(8080);
    const kubo = new KuboClient({ apiUrl, timeoutMs: 120_000 });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let peerId: string | undefined;
    while (peerId === undefined) {
      try {
        peerId = await kubo.peerId();
      } catch (error) {
        if (Date.now() > deadline) {
          const logs = await docker("logs", "--tail", "40", container).catch(() => "");
          throw new Error(`${role} did not become ready: ${String(error)}\n${logs}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const node = { role, container, peerId, apiUrl, gatewayUrl, kubo };
    this.nodes.set(role, node);
    return node;
  }

  private async connect(role: string, peers?: readonly string[]): Promise<void> {
    const self = this.node(role);
    const targets = peers ?? [...this.nodes.keys()].filter((candidate) => candidate !== role);
    for (const peer of targets) {
      const target = this.node(peer);
      await self.kubo.connect(`/dns4/${peer}/tcp/4001/p2p/${target.peerId}`);
    }
  }

  /** Removes every container, volume, and network created by this run. */
  async destroy(): Promise<void> {
    const containers = await docker("ps", "--all", "--quiet", "--filter", `label=${this.label}`);
    if (containers !== "") {
      await docker("rm", "--force", "--volumes", ...containers.split("\n"));
    }
    await docker("network", "rm", this.network).catch(() => "");
    if (this.workDir !== "") {
      await rm(this.workDir, { recursive: true, force: true });
    }
  }
}
