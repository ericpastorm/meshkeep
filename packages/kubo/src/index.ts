import { isIP } from "node:net";

export const DEFAULT_API_URL = "http://127.0.0.1:5001";
const DEFAULT_TIMEOUT_MS = 60_000;

export class KuboError extends Error {
  readonly command: string;
  readonly status: number | undefined;
  /** True when the request hit its deadline, while connecting or while streaming the body. */
  readonly timedOut: boolean;

  constructor(
    command: string,
    message: string,
    options: { status?: number; timedOut?: boolean } = {},
  ) {
    super(`kubo ${command}: ${message}`);
    this.name = "KuboError";
    this.command = command;
    this.status = options.status;
    this.timedOut = options.timedOut ?? false;
  }
}

export interface PinProgress {
  readonly blocks: number;
  readonly bytes: number;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") {
    return true;
  }
  return isIP(host) === 4 && host.startsWith("127.");
}

/**
 * Validates a Kubo RPC base URL. The RPC is privileged, so only plain-HTTP loopback endpoints
 * are accepted unless the caller explicitly opts into a remote, operator-protected endpoint.
 */
export function parseApiUrl(input: string, options: { allowRemote?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new KuboError("config", `invalid API URL: ${JSON.stringify(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KuboError("config", `API URL must use http or https: ${input}`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new KuboError("config", "API URL must not contain credentials, a query, or a fragment");
  }
  if (options.allowRemote !== true && !isLoopbackHost(url.hostname)) {
    throw new KuboError("config", `refusing non-loopback Kubo RPC endpoint: ${url.host}`);
  }
  return url;
}

/** A directory tree entry. Paths are slash-separated and relative; `""` is the root. */
export type UploadEntry =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "file"; readonly path: string; readonly content: Blob };

const DIRECTORY_PART = new Blob([], { type: "application/x-directory" });

export interface IpnsRecordEntry {
  readonly value: string;
  readonly sequence: number;
  readonly validity: string;
  readonly ttlNanoseconds: number;
}

export interface PublishOptions {
  readonly key: string;
  readonly lifetime: string;
  readonly ttl: string;
  readonly sequence?: number;
  readonly allowOffline?: boolean;
}

type Params = Record<string, string | number | boolean | undefined>;

interface CallOptions {
  readonly body?: FormData;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Converts a failure while sending or reading a request into a KuboError. */
function transportError(command: string, error: unknown, host: string): KuboError {
  if (error instanceof KuboError) {
    return error;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new KuboError(command, "timed out", { timedOut: true });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new KuboError(command, "aborted");
  }
  return new KuboError(command, `unreachable at ${host}`);
}

export interface KuboClientOptions {
  readonly apiUrl?: string;
  readonly allowRemote?: boolean;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class KuboClient {
  readonly apiUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KuboClientOptions = {}) {
    this.apiUrl = parseApiUrl(options.apiUrl ?? DEFAULT_API_URL, {
      allowRemote: options.allowRemote ?? false,
    });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async call(command: string, params: Params, options: CallOptions = {}) {
    const url = new URL(
      `api/v0/${command}`,
      this.apiUrl.href.endsWith("/") ? this.apiUrl : `${this.apiUrl.href}/`,
    );
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    }
    const deadline = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        body: options.body ?? null,
        signal:
          options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]),
      });
    } catch (error) {
      throw transportError(command, error, this.apiUrl.host);
    }
    if (!response.ok) {
      const text = await this.read(command, () => response.text());
      let message = text.trim() || response.statusText;
      try {
        const parsed = JSON.parse(text) as { Message?: unknown };
        if (typeof parsed.Message === "string") {
          message = parsed.Message;
        }
      } catch {
        // Not a Kubo JSON error body; keep the raw text.
      }
      throw new KuboError(command, message, { status: response.status });
    }
    return response;
  }

  /** Reads a response body, mapping deadline and transport failures to KuboError. */
  private async read<T>(command: string, reader: () => Promise<T>): Promise<T> {
    try {
      return await reader();
    } catch (error) {
      throw transportError(command, error, this.apiUrl.host);
    }
  }

  private async json(command: string, params: Params, options?: CallOptions): Promise<unknown> {
    const response = await this.call(command, params, options);
    const text = await this.read(command, () => response.text());
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new KuboError(command, "malformed JSON response");
    }
  }

  private async bytes(command: string, params: Params, options?: CallOptions) {
    const response = await this.call(command, params, options);
    return new Uint8Array(await this.read(command, () => response.arrayBuffer()));
  }

  /**
   * Streams a newline-delimited JSON response line by line. Kubo reports some failures as an
   * error line inside a successful response.
   */
  private async *stream(
    command: string,
    params: Params,
    options?: CallOptions,
  ): AsyncGenerator<Record<string, unknown>> {
    const response = await this.call(command, params, options);
    if (response.body === null) {
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await this.read(command, () => reader.read());
        buffered += done ? "\n" : value;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const text of lines) {
          if (text.trim() === "") {
            continue;
          }
          let line: Record<string, unknown>;
          try {
            line = JSON.parse(text) as Record<string, unknown>;
          } catch {
            throw new KuboError(command, "malformed streamed JSON line");
          }
          if (typeof line.Message === "string" && line.Type === "error") {
            throw new KuboError(command, line.Message);
          }
          if (typeof line.Err === "string" && line.Err !== "") {
            throw new KuboError(command, line.Err);
          }
          yield line;
        }
        if (done) {
          return;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async ndjson(command: string, params: Params, options?: CallOptions) {
    const lines: Record<string, unknown>[] = [];
    for await (const line of this.stream(command, params, options)) {
      lines.push(line);
    }
    return lines;
  }

  async version(): Promise<string> {
    const body = (await this.json("version", {})) as { Version?: unknown };
    return requireString(body.Version, "version", "Version");
  }

  async peerId(): Promise<string> {
    const body = (await this.json("id", {})) as { ID?: unknown };
    return requireString(body.ID, "id", "ID");
  }

  async getConfig(key: string): Promise<unknown> {
    const body = (await this.json("config", { arg: key })) as { Value?: unknown };
    return body.Value;
  }

  /**
   * Imports a directory without pinning and returns its root CID. Import parameters come from
   * the node's `Import` config, which callers must verify first.
   */
  async addDirectory(rootName: string, entries: readonly UploadEntry[]): Promise<string> {
    const form = new FormData();
    for (const entry of entries) {
      const path = encodeURIComponent(entry.path === "" ? rootName : `${rootName}/${entry.path}`);
      form.append("file", entry.kind === "directory" ? DIRECTORY_PART : entry.content, path);
    }
    const lines = await this.ndjson(
      "add",
      { pin: false, quieter: true, "wrap-with-directory": false, progress: false },
      { body: form, timeoutMs: 10 * 60_000 },
    );
    const root = lines.find((line) => line.Name === rootName);
    return requireString(root?.Hash, "add", "root Hash");
  }

  /**
   * Fetches and recursively pins a DAG. `onProgress` sees running totals while Kubo fetches; if
   * it throws, the request is aborted (which cancels the fetch) and its error is rethrown.
   * Blocks fetched before an abort stay in the blockstore unpinned. `signal` cancels it too.
   */
  async pinRecursive(
    cid: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onProgress?: (progress: PinProgress) => void;
    } = {},
  ): Promise<void> {
    const abort = new AbortController();
    const signal =
      options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]);
    let pinned = false;
    try {
      for await (const line of this.stream(
        "pin/add",
        { arg: cid, recursive: true, progress: true },
        {
          signal,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      )) {
        if (typeof line.Progress === "number") {
          options.onProgress?.({
            blocks: line.Progress,
            bytes: typeof line.Bytes === "number" ? line.Bytes : 0,
          });
        }
        if (Array.isArray(line.Pins) && line.Pins.includes(cid)) {
          pinned = true;
        }
      }
    } catch (error) {
      abort.abort();
      throw error;
    }
    if (!pinned) {
      throw new KuboError("pin/add", `response ended without confirming the pin of ${cid}`);
    }
  }

  /** Removes a recursive pin. Returns false when the CID was not (or not directly) pinned. */
  async unpin(cid: string): Promise<boolean> {
    try {
      await this.json("pin/rm", { arg: cid, recursive: true });
      return true;
    } catch (error) {
      if (error instanceof KuboError && /not pinned/.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Returns the cumulative size the root block declares for its DAG. Only the root is fetched,
   * and the value is the publisher's claim, so treat it as an early filter, never as proof.
   */
  async declaredSize(
    cid: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<number> {
    const body = (await this.json("files/stat", { arg: `/ipfs/${cid}` }, options)) as {
      CumulativeSize?: unknown;
    };
    return requireNumber(body.CumulativeSize, "files/stat", "CumulativeSize");
  }

  async isPinnedRecursively(cid: string): Promise<boolean> {
    try {
      const body = (await this.json("pin/ls", { arg: cid, type: "recursive" })) as {
        Keys?: Record<string, unknown>;
      };
      return body.Keys !== undefined && Object.keys(body.Keys).length > 0;
    } catch (error) {
      if (error instanceof KuboError && /not pinned/.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Walks the whole DAG using only local blocks. Succeeds only when every reachable block is
   * stored locally, which is Meshkeep's definition of a complete replica.
   */
  async localDagStat(cid: string): Promise<{ blocks: number; bytes: number }> {
    const lines = await this.ndjson("dag/stat", { arg: cid, offline: true, progress: false });
    const summary = lines.at(-1) as { UniqueBlocks?: unknown; TotalSize?: unknown } | undefined;
    const blocks = summary?.UniqueBlocks;
    const bytes = summary?.TotalSize;
    if (typeof blocks !== "number" || typeof bytes !== "number") {
      throw new KuboError("dag/stat", "missing UniqueBlocks or TotalSize");
    }
    return { blocks, bytes };
  }

  async publishName(cid: string, options: PublishOptions): Promise<string> {
    const body = (await this.json("name/publish", {
      arg: `/ipfs/${cid}`,
      key: options.key,
      lifetime: options.lifetime,
      ttl: options.ttl,
      sequence: options.sequence,
      "allow-offline": options.allowOffline,
      "ipns-base": "base36",
      resolve: true,
    })) as { Name?: unknown };
    return requireString(body.Name, "name/publish", "Name");
  }

  /** Resolves a name to its `/ipfs/<cid>` path, bypassing Kubo's resolution cache. */
  async resolveName(name: string, options: { timeoutMs?: number } = {}): Promise<string> {
    const body = (await this.json(
      "name/resolve",
      { arg: name, nocache: true, recursive: false },
      options,
    )) as { Path?: unknown };
    return requireString(body.Path, "name/resolve", "Path");
  }

  /** Fetches the best signed IPNS record Kubo can find for a name. */
  async getRecord(
    name: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    return this.bytes("name/get", { arg: name }, options);
  }

  /** Validates and stores a signed record, then puts it to the routing system. */
  async putRecord(name: string, record: Uint8Array): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([record]), "record");
    await this.json("name/put", { arg: name }, { body: form });
  }

  async inspectRecord(record: Uint8Array, verifyName?: string): Promise<IpnsRecordEntry> {
    const form = new FormData();
    form.append("file", new Blob([record]), "record");
    const body = (await this.json("name/inspect", { verify: verifyName }, { body: form })) as {
      Entry?: Record<string, unknown>;
      Validation?: { Valid?: unknown; Reason?: unknown };
    };
    if (verifyName !== undefined && body.Validation?.Valid !== true) {
      const reason = typeof body.Validation?.Reason === "string" ? body.Validation.Reason : "";
      throw new KuboError("name/inspect", `record is not valid for ${verifyName}: ${reason}`);
    }
    const entry = body.Entry ?? {};
    return {
      value: requireString(entry.Value, "name/inspect", "Entry.Value"),
      sequence: requireNumber(entry.Sequence, "name/inspect", "Entry.Sequence"),
      validity: requireString(entry.Validity, "name/inspect", "Entry.Validity"),
      ttlNanoseconds: requireNumber(entry.TTL, "name/inspect", "Entry.TTL"),
    };
  }

  async listKeys(): Promise<{ name: string; id: string }[]> {
    const body = (await this.json("key/list", { l: true, "ipns-base": "base36" })) as {
      Keys?: { Name?: unknown; Id?: unknown }[];
    };
    return (body.Keys ?? []).map((key) => ({
      name: requireString(key.Name, "key/list", "Name"),
      id: requireString(key.Id, "key/list", "Id"),
    }));
  }

  async importKey(name: string, privateKey: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([privateKey]), "key");
    const body = (await this.json(
      "key/import",
      { arg: name, format: "libp2p-protobuf-cleartext", "ipns-base": "base36" },
      { body: form },
    )) as { Id?: unknown };
    return requireString(body.Id, "key/import", "Id");
  }

  async connect(multiaddr: string): Promise<void> {
    await this.json("swarm/connect", { arg: multiaddr });
  }

  async cat(path: string, options: { offline?: boolean } = {}): Promise<Uint8Array> {
    return this.bytes("cat", { arg: path, offline: options.offline });
  }
}

function requireString(value: unknown, command: string, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new KuboError(command, `response is missing ${field}`);
  }
  return value;
}

function requireNumber(value: unknown, command: string, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new KuboError(command, `response has invalid ${field}`);
  }
  return value;
}
