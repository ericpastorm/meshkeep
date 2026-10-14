import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createAddressBook, encodeAddressBook, ipnsNameFromPublicKey } from "@meshkeep/protocol";
import { type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliRunner, FIXTURES } from "./cli.js";
import { KuboCluster } from "./cluster.js";

/**
 * The browser extension (ADR 0004) in Playwright's Chromium against a real Kubo gateway: the
 * address book page, the popup, and sites opened on their own `*.ipns.localhost` origins.
 */

const BUILD_SCRIPT = fileURLToPath(new URL("../../packages/extension/build.mjs", import.meta.url));

const cluster = new KuboCluster();
let scratch = "";
let context: BrowserContext;
let extensionId = "";
let gatewayPort = 0;
let site = "";
const { meshkeep } = cliRunner(cluster, () => scratch);

const page = (path: string) => `chrome-extension://${extensionId}/${path}`;

async function openPage(path: string): Promise<Page> {
  const tab = await context.newPage();
  await tab.goto(page(path));
  return tab;
}

/** A port nothing listens on: bind an ephemeral port, then release it. */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

async function setPort(book: Page, port: number) {
  const form = book.locator("#gateway-form");
  await form.getByLabel("Port").fill(String(port));
  await form.getByRole("button", { name: "Save", exact: true }).click();
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "meshkeep-extension-"));
  const extension = join(scratch, "extension");
  await promisify(execFile)(process.execPath, [BUILD_SCRIPT, extension]);

  await cluster.init();
  await cluster.start("gateway");
  site = String((await meshkeep("gateway", "key", "create", "demo")).name);
  await meshkeep("gateway", "publish", join(FIXTURES, "site-v1"), "--key", "demo");
  gatewayPort = Number(new URL(cluster.node("gateway").gatewayUrl).port);

  context = await chromium.launchPersistentContext(join(scratch, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

afterAll(async () => {
  await context?.close();
  await cluster.destroy();
  await rm(scratch, { recursive: true, force: true });
});

describe.sequential("browser extension", () => {
  it("shows whether a gateway answers on the configured port", async () => {
    const book = await openPage("book.html");
    const status = book.locator("#gateway-status");

    await setPort(book, await unusedPort());
    await expect.poll(() => status.textContent()).toMatch(/^No gateway answers on port \d+/);

    await setPort(book, gatewayPort);
    await expect.poll(() => status.textContent()).toBe(`A gateway answers on port ${gatewayPort}.`);
    await book.close();
  });

  it("adds a petname and opens the site from the popup on its own origin", async () => {
    const book = await openPage("book.html");
    await book.getByLabel("Petname", { exact: true }).fill("demo");
    await book.getByLabel("Address", { exact: true }).fill(site);
    await book.getByLabel("Note", { exact: true }).fill("Lab site");
    await book.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => book.locator("#notice").textContent()).toBe("Added demo");
    await expect.poll(() => book.locator('tr[data-petname="demo"]').count()).toBe(1);
    await book.close();

    const popup = await openPage("popup.html");
    await expect
      .poll(() => popup.locator("#gateway").textContent())
      .toBe(`Local gateway on port ${gatewayPort}`);
    await popup.getByLabel("Open a site").fill("dem");
    await expect.poll(() => popup.locator("#matches .petname").allTextContents()).toEqual(["demo"]);

    await popup.getByLabel("Open a site").fill("demo/");
    await popup.getByLabel("Open a site").press("Enter");
    await popup.waitForURL(`http://${site}.ipns.localhost:${gatewayPort}/`);
    expect(await popup.locator("h1").textContent()).toBe("Meshkeep lab — version 1");
    expect(await popup.evaluate(() => (globalThis as { origin?: string }).origin)).toBe(
      `http://${site}.ipns.localhost:${gatewayPort}`,
    );
    // A site is ordinary web content: it cannot see or reach the extension.
    const runtime = await popup.evaluate(
      () => (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id,
    );
    expect(runtime).toBeUndefined();
    await popup.close();
  });

  it("explains an unknown petname and links to adding it", async () => {
    const popup = await openPage("popup.html");
    await popup.getByLabel("Open a site").fill("nobody");
    await popup.getByLabel("Open a site").press("Enter");
    const message = popup.locator("#message");
    await expect
      .poll(() => message.textContent())
      .toBe("nobody is not in your address book Add it");
    expect(await message.getByRole("link").getAttribute("href")).toBe("book.html?add=nobody");
    expect(popup.url()).toBe(page("popup.html"));
    await popup.close();
  });

  it("opens a site in a new tab from the address book page", async () => {
    const book = await openPage("book.html");
    const opened = context.waitForEvent("page");
    await book
      .locator('tr[data-petname="demo"]')
      .getByRole("button", { name: "Open", exact: true })
      .click();
    const tab = await opened;
    await tab.waitForURL(`http://${site}.ipns.localhost:${gatewayPort}/`);
    expect(await tab.locator("h1").textContent()).toBe("Meshkeep lab — version 1");
    await tab.close();
    await book.close();
  });

  it("renames, exports, and imports the address book in the CLI's format", async () => {
    const book = await openPage("book.html");
    const notice = book.locator("#notice");
    const row = (petname: string) => book.locator(`tr[data-petname="${petname}"]`);

    await row("demo").getByRole("button", { name: "Rename", exact: true }).click();
    await book.getByLabel("New petname for demo").fill("lab");
    await book.getByRole("button", { name: "Save", exact: true }).first().click();
    await expect.poll(() => notice.textContent()).toBe("Renamed demo to lab");

    const download = book.waitForEvent("download");
    await book.getByRole("button", { name: "Export", exact: true }).click();
    const exported = await readFile(await (await download).path(), "utf8");
    expect(exported).toBe(
      encodeAddressBook(createAddressBook([{ petname: "lab", name: site, note: "Lab site" }])),
    );
    const file = join(scratch, "exported.json");
    await writeFile(file, exported);

    const remove = row("lab").getByRole("button", { name: "Remove", exact: true });
    await remove.click();
    await row("lab").getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect.poll(() => notice.textContent()).toBe("Removed lab");
    expect(await book.locator("#empty").isVisible()).toBe(true);

    const importForm = book.locator("#import-form");
    await importForm.getByLabel("Address book file").setInputFiles(file);
    await importForm.getByRole("button", { name: "Import", exact: true }).click();
    await expect
      .poll(() => notice.textContent())
      .toBe("Imported: 1 added, 0 replaced, 0 already present");

    const other = ipnsNameFromPublicKey(new Uint8Array(32).fill(9));
    const conflicting = join(scratch, "conflicting.json");
    await writeFile(
      conflicting,
      encodeAddressBook(createAddressBook([{ petname: "lab", name: other }])),
    );
    await importForm.getByLabel("Address book file").setInputFiles(conflicting);
    await importForm.getByRole("button", { name: "Import", exact: true }).click();
    await expect
      .poll(() => notice.textContent())
      .toBe("petname already exists with a different address or note: lab");

    await importForm.getByLabel("Address book file").setInputFiles(conflicting);
    await importForm.getByLabel("Replace petnames that already exist").check();
    await importForm.getByRole("button", { name: "Import", exact: true }).click();
    await expect
      .poll(() => notice.textContent())
      .toBe("Imported: 0 added, 1 replaced, 0 already present");
    expect(await row("lab").locator("code").getAttribute("title")).toBe(other);
    await book.close();
  });
});
