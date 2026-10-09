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
