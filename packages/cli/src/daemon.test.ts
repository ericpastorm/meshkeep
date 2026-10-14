import { KuboError } from "@meshkeep/kubo";
import { describe, expect, it } from "vitest";

import { abortableSleep, type DaemonEvent, runReplicaDaemon } from "./daemon.js";
import { CliError } from "./errors.js";
import type { ReplicateResult } from "./workflows.js";

const HOUR = 60 * 60_000;

function result(name: string, updated = false): ReplicateResult {
  return {
    name,
    cid: "bafyexample",
    sequence: 0,
    validity: "2027-01-01T00:00:00Z",
    versions: ["bafyexample"],
    maxBytes: 1,
    maxBlocks: 1,
    keep: 0,
    ownedPins: [],
    manual: true,
    updated,
    blocks: 1,
    bytes: 1,
    pruned: [],
  };
}

/**
 * Runs the daemon on a fake clock: each sleep advances time instantly, and the daemon is
 * stopped after `cycles` sleeps. Returns every replicate call with its time, and the log.
 */
async function simulate(options: {
  sites: () => readonly string[];
  replicate: (name: string, at: number) => Promise<ReplicateResult>;
  intervalMs?: number;
  cycles: number;
}) {
  let clock = 0;
  const controller = new AbortController();
  const calls: { name: string; at: number }[] = [];
  const events: DaemonEvent[] = [];
  const sleeps: number[] = [];
  await runReplicaDaemon({
    intervalMs: options.intervalMs ?? HOUR,
    signal: controller.signal,
    listSites: async () => options.sites(),
    replicate: async (name) => {
      calls.push({ name, at: clock });
      return options.replicate(name, clock);
    },
    log: (event) => events.push(event),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      if (sleeps.length >= options.cycles) {
        controller.abort();
      }
    },
  });
  return { calls, events, sleeps };
}

describe("runReplicaDaemon", () => {
  it("replicates every site once per interval and logs each run", async () => {
    const { calls, events } = await simulate({
      sites: () => ["a", "b"],
      replicate: async (name) => result(name),
      cycles: 3,
    });

    expect(calls).toEqual([
      { name: "a", at: 0 },
      { name: "b", at: 0 },
      { name: "a", at: HOUR },
      { name: "b", at: HOUR },
      { name: "a", at: 2 * HOUR },
      { name: "b", at: 2 * HOUR },
    ]);
    expect(events[0]).toEqual({ level: "info", event: "started", intervalSeconds: 3600 });
    expect(events[1]).toMatchObject({ level: "info", event: "current", name: "a" });
    expect(events.at(-1)).toEqual({ level: "info", event: "stopped" });
  });

  it("retries a failing site with exponential backoff without delaying the others", async () => {
    const { calls, events } = await simulate({
      sites: () => ["bad", "good"],
      replicate: async (name) => {
        if (name === "bad") {
          throw new KuboError("name/get", "routing: not found");
        }
        return result(name);
      },
      // Wakes at 60s, 180s, 420s, 900s, 1860s (bad), 3600s (good), 3780s (bad), 7200s (good).
      cycles: 9,
    });

    const failures = events.filter((event) => event.event === "failed");
    expect(failures.map((event) => event.retryInSeconds)).toEqual([
      60, 120, 240, 480, 960, 1920, 3600,
    ]);
    expect(failures[0]).toMatchObject({
      level: "warn",
      name: "bad",
      failures: 1,
      error: "kubo name/get: routing: not found",
    });
    expect(calls.filter((call) => call.name === "good").map((call) => call.at)).toEqual([
      0,
      HOUR,
      2 * HOUR,
    ]);
  });

  it("returns to the normal interval after a failing site recovers", async () => {
    let attempts = 0;
    const { calls } = await simulate({
      sites: () => ["flaky"],
      replicate: async (name) => {
        attempts += 1;
        if (attempts <= 2) {
          throw new CliError("fetching timed out");
        }
        return result(name, true);
      },
      cycles: 4,
    });

    expect(calls.map((call) => call.at)).toEqual([0, 60_000, 180_000, 180_000 + HOUR]);
  });

  it("caps the first retry at the interval when the interval is short", async () => {
    const { events } = await simulate({
      sites: () => ["bad"],
      replicate: async () => {
        throw new CliError("no valid record found");
      },
      intervalMs: 10_000,
      cycles: 2,
    });

    expect(events.filter((event) => event.event === "failed").map((e) => e.retryInSeconds)).toEqual(
      [10, 10],
    );
  });

  it("picks up added sites and forgets removed ones on the next cycle", async () => {
    let sites = ["a"];
    const { calls } = await simulate({
      sites: () => sites,
      replicate: async (name) => {
        sites = ["b"];
        return result(name);
      },
      cycles: 2,
    });

    expect(calls).toEqual([
      { name: "a", at: 0 },
      { name: "b", at: HOUR },
    ]);
  });

  it("keeps running when the replica state cannot be read", async () => {
    let reads = 0;
    const { events, sleeps } = await simulate({
      sites: () => {
        reads += 1;
        if (reads === 1) {
          throw new CliError("corrupt replica state");
        }
        return [];
      },
      replicate: async (name) => result(name),
      cycles: 2,
    });

    expect(events[1]).toEqual({
      level: "error",
      event: "state-unreadable",
      error: "corrupt replica state",
    });
    expect(sleeps).toEqual([HOUR, HOUR]);
  });

  it("propagates unexpected errors so a supervisor restarts the process", async () => {
    await expect(
      simulate({
        sites: () => ["a"],
        replicate: async () => {
          throw new TypeError("bug");
        },
        cycles: 1,
      }),
    ).rejects.toThrow("bug");
  });

  it("stops without logging a failure when stopped during a replication", async () => {
    const controller = new AbortController();
    const events: DaemonEvent[] = [];
    await runReplicaDaemon({
      intervalMs: HOUR,
      signal: controller.signal,
      listSites: async () => ["a"],
      replicate: async (_name, signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
        throw new KuboError("pin/add", "aborted");
      },
      log: (event) => events.push(event),
    });

    expect(events.map((event) => event.event)).toEqual(["started", "stopped"]);
  });
});

