import { parseGatewayPort } from "./target.js";

/**
 * The identity CID of zero bytes. Every gateway can answer it without touching the network, so a
 * request for it shows only whether a subdomain gateway is listening on the port.
 */
const PROBE_CID = "bafkqaaa";
const PROBE_TIMEOUT_MS = 3000;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Whether a local subdomain gateway (Kubo) answers on `port`. */
export async function probeGateway(
  port: number,
  fetchFn: Fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const url = `http://${PROBE_CID}.ipfs.localhost:${parseGatewayPort(port)}/`;
  try {
    const response = await fetchFn(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok && (await response.arrayBuffer()).byteLength === 0;
  } catch {
    return false;
  }
}
