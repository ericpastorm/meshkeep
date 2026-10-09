import { describe, expect, it } from "vitest";

import { KuboClient, KuboError, parseApiUrl } from "./index.js";

describe("parseApiUrl", () => {
  it.each([
    "http://127.0.0.1:5001",
    "http://127.8.0.1:5001",
    "http://localhost:5001",
    "http://[::1]:5001",
  ])("accepts loopback %s", (url) => {
    expect(parseApiUrl(url).href).toBe(new URL(url).href);
  });

  it.each([
    "http://192.0.2.10:5001",
    "http://example.com:5001",
    "http://0.0.0.0:5001",
    "http://127.0.0.1.example.com:5001",
  ])("refuses non-loopback %s by default", (url) => {
    expect(() => parseApiUrl(url)).toThrow(/non-loopback/);
    expect(parseApiUrl(url, { allowRemote: true }).host).toBe(new URL(url).host);
  });

  it.each([
    "ftp://127.0.0.1:5001",
    "http://user:pass@127.0.0.1:5001",
    "http://127.0.0.1:5001/?x=1",
    "not a url",
  ])("rejects malformed endpoint %s", (url) => {
    expect(() => parseApiUrl(url)).toThrow(KuboError);
  });
});

function fakeKubo(respond: (url: URL) => Response) {
  const calls: URL[] = [];
  const client = new KuboClient({
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      return respond(url);
    },
  });
  return { client, calls };
}

describe("KuboClient", () => {
  it("POSTs to /api/v0 with query arguments", async () => {
    const { client, calls } = fakeKubo(() => Response.json({ Path: "/ipfs/bafy" }));

    await expect(client.resolveName("k51abc")).resolves.toBe("/ipfs/bafy");
    expect(calls[0]?.pathname).toBe("/api/v0/name/resolve");
    expect(calls[0]?.searchParams.get("arg")).toBe("k51abc");
    expect(calls[0]?.searchParams.get("nocache")).toBe("true");
  });

  it("surfaces Kubo's JSON error message", async () => {
    const { client } = fakeKubo(() =>
      Response.json({ Message: "routing: not found", Code: 0, Type: "error" }, { status: 500 }),
    );

    await expect(client.resolveName("k51abc")).rejects.toThrow(
      "kubo name/resolve: routing: not found",
    );
  });

  it("detects errors inside newline-delimited streams", async () => {
    const { client } = fakeKubo(
      () => new Response('{"Ref":"bafy1","Err":""}\n{"Ref":"","Err":"block not found"}\n'),
    );

    await expect(client.localDagStat("bafy")).rejects.toThrow("block not found");
  });

  it("rejects responses that lack required fields", async () => {
    const { client } = fakeKubo(() => Response.json({}));

    await expect(client.version()).rejects.toThrow("response is missing Version");
  });

  it("refuses an inspected record that fails validation", async () => {
    const { client } = fakeKubo(() =>
      Response.json({
        Entry: { Value: "/ipfs/bafy", Sequence: 0, Validity: "x", TTL: 1 },
        Validation: { Valid: false, Reason: "signature verification failed" },
      }),
    );

    await expect(client.inspectRecord(new Uint8Array([1]), "k51abc")).rejects.toThrow(
      "record is not valid for k51abc: signature verification failed",
    );
  });

  it("reports an unreachable daemon without leaking a stack trace", async () => {
    const client = new KuboClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(client.version()).rejects.toThrow("kubo version: unreachable at 127.0.0.1:5001");
  });
});
