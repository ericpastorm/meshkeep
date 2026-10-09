import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSupportedNode, resolveHome, runCli } from "./index.js";
import { readSite } from "./site.js";

const NAME = "k51qzi5uqu5dg9ufswxt229ntzdy7p4125xzv5rtyjso89ajdujg6csfxcj260";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "meshkeep-cli-test-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  await runCli(["node", "meshkeep", ...args], {
    env: { MESHKEEP_HOME: home },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return { stdout, stderr, exitCode };
}

describe("environment", () => {
  it("resolves the state directory from MESHKEEP_HOME, then XDG_CONFIG_HOME", () => {
    expect(resolveHome({ MESHKEEP_HOME: "/state" })).toBe("/state");
    expect(resolveHome({ XDG_CONFIG_HOME: "/config" })).toBe("/config/meshkeep");
  });

  it.each([
    ["22.12.0", true],
    ["24.1.0", true],
    ["26.8.2", true],
    ["21.7.3", false],
    ["garbage", false],
  ])("Node %s supported: %s", (version, expected) => {
    expect(isSupportedNode(version)).toBe(expected);
  });

  it("prints its version", async () => {
    expect((await run("version")).stdout).toBe("0.1.0-dev\n");
  });

  it("returns commander's exit code for usage errors", async () => {
    const result = await run("no-such-command");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });

  it("refuses a non-loopback Kubo RPC URL before connecting", async () => {
    const result = await run("--api", "http://192.0.2.10:5001", "resolve", NAME);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "meshkeep: kubo config: refusing non-loopback Kubo RPC endpoint: 192.0.2.10:5001\n",
    );
  });
});

describe("keys", () => {
  it("creates a private key file and lists its address", async () => {
    const created = await run("--json", "key", "create", "blog");
    const { name } = JSON.parse(created.stdout) as { name: string };

    expect(created.exitCode).toBe(0);
    expect(name).toMatch(/^k51/);
    expect((await stat(join(home, "keys", "blog.key"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "keys"))).mode & 0o777).toBe(0o700);
    expect(JSON.parse((await run("--json", "key", "list")).stdout)).toEqual({
      keys: [{ label: "blog", name }],
    });
  });

  it("refuses to overwrite an existing key", async () => {
    await run("key", "create", "blog");
    const again = await run("key", "create", "blog");
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("refusing to overwrite");
  });

  it("moves a key through export and import with the same address", async () => {
    const { name } = JSON.parse((await run("--json", "key", "create", "blog")).stdout);
    const file = join(home, "transfer.key");

    expect((await run("key", "export", "blog", file)).exitCode).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const imported = await run("--json", "key", "import", "blog-copy", file);
    expect(JSON.parse(imported.stdout)).toEqual({ label: "blog-copy", name });
  });

  it("rejects a key file whose public half does not match its seed", async () => {
    await run("key", "create", "blog");
    const bytes = await readFile(join(home, "keys", "blog.key"));
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    const file = join(home, "tampered.key");
    await writeFile(file, bytes);

    const result = await run("key", "import", "tampered", file);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("public key does not match");
  });

  it("rejects invalid labels", async () => {
    const result = await run("key", "create", "../escape");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("petname must be");
  });
});

describe("address book", () => {
  it("adds, lists, exports, and removes petnames", async () => {
    expect((await run("book", "add", "demo", `/ipns/${NAME}`, "--note", "A demo")).exitCode).toBe(
      0,
    );
    expect((await run("book", "list")).stdout).toBe(`demo\t${NAME}\tA demo\n`);

    const exported = (await run("book", "export")).stdout;
    expect(JSON.parse(exported)).toEqual({
      format: "meshkeep-address-book-v1",
      entries: [{ petname: "demo", name: NAME, note: "A demo" }],
    });

    expect((await run("book", "remove", "demo")).exitCode).toBe(0);
    expect((await run("book", "list")).stdout).toBe("address book is empty\n");
  });

  it("refuses duplicate petnames unless --replace is given", async () => {
    await run("book", "add", "demo", NAME);
    const duplicate = await run("book", "add", "demo", NAME);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toBe("meshkeep: petname already exists: demo\n");
    expect((await run("book", "add", "demo", NAME, "--replace")).exitCode).toBe(0);
  });

  it("imports a shared address book", async () => {
    const shared = join(home, "shared.json");
    await writeFile(
      shared,
      JSON.stringify({
        format: "meshkeep-address-book-v1",
        entries: [{ petname: "friend", name: NAME }],
      }),
    );
    expect((await run("book", "import", shared)).stdout).toBe("imported 1 entries\n");
    expect((await run("book", "list")).stdout).toBe(`friend\t${NAME}\n`);
  });

  it("rejects an unknown petname before contacting Kubo", async () => {
    const result = await run("--api", "http://127.0.0.1:1", "resolve", "nobody");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown petname nobody");
  });
});

describe("site directory", () => {
  it("reads files and directories in a deterministic order", async () => {
    const site = join(home, "site");
    await mkdir(join(site, "b"), { recursive: true });
    await mkdir(join(site, ".well-known"));
    await writeFile(join(site, "index.html"), "hi");
    await writeFile(join(site, "b", "a.txt"), "a");
    await writeFile(join(site, ".well-known", "security.txt"), "x");

    const contents = await readSite(site);
    expect(contents.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "directory:",
      "directory:.well-known",
      "file:.well-known/security.txt",
      "directory:b",
      "file:b/a.txt",
      "file:index.html",
    ]);
    expect(contents.files).toBe(3);
    expect(contents.bytes).toBe(4);
  });

  it("refuses hidden files unless included explicitly", async () => {
    const site = join(home, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "hi");
    await writeFile(join(site, ".env"), "SECRET=1");

    await expect(readSite(site)).rejects.toThrow("refusing hidden path .env");
    await expect(readSite(site, { includeHidden: true })).resolves.toMatchObject({ files: 2 });
  });

  it("refuses symlinks instead of following them", async () => {
    const site = join(home, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "hi");
    await symlink("/etc/passwd", join(site, "passwd"));

    await expect(readSite(site)).rejects.toThrow("refusing passwd");
  });

  it("refuses empty directories and non-directories", async () => {
    await mkdir(join(home, "empty"));
    await expect(readSite(join(home, "empty"))).rejects.toThrow("contains no files");
    await expect(readSite(join(home, "missing"))).rejects.toThrow("is not a directory");
  });
});
