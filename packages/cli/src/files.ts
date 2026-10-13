import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { CliError } from "./errors.js";

/** Reads a small local file, refusing anything larger than `maxBytes`. */
export async function readLimitedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) {
      throw new CliError(`${path} is larger than ${maxBytes} bytes`);
    }
    return await readFile(handle);
  } finally {
    await handle.close();
  }
}

export async function readOptionalText(
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    return (await readLimitedFile(path, maxBytes)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Writes a private file atomically: temp file in the same directory, fsync, rename. */
export async function writePrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
}

/** Creates a new private file and fails if anything already exists at `path`. */
export async function createPrivateFile(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(`refusing to overwrite existing file ${path}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs `task` while holding an exclusive lock file containing this process's PID. A lock
 * left behind by a process that no longer exists is removed; a live holder is waited for up
 * to `waitMs`, then reported.
 */
export async function withFileLock<T>(
  path: string,
  task: () => Promise<T>,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const holder = Number((await readOptionalText(path, 64))?.trim());
    if (!Number.isSafeInteger(holder) || holder <= 0 || !processExists(holder)) {
      // Stale or unreadable: the holder is gone. Remove it and try again.
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new CliError(`${path} is held by another meshkeep process (pid ${holder}); try again`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
  }
  try {
    return await task();
  } finally {
    await rm(path, { force: true });
  }
}