describe("runReplicaDaemon with followed books", () => {
  function refreshResult(curator: string, sites: string[]) {
    return { curator, bookCid: "bafybook", sites, added: sites, removed: [], dropped: [] };
  }

  it("refreshes books before sites, so a newly listed site is replicated in the same cycle", async () => {
    let listed: string[] = [];
    const order: string[] = [];
    const controller = new AbortController();
    const events: DaemonEvent[] = [];
    await runReplicaDaemon({
      intervalMs: HOUR,
      signal: controller.signal,
      listFollows: async () => ["curator"],
      refresh: async (curator) => {
        order.push(`refresh ${curator}`);
        listed = ["new-site"];
        return refreshResult(curator, listed);
      },
      listSites: async () => listed,
      replicate: async (name) => {
        order.push(`replicate ${name}`);
        return result(name, true);
      },
      log: (event) => events.push(event),
      now: () => 0,
      sleep: async () => controller.abort(),
    });

    expect(order).toEqual(["refresh curator", "replicate new-site"]);
    expect(events.find((event) => event.event === "book-refreshed")).toMatchObject({
      level: "info",
      curator: "curator",
      sites: 1,
      added: ["new-site"],
    });
  });

  it("backs off a failing book on its own schedule without holding back the sites", async () => {
    const { events, calls } = await (async () => {
      let clock = 0;
      const controller = new AbortController();
      const events: DaemonEvent[] = [];
      const calls: { name: string; at: number }[] = [];
      let sleeps = 0;
      await runReplicaDaemon({
        intervalMs: HOUR,
        signal: controller.signal,
        listFollows: async () => ["curator"],
        refresh: async () => {
          throw new CliError("the book is invalid");
        },
        listSites: async () => ["site"],
        replicate: async (name) => {
          calls.push({ name, at: clock });
          return result(name);
        },
        log: (event) => events.push(event),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          sleeps += 1;
          if (sleeps >= 3) {
            controller.abort();
          }
        },
      });
      return { events, calls };
    })();

    expect(
      events.filter((event) => event.event === "book-failed").map((e) => e.retryInSeconds),
    ).toEqual([60, 120, 240]);
    expect(calls).toEqual([{ name: "site", at: 0 }]);
  });
});

describe("abortableSleep", () => {
  it("resolves early when aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort();

    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves immediately when already aborted", async () => {
    await expect(abortableSleep(60_000, AbortSignal.abort())).resolves.toBeUndefined();
  });
});
