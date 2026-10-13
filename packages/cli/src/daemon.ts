import { KuboError } from "@meshkeep/kubo";
import { ProtocolError } from "@meshkeep/protocol";

import { CliError } from "./errors.js";
import type { ReplicateResult } from "./workflows.js";

export const DEFAULT_DAEMON_INTERVAL_MS = 6 * 60 * 60_000;
/** First retry delay after a failure; it doubles per consecutive failure, up to the interval. */
export const MAX_RETRY_BASE_MS = 60_000;
/** Never wake more often than this, so a misbehaving schedule cannot spin. */
const MIN_SLEEP_MS = 1_000;

export interface DaemonEvent {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface DaemonOptions {
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  /** The sites to keep replicated; read again on every cycle. */
  readonly listSites: () => Promise<readonly string[]>;
  readonly replicate: (name: string, signal: AbortSignal) => Promise<ReplicateResult>;
  readonly log: (event: DaemonEvent) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function isOperationalError(error: unknown): error is Error {
  return error instanceof CliError || error instanceof KuboError || error instanceof ProtocolError;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keeps every replicated site current until `signal` aborts. Each site is replicated once per
 * interval; a failing site is retried with exponential backoff (1 min, 2 min, …, capped at the
 * interval) without delaying the others. Operational failures (Kubo, network, limits, state)
 * are logged and retried; anything else is a bug and propagates so a supervisor restarts us.
 */
export async function runReplicaDaemon(options: DaemonOptions): Promise<void> {
  const { intervalMs, signal, log } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const retryBaseMs = Math.min(MAX_RETRY_BASE_MS, intervalMs);
  const schedule = new Map<string, { due: number; failures: number }>();

  log({ level: "info", event: "started", intervalSeconds: intervalMs / 1000 });
  while (!signal.aborted) {
    let names: readonly string[];
    try {
      names = await options.listSites();
    } catch (error) {
      if (!isOperationalError(error)) {
        throw error;
      }
      log({ level: "error", event: "state-unreadable", error: error.message });
      await sleep(intervalMs, signal);
      continue;
    }

    for (const name of schedule.keys()) {
      if (!names.includes(name)) {
        schedule.delete(name);
      }
    }
    for (const name of names) {
      const entry = schedule.get(name) ?? { due: 0, failures: 0 };
      if (signal.aborted) {
        break;
      }
      if (entry.due > now()) {
        continue;
      }
      try {
        const result = await options.replicate(name, signal);
        schedule.set(name, { due: now() + intervalMs, failures: 0 });
        log({
          level: "info",
          event: result.updated ? "updated" : "current",
          name,
          cid: result.cid,
          sequence: result.sequence,
          versions: result.versions.length,
          pruned: result.pruned,
          nextRunSeconds: intervalMs / 1000,
        });
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        if (!isOperationalError(error)) {
          throw error;
        }
        const failures = entry.failures + 1;
        const delayMs = Math.min(intervalMs, retryBaseMs * 2 ** (failures - 1));
        schedule.set(name, { due: now() + delayMs, failures });
        log({
          level: "warn",
          event: "failed",
          name,
          error: error.message,
          failures,
          retryInSeconds: delayMs / 1000,
        });
      }
    }
    if (signal.aborted) {
      break;
    }

    const nextDue = Math.min(now() + intervalMs, ...[...schedule.values()].map((e) => e.due));
    await sleep(Math.max(MIN_SLEEP_MS, nextDue - now()), signal);
  }
  log({ level: "info", event: "stopped" });
}
