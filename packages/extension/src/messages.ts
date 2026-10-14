import { type AddressBookEntry, MAX_ADDRESS_BOOK_BYTES } from "@meshkeep/protocol";

import type { Settings } from "./state.js";

/** Requests the extension's pages send to the background service worker. */
export type Request =
  | { readonly type: "book" }
  | {
      readonly type: "add";
      readonly petname: string;
      readonly name: string;
      readonly note?: string;
    }
  | { readonly type: "rename"; readonly from: string; readonly to: string }
  | { readonly type: "remove"; readonly petname: string }
  | { readonly type: "import"; readonly text: string; readonly replace: boolean }
  | { readonly type: "export" }
  | { readonly type: "settings" }
  | { readonly type: "set-gateway-port"; readonly port: number }
  | { readonly type: "probe" }
  | { readonly type: "open"; readonly input: string; readonly newTab: boolean };

export interface Replies {
  book: { readonly entries: readonly AddressBookEntry[] };
  add: AddressBookEntry;
  rename: { readonly from: string; readonly to: string };
  remove: { readonly petname: string };
  import: {
    readonly added: readonly string[];
    readonly replaced: readonly string[];
    readonly unchanged: readonly string[];
  };
  export: { readonly text: string };
  settings: Settings;
  "set-gateway-port": Settings;
  probe: { readonly port: number; readonly reachable: boolean };
  open: { readonly url: string };
}

export type Reply<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code?: string;
      readonly petname?: string;
    };

export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/** Longest text field accepted; notes and petnames are validated again by the protocol. */
const MAX_FIELD_LENGTH = 4096;

function field(value: Record<string, unknown>, key: string, maxLength = MAX_FIELD_LENGTH): string {
  const text = value[key];
  if (typeof text !== "string" || text.length > maxLength) {
    throw new RequestError(`${key} must be text of at most ${maxLength} characters`);
  }
  return text;
}

function flag(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") {
    throw new RequestError(`${key} must be true or false`);
  }
  return value[key] as boolean;
}

/** Validates a message at the boundary; anything unexpected is refused. */
export function parseRequest(value: unknown): Request {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError("a request must be an object");
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "book":
    case "export":
    case "settings":
    case "probe":
      return { type: message.type };
    case "add": {
      const note = message.note === undefined ? undefined : field(message, "note");
      return {
        type: "add",
        petname: field(message, "petname"),
        name: field(message, "name"),
        ...(note === undefined || note === "" ? {} : { note }),
      };
    }
    case "rename":
      return { type: "rename", from: field(message, "from"), to: field(message, "to") };
    case "remove":
      return { type: "remove", petname: field(message, "petname") };
    case "import":
      return {
        type: "import",
        text: field(message, "text", MAX_ADDRESS_BOOK_BYTES),
        replace: flag(message, "replace"),
      };
    case "set-gateway-port":
      if (typeof message.port !== "number") {
        throw new RequestError("port must be a number");
      }
      return { type: "set-gateway-port", port: message.port };
    case "open":
      return { type: "open", input: field(message, "input"), newTab: flag(message, "newTab") };
    default:
      throw new RequestError("unknown request");
  }
}
