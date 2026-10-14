import {
  createAddressBook,
  encodeAddressBook,
  ipnsNameFromPublicKey,
  ProtocolError,
} from "@meshkeep/protocol";
import { describe, expect, it } from "vitest";

import { probeGateway } from "./gateway.js";
import { parseRequest, RequestError } from "./messages.js";
import { type Disposition, ExtensionService, errorReply, isExpectedError } from "./service.js";
import { ExtensionState, type KeyValueStorage, StateError } from "./state.js";
import { escapeXml, matchEntries } from "./suggest.js";
import { TargetError } from "./target.js";

const A = ipnsNameFromPublicKey(new Uint8Array(32).fill(1));
const B = ipnsNameFromPublicKey(new Uint8Array(32).fill(2));

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, unknown>();
  writes = 0;

  async get(key: string): Promise<unknown> {
    await Promise.resolve();
    return structuredClone(this.values.get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    this.writes += 1;
    this.values.set(key, structuredClone(value));
  }
}

function setup(options: { gateway?: (url: string) => Promise<Response> } = {}) {
  const storage = new MemoryStorage();
  const opened: { url: string; disposition: Disposition; tabId?: number }[] = [];
  const state = new ExtensionState(storage);
  const service = new ExtensionService({
    state,
    fetch: options.gateway ?? (() => Promise.reject(new TypeError("connection refused"))),
    pageUrl: (path) => `chrome-extension://test/${path}`,
    tabs: {
      async open(url, disposition, tabId) {
        opened.push({ url, disposition, ...(tabId === undefined ? {} : { tabId }) });
      },
    },
  });
  return { storage, state, service, opened };
}

describe("address book requests", () => {
  it("adds, renames, and removes entries, storing canonical text", async () => {
    const { service, storage } = setup();
    expect(await service.handle({ type: "book" })).toEqual({ entries: [] });

    await service.handle({ type: "add", petname: "blog", name: `/ipns/${A}`, note: "a friend" });
    await service.handle({ type: "add", petname: "wiki", name: B });
    await service.handle({ type: "rename", from: "blog", to: "a-blog" });
    await service.handle({ type: "remove", petname: "wiki" });

    const expected = createAddressBook([{ petname: "a-blog", name: A, note: "a friend" }]);
    expect(storage.values.get("addressBook")).toBe(encodeAddressBook(expected));
    expect(await service.handle({ type: "export" })).toEqual({
      text: encodeAddressBook(expected),
    });
  });

  it("refuses invalid entries and duplicate petnames without writing", async () => {
    const { service, storage } = setup();
    await service.handle({ type: "add", petname: "blog", name: A });
    const writes = storage.writes;

    await expect(service.handle({ type: "add", petname: "blog", name: B })).rejects.toThrow(
      "petname already exists",
    );
    await expect(service.handle({ type: "add", petname: "Bad Name", name: B })).rejects.toThrow(
      ProtocolError,
    );
    await expect(service.handle({ type: "add", petname: "x", name: "bafy-not" })).rejects.toThrow(
      ProtocolError,
    );
    await expect(service.handle({ type: "rename", from: "nope", to: "x" })).rejects.toThrow(
      "unknown petname",
    );
    expect(storage.writes).toBe(writes);
  });

  it("applies concurrent changes one at a time, so none is lost", async () => {
    const { service } = setup();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.handle({
          type: "add",
          petname: `site-${index}`,
          name: ipnsNameFromPublicKey(new Uint8Array(32).fill(index + 10)),
        }),
      ),
    );
    expect((await service.handle({ type: "book" })).entries).toHaveLength(20);
  });

  it("imports a shared book, merging identical entries and refusing conflicts", async () => {
    const { service } = setup();
    await service.handle({ type: "add", petname: "blog", name: A });
    const shared = encodeAddressBook(
      createAddressBook([
        { petname: "blog", name: A },
        { petname: "wiki", name: B },
      ]),
    );
    expect(await service.handle({ type: "import", text: shared, replace: false })).toEqual({
      added: ["wiki"],
      replaced: [],
      unchanged: ["blog"],
    });

    const conflicting = encodeAddressBook(createAddressBook([{ petname: "blog", name: B }]));
    await expect(
      service.handle({ type: "import", text: conflicting, replace: false }),
    ).rejects.toThrow("petname already exists");
    expect(await service.handle({ type: "import", text: conflicting, replace: true })).toEqual({
      added: [],
      replaced: ["blog"],
      unchanged: [],
    });
    await expect(
      service.handle({ type: "import", text: '{"format":"other"}', replace: false }),
    ).rejects.toThrow("unsupported address book format");
  });

  it("reports a damaged stored book instead of overwriting it", async () => {
    const { service, storage } = setup();
    storage.values.set("addressBook", "{not json");
    await expect(service.handle({ type: "book" })).rejects.toThrow(StateError);
    await expect(service.handle({ type: "add", petname: "blog", name: A })).rejects.toThrow(
      "the stored address book cannot be read",
    );
    expect(storage.values.get("addressBook")).toBe("{not json");
  });
});

