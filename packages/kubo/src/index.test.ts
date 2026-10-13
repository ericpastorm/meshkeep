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

/** A response whose body yields the given chunks, then optionally fails or stays open. */
function streamingResponse(chunks: string[], end: "close" | "hang" | Error = "close") {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        if (end === "close") {
          controller.close();
        } else if (end instanceof Error) {
          controller.error(end);
        }
      },
    }),
  );
}

describe("KuboClient.pinRecursive", () => {
  const CID = "bafyroot";

  function pinningKubo(response: () => Response) {
    let signal: AbortSignal | undefined;
    const client = new KuboClient({
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return response();
      },
    });
    return { client, signal: () => signal };
  }

  it("streams progress, split across chunk boundaries, until Kubo confirms the pin", async () => {
    const { client } = pinningKubo(() =>
      streamingResponse([
        "{}\n",
        '{"Progress":3,"By',
        'tes":300}\n{"Progress":8,"Bytes":1083}\n',
        `{"Pins":["${CID}"]}\n`,
      ]),
    );
    const progress: unknown[] = [];

    await client.pinRecursive(CID, { onProgress: (update) => progress.push(update) });
    expect(progress).toEqual([
      { blocks: 3, bytes: 300 },
      { blocks: 8, bytes: 1083 },
    ]);
  });

  it("aborts the request and rethrows when the progress callback throws", async () => {
    const { client, signal } = pinningKubo(() =>
      streamingResponse(['{"Progress":5,"Bytes":10}\n'], "hang"),
    );
    const stop = new Error("over limit");

    await expect(
      client.pinRecursive(CID, {
        onProgress: () => {
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(signal()?.aborted).toBe(true);
  });

  it("fails when the stream ends without confirming the pin", async () => {
    const { client } = pinningKubo(() => streamingResponse(['{"Progress":2,"Bytes":5}\n']));

    await expect(client.pinRecursive(CID)).rejects.toThrow("without confirming the pin");
  });

  it("reports a deadline hit while streaming the body as a timeout", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const { client } = pinningKubo(() => streamingResponse(["{}\n"], timeout));

    const error = await client.pinRecursive(CID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KuboError);
    expect((error as KuboError).timedOut).toBe(true);
    expect((error as KuboError).message).toBe("kubo pin/add: timed out");
  });

  it("rejects malformed streamed lines without leaking a SyntaxError", async () => {
    const { client } = pinningKubo(() => streamingResponse(["{not json}\n"]));

    await expect(client.pinRecursive(CID)).rejects.toThrow(
      "kubo pin/add: malformed streamed JSON line",
    );
  });
});

describe("KuboClient.declaredSize", () => {
  it("returns the root's CumulativeSize", async () => {
    const { client, calls } = fakeKubo(() => Response.json({ CumulativeSize: 1083 }));

    await expect(client.declaredSize("bafyroot")).resolves.toBe(1083);
    expect(calls[0]?.pathname).toBe("/api/v0/files/stat");
    expect(calls[0]?.searchParams.get("arg")).toBe("/ipfs/bafyroot");
  });

  it("rejects a missing or negative size", async () => {
    const { client } = fakeKubo(() => Response.json({ CumulativeSize: -1 }));

    await expect(client.declaredSize("bafyroot")).rejects.toThrow("invalid CumulativeSize");
  });
});
