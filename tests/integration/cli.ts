import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "@meshkeep/cli";

import type { KuboCluster } from "./cluster.js";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
// Root CIDs are part of the fixture contract: the same bytes and profile must give the same CID.
export const V1_CID = "bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki";
export const V2_CID = "bafybeiczekoh2tsak4wy6hhuxr7tmmaqpjfrh5yqckq4rzmnavkk6k5hwq";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the real CLI in-process for cluster roles. Each role gets its own state directory
 * under `scratch` and talks to its own Kubo node.
 */
export function cliRunner(cluster: KuboCluster, scratch: () => string) {
  const homes = new Map<string, string>();

  async function home(role: string): Promise<string> {
    let path = homes.get(role);
    if (path === undefined) {
      path = await mkdtemp(join(scratch(), `${role}-`));
      homes.set(role, path);
    }
    return path;
  }

  /** Starts a command without waiting for it; `stop` aborts it and waits for it to finish. */
  async function start(role: string, ...args: string[]) {
    const controller = new AbortController();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const done = runCli(["node", "meshkeep", "--json", ...args], {
      env: { MESHKEEP_HOME: await home(role), MESHKEEP_API: cluster.node(role).apiUrl },
      signal: controller.signal,
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      setExitCode: (code: number) => {
        exitCode = code;
      },
    });
    return {
      /** Diagnostics written so far, one JSON object per line for `replica run`. */
      events: () =>
        stderr
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      stop: async (): Promise<CliResult> => {
        controller.abort();
        await done;
        return { exitCode, stdout, stderr };
      },
    };
  }

  async function cli(role: string, ...args: string[]): Promise<CliResult> {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    await runCli(["node", "meshkeep", "--json", ...args], {
      env: { MESHKEEP_HOME: await home(role), MESHKEEP_API: cluster.node(role).apiUrl },
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      setExitCode: (code: number) => {
        exitCode = code;
      },
    });
    return { exitCode, stdout, stderr };
  }

  /** Like `cli`, but requires success and returns the parsed JSON result. */
  async function meshkeep(role: string, ...args: string[]) {
    const result = await cli(role, ...args);
    if (result.exitCode !== 0) {
      throw new Error(`meshkeep ${args.join(" ")} failed on ${role}: ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  return { cli, meshkeep, start, home };
}

/** Polls until `check` returns a value, or fails after `timeoutMs`. */
export async function waitFor<T>(
  description: string,
  check: () => T | undefined,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}`);
}