describe("settings and gateway", () => {
  it("defaults to port 8080 and stores a valid port", async () => {
    const { service, storage } = setup();
    expect(await service.handle({ type: "settings" })).toEqual({ gatewayPort: 8080 });
    expect(await service.handle({ type: "set-gateway-port", port: 48080 })).toEqual({
      gatewayPort: 48080,
    });
    await expect(service.handle({ type: "set-gateway-port", port: 0 })).rejects.toThrow(
      TargetError,
    );
    storage.values.set("settings", { gatewayPort: "garbage" });
    expect(await service.handle({ type: "settings" })).toEqual({ gatewayPort: 8080 });
  });

  it("probes the subdomain gateway with the empty identity CID", async () => {
    const requested: string[] = [];
    const { service } = setup({
      gateway: async (url) => {
        requested.push(url);
        return new Response(new Uint8Array(0), { status: 200 });
      },
    });
    expect(await service.handle({ type: "probe" })).toEqual({ port: 8080, reachable: true });
    expect(requested).toEqual(["http://bafkqaaa.ipfs.localhost:8080/"]);
  });

  it("treats errors, failures, and unexpected bodies as unreachable", async () => {
    const answers = [
      () => Promise.reject(new TypeError("refused")),
      async () => new Response("not found", { status: 404 }),
      async () => new Response("<html>a different server</html>", { status: 200 }),
    ];
    for (const answer of answers) {
      expect(await probeGateway(8080, answer)).toBe(false);
    }
  });
});

