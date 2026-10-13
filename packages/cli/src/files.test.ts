import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "./files.js";

let dir: string;
let lock: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "meshkeep-lock-test-"));
  lock = join(dir, "state.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("holds the lock while the task runs and removes it afterwards", async () => {
    const seen = await withFileLock(lock, async () => readFile(lock, "utf8"));

    expect(seen).toBe(`${process.pid}\n`);
    await expect(readFile(lock)).rejects.toThrow();
  });

  it("removes the lock even when the task fails", async () => {
    await expect(
      withFileLock(lock, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(readFile(lock)).rejects.toThrow();
  });

  it("serializes tasks in the same process", async () => {
    const order: string[] = [];
    const task = (label: string) =>
      withFileLock(
        lock,
        async () => {
          order.push(`${label} start`);
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(`${label} end`);
        },
        { pollMs: 5 },
      );

    await Promise.all([task("a"), task("b")]);
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("takes over a lock left by a process that no longer exists", async () => {
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(lock, `${exited}\n`);

    await expect(withFileLock(lock, async () => "ran")).resolves.toBe("ran");
  });

  it("reports a lock held by a live process after waiting", async () => {
    await writeFile(lock, `${process.ppid}\n`);

    await expect(withFileLock(lock, async () => "ran", { waitMs: 50, pollMs: 10 })).rejects.toThrow(
      `held by another meshkeep process (pid ${process.ppid})`,
    );
    expect(await readFile(lock, "utf8")).toBe(`${process.ppid}\n`);
  });
});
