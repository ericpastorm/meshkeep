import { KuboError } from "@meshkeep/kubo";
import { ProtocolError } from "@meshkeep/protocol";

import { CliError } from "./errors.js";
import type { RefreshResult } from "./follows.js";
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
  /** Curators of the followed books; read again on every cycle. Refreshed before the sites. */
  readonly listFollows?: () => Promise<readonly string[]>;
  readonly refresh?: (curator: string, signal: AbortSignal) => Promise<RefreshResult>;
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
 * Keeps every followed book and every replicated site current until `signal` aborts. Each
 * book and each site is handled once per interval; a failing one is retried with exponential
 * backoff (1 min, 2 min, …, capped at the interval) without delaying the others. Books are
 * refreshed before sites, so a site a book just added is replicated in the same cycle.
 * Operational failures (Kubo, network, limits, state) are logged and retried; anything else
 * is a bug and propagates so a supervisor restarts us.
 */
export async function runReplicaDaemon(options: DaemonOptions): Promise<void> {
  const { intervalMs, signal, log } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const retryBaseMs = Math.min(MAX_RETRY_BASE_MS, intervalMs);
  const schedule = new Map<string, { due: number; failures: number }>();

  /** Runs one scheduled task if it is due; returns false when the daemon is stopping. */
  async function runDue(
    key: string,
    fields: Record<string, unknown>,
    task: () => Promise<Record<string, unknown> & { event: string }>,
  ): Promise<boolean> {
    const entry = schedule.get(key) ?? { due: 0, failures: 0 };
    if (signal.aborted) {
      return false;
    }
    if (entry.due > now()) {
      return true;
    }
    try {
      const outcome = await task();
      schedule.set(key, { due: now() + intervalMs, failures: 0 });
      log({ level: "info", ...fields, ...outcome, nextRunSeconds: intervalMs / 1000 });
    } catch (error) {
      if (signal.aborted) {
        return false;
      }
      if (!isOperationalError(error)) {
        throw error;
      }
      const failures = entry.failures + 1;
      const delayMs = Math.min(intervalMs, retryBaseMs * 2 ** (failures - 1));
      schedule.set(key, { due: now() + delayMs, failures });
      log({
        level: "warn",
        event: key.startsWith("book:") ? "book-failed" : "failed",
        ...fields,
        error: error.message,
        failures,
        retryInSeconds: delayMs / 1000,
      });
    }
    return true;
  }

  log({ level: "info", event: "started", intervalSeconds: intervalMs / 1000 });
  cycle: while (!signal.aborted) {
    let curators: readonly string[];
    let names: readonly string[];
    try {
      curators = options.listFollows === undefined ? [] : await options.listFollows();
      const keys = new Set(curators.map((curator) => `book:${curator}`));
      for (const curator of curators) {
        const refresh = options.refresh;
        if (refresh === undefined) {
          break;
        }
        const running = await runDue(`book:${curator}`, { curator }, async () => {
          const result = await refresh(curator, signal);
          return {
            event: "book-refreshed",
            bookCid: result.bookCid,
            sites: result.sites.length,
            added: result.added,
            removed: result.removed,
            dropped: result.dropped.map((drop) => drop.name),
          };
        });
        if (!running) {
          break cycle;
        }
      }
      // Read the sites after the books, which may have added or dropped some.
      names = await options.listSites();
      for (const name of names) {
        keys.add(name);
      }
      for (const key of schedule.keys()) {
        if (!keys.has(key)) {
          schedule.delete(key);
        }
      }
    } catch (error) {
      if (!isOperationalError(error)) {
        throw error;
      }
      log({ level: "error", event: "state-unreadable", error: error.message });
      await sleep(intervalMs, signal);
      continue;
    }

    for (const name of names) {
      const running = await runDue(name, { name }, async () => {
        const result = await options.replicate(name, signal);
        return {
          event: result.updated ? "updated" : "current",
          cid: result.cid,
          sequence: result.sequence,
          versions: result.versions.length,
          pruned: result.pruned,
        };
      });
      if (!running) {
        break cycle;
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