describe("opening sites", () => {
  it("opens a petname with its path in the tab that asked", async () => {
    const { service, opened } = setup();
    await service.handle({ type: "add", petname: "blog", name: A });
    await service.handle({ type: "set-gateway-port", port: 48080 });

    const reply = await service.handle(
      { type: "open", input: "blog/posts/?page=2", newTab: false },
      { tabId: 7 },
    );
    expect(reply).toEqual({ url: `http://${A}.ipns.localhost:48080/posts/?page=2` });
    expect(opened).toEqual([{ url: reply.url, disposition: "currentTab", tabId: 7 }]);

    await service.handle({ type: "open", input: B, newTab: true });
    expect(opened[1]).toEqual({
      url: `http://${B}.ipns.localhost:48080/`,
      disposition: "newForegroundTab",
    });
  });

  it("opens nothing for an unknown petname", async () => {
    const { service, opened } = setup();
    await expect(service.handle({ type: "open", input: "nope", newTab: false })).rejects.toThrow(
      "nope is not in your address book",
    );
    expect(opened).toEqual([]);
  });

  it("sends omnibox mistakes to the address book page", async () => {
    const { service, opened } = setup();
    await service.handle({ type: "add", petname: "blog", name: A });

    await service.openFromOmnibox("blog/about", "newBackgroundTab");
    await service.openFromOmnibox("their-wiki", "currentTab");
    await service.openFromOmnibox("not valid", "currentTab");

    expect(opened.map((entry) => [entry.url, entry.disposition])).toEqual([
      [`http://${A}.ipns.localhost:8080/about`, "newBackgroundTab"],
      ["chrome-extension://test/book.html?add=their-wiki", "currentTab"],
      [
        `chrome-extension://test/book.html?error=${encodeURIComponent("not a petname or an address: not valid")}`,
        "currentTab",
      ],
    ]);
  });

  it("suggests matching petnames, keeping the typed path", async () => {
    const { service } = setup();
    await service.handle({ type: "add", petname: "blog", name: A, note: "<Tom & Ann>" });
    await service.handle({ type: "add", petname: "my-blog", name: B });

    const suggestions = await service.suggest("blo/x");
    expect(suggestions.map((suggestion) => suggestion.content)).toEqual(["blog/x", "my-blog/x"]);
    const byAddress = await service.suggest(`ipns://${A}/posts`);
    expect(byAddress.map((suggestion) => suggestion.content)).toEqual(["blog/posts"]);
    expect(suggestions[0]?.description).toBe(
      `<match>blog</match> <dim>&#60;Tom &#38; Ann&#62; · ${A.slice(0, 12)}…</dim>`,
    );
  });
});

describe("matchEntries", () => {
  const book = createAddressBook([
    { petname: "alpha", name: A, note: "Recipes" },
    { petname: "beta-blog", name: B },
    { petname: "blog", name: B },
  ]);

  it("ranks petname prefixes, then substrings, notes, and addresses", () => {
    const petnames = (input: string) => matchEntries(book, input).map((entry) => entry.petname);
    expect(petnames("")).toEqual(["alpha", "beta-blog", "blog"]);
    expect(petnames("blog")).toEqual(["blog", "beta-blog"]);
    expect(petnames("RECIPES")).toEqual(["alpha"]);
    expect(petnames(A.slice(0, 20))).toEqual(["alpha"]);
    expect(petnames("zzz")).toEqual([]);
    expect(matchEntries(book, "", 2)).toHaveLength(2);
  });

  it("escapes omnibox markup", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      "&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;",
    );
  });
});

describe("requests from pages", () => {
  it("accepts well-formed requests and drops an empty note", () => {
    expect(parseRequest({ type: "book" })).toEqual({ type: "book" });
    expect(parseRequest({ type: "add", petname: "a", name: A, note: "" })).toEqual({
      type: "add",
      petname: "a",
      name: A,
    });
    expect(parseRequest({ type: "open", input: "a", newTab: true, extra: 1 })).toEqual({
      type: "open",
      input: "a",
      newTab: true,
    });
  });

  it("refuses anything else", () => {
    for (const request of [
      null,
      "book",
      [],
      { type: "unknown" },
      { type: "add", petname: "a" },
      { type: "add", petname: "a", name: 5 },
      { type: "import", text: "{}", replace: "yes" },
      { type: "open", input: "a".repeat(5000), newTab: false },
      { type: "set-gateway-port", port: "8080" },
    ]) {
      expect(() => parseRequest(request)).toThrow(RequestError);
    }
  });

  it("turns failures into replies without leaking unexpected details", () => {
    expect(errorReply(new TargetError("unknown-petname", "x is missing", "x"))).toEqual({
      ok: false,
      error: "x is missing",
      code: "unknown-petname",
      petname: "x",
    });
    expect(errorReply(new RequestError("bad"))).toEqual({ ok: false, error: "bad" });
    const unexpected = new Error("internal detail");
    expect(isExpectedError(unexpected)).toBe(false);
    expect(errorReply(unexpected).error).not.toContain("internal detail");
  });
});
