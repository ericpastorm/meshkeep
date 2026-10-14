import {
  type AddressBook,
  findEntry,
  isIpnsName,
  parseIpnsName,
  parsePetname,
} from "@meshkeep/protocol";

export const DEFAULT_GATEWAY_PORT = 8080;

/** A subdomain gateway puts the address in one DNS label, and a label holds 63 characters. */
const MAX_LABEL_LENGTH = 63;

export type TargetErrorCode = "empty" | "invalid" | "unknown-petname";

export class TargetError extends Error {
  constructor(
    readonly code: TargetErrorCode,
    message: string,
    /** The petname the user typed, when it is valid but not in the address book. */
    readonly petname?: string,
  ) {
    super(message);
    this.name = "TargetError";
  }
}

/** Where to go: a site address and the path, query, and fragment to open on it. */
export interface Target {
  readonly name: string;
  readonly petname?: string;
  /** Empty, or starting with `/`, `?`, or `#`. */
  readonly suffix: string;
}

/** Splits `<petname or address>[/path][?query][#fragment]`, accepting `ipns://` and `/ipns/`. */
export function splitInput(input: string): { readonly head: string; readonly suffix: string } {
  let text = input.trim();
  for (const prefix of ["ipns://", "/ipns/"]) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  const cut = text.search(/[/?#]/);
  return cut === -1
    ? { head: text, suffix: "" }
    : { head: text.slice(0, cut), suffix: text.slice(cut) };
}

/** Resolves what the user typed against their address book. */
export function resolveTarget(book: AddressBook, input: string): Target {
  const { head, suffix } = splitInput(input);
  if (head === "") {
    throw new TargetError("empty", "type a petname or a k51… address");
  }
  if (isIpnsName(head)) {
    const name = parseIpnsName(head);
    if (name.length > MAX_LABEL_LENGTH) {
      throw new TargetError("invalid", "this address is too long for a subdomain gateway");
    }
    return { name, suffix };
  }
  let petname: string;
  try {
    petname = parsePetname(head.toLowerCase());
  } catch {
    throw new TargetError("invalid", `not a petname or an address: ${head}`);
  }
  const entry = findEntry(book, petname);
  if (entry === undefined) {
    throw new TargetError("unknown-petname", `${petname} is not in your address book`, petname);
  }
  return { name: entry.name, petname, suffix };
}

export function parseGatewayPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TargetError("invalid", "the gateway port must be a whole number from 1 to 65535");
  }
  return value;
}

/** The origin a site gets on the local subdomain gateway. */
export function siteOrigin(name: string, port: number): string {
  return new URL(`http://${name}.ipns.localhost:${parseGatewayPort(port)}/`).origin;
}

/** The URL to open. The suffix can never move the request off the site's own origin. */
export function siteUrl(target: Target, port: number): string {
  const origin = siteOrigin(target.name, port);
  const url = new URL(`${origin}${target.suffix.startsWith("/") ? "" : "/"}${target.suffix}`);
  if (url.origin !== origin) {
    throw new TargetError("invalid", "the path must stay on the site");
  }
  return url.href;
}
