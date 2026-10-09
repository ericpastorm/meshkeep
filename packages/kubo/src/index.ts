import { isIP } from "node:net";

export const DEFAULT_API_URL = "http://127.0.0.1:5001";
const DEFAULT_TIMEOUT_MS = 60_000;

export class KuboError extends Error {
  readonly command: string;
  readonly status: number | undefined;

  constructor(command: string, message: string, status?: number) {
    super(`kubo ${command}: ${message}`);
    this.name = "KuboError";
    this.command = command;
    this.status = status;
  }
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
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        body: options.body ?? null,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "timed out"
          : `unreachable at ${this.apiUrl.host}`;
      throw new KuboError(command, reason);
    }
    if (!response.ok) {
      const text = await response.text();
      let message = text.trim() || response.statusText;
      try {
        const parsed = JSON.parse(text) as { Message?: unknown };
        if (typeof parsed.Message === "string") {
          message = parsed.Message;
        }
      } catch {
        // Not a Kubo JSON error body; keep the raw text.
      }
      throw new KuboError(command, message, response.status);
    }
    return response;
  }

  private async json(command: string, params: Params, options?: CallOptions): Promise<unknown> {
    const response = await this.call(command, params, options);
    return response.json() as Promise<unknown>;
  }

  /** Kubo streams some commands as newline-delimited JSON; a line may carry an error. */
  private async ndjson(command: string, params: Params, options?: CallOptions) {
    const text = await (await this.call(command, params, options)).text();
    const lines = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) {
      if (typeof line.Message === "string" && line.Type === "error") {
        throw new KuboError(command, line.Message);
      }
      if (typeof line.Err === "string" && line.Err !== "") {
        throw new KuboError(command, line.Err);
      }
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

  async pinRecursive(cid: string, options: { timeoutMs?: number } = {}): Promise<void> {
    await this.json("pin/add", { arg: cid, recursive: true, progress: false }, options);
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
  async getRecord(name: string, options: { timeoutMs?: number } = {}): Promise<Uint8Array> {
    const response = await this.call("name/get", { arg: name }, options);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Validates and stores a signed record, then puts it to the routing system. */
  async putRecord(name: string, record: Uint8Array): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([record]), "record");
    await this.call("name/put", { arg: name }, { body: form });
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
    const response = await this.call("cat", { arg: path, offline: options.offline });
    return new Uint8Array(await response.arrayBuffer());
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
