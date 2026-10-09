import { openAsBlob } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { UploadEntry } from "@meshkeep/kubo";

import { CliError } from "./errors.js";

export const MAX_SITE_FILES = 100_000;
export const MAX_SITE_BYTES = 2 * 1024 ** 3;

/** Hidden paths usually hold secrets or tooling (`.env`, `.git`); `.well-known` is web-standard. */
const ALLOWED_HIDDEN = new Set([".well-known"]);

export interface SiteContents {
  readonly entries: UploadEntry[];
  readonly files: number;
  readonly bytes: number;
}

/**
 * Reads a static site directory into upload entries in a deterministic order. Symlinks and
 * special files are refused rather than followed, and hidden paths need explicit opt-in.
 */
export async function readSite(
  root: string,
  options: { includeHidden?: boolean } = {},
): Promise<SiteContents> {
  const rootStat = await lstat(root).catch(() => undefined);
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new CliError(`${root} is not a directory`);
  }
  const entries: UploadEntry[] = [{ kind: "directory", path: "" }];
  let files = 0;
  let bytes = 0;

  async function walk(relative: string): Promise<void> {
    const names = (await readdir(join(root, relative))).sort();
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (name.startsWith(".") && !ALLOWED_HIDDEN.has(name) && options.includeHidden !== true) {
        throw new CliError(`refusing hidden path ${path}; pass --include-hidden to publish it`);
      }
      const absolute = join(root, path);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        entries.push({ kind: "directory", path });
        await walk(path);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > MAX_SITE_FILES || bytes > MAX_SITE_BYTES) {
          throw new CliError(
            `site exceeds the limit of ${MAX_SITE_FILES} files or ${MAX_SITE_BYTES} bytes`,
          );
        }
        entries.push({ kind: "file", path, content: await openAsBlob(absolute) });
      } else {
        throw new CliError(`refusing ${path}: only regular files and directories can be published`);
      }
    }
  }

  await walk("");
  if (files === 0) {
    throw new CliError(`${root} contains no files`);
  }
  return { entries, files, bytes };
}
