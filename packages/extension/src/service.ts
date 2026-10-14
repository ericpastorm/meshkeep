import {
  type AddressBookEntry,
  decodeAddressBook,
  encodeAddressBook,
  mergeAddressBook,
  ProtocolError,
  parseIpnsName,
  parsePetname,
  removeEntry,
  renameEntry,
  setEntry,
} from "@meshkeep/protocol";

import { type Fetch, probeGateway } from "./gateway.js";
import type { Replies, Reply, Request } from "./messages.js";
import type { ExtensionState } from "./state.js";
import { escapeXml, matchEntries } from "./suggest.js";
import { resolveTarget, siteUrl, splitInput, TargetError } from "./target.js";

/** How the omnibox asks for a result to be opened. */
export type Disposition = "currentTab" | "newForegroundTab" | "newBackgroundTab";

export interface Tabs {
  /** Opens `url`; `tabId` is the tab to navigate when the request came from a page in a tab. */
  open(url: string, disposition: Disposition, tabId?: number): Promise<void>;
}

export interface ServiceOptions {
  readonly state: ExtensionState;
  readonly tabs: Tabs;
  readonly fetch: Fetch;
  /** The URL of one of the extension's own pages. */
  readonly pageUrl: (path: string) => string;
}

export interface OmniboxSuggestion {
  readonly content: string;
  readonly description: string;
}

/** The background service worker's logic, kept free of `chrome.*` so that it can be unit-tested. */
export class ExtensionService {
  constructor(private readonly options: ServiceOptions) {}

  async handle<T extends Request>(
    request: T,
    sender: { tabId?: number } = {},
  ): Promise<Replies[T["type"]]> {
    return (await this.dispatch(request, sender)) as Replies[T["type"]];
  }

  private async dispatch(request: Request, sender: { tabId?: number }): Promise<unknown> {
    const { state } = this.options;
    switch (request.type) {
      case "book":
        return { entries: (await state.book()).entries };
      case "add": {
        const entry: AddressBookEntry = {
          petname: parsePetname(request.petname),
          name: parseIpnsName(request.name),
          ...(request.note === undefined ? {} : { note: request.note }),
        };
        return state.updateBook((book) => ({ book: setEntry(book, entry), result: entry }));
      }
      case "rename":
        return state.updateBook((book) => ({
          book: renameEntry(book, request.from, request.to),
          result: { from: request.from, to: request.to },
        }));
      case "remove":
        return state.updateBook((book) => ({
          book: removeEntry(book, request.petname),
          result: { petname: request.petname },
        }));
      case "import": {
        const incoming = decodeAddressBook(request.text);
        return state.updateBook((book) => {
          const merge = mergeAddressBook(book, incoming, { replace: request.replace });
          const { added, replaced, unchanged } = merge;
          return { book: merge.book, result: { added, replaced, unchanged } };
        });
      }
      case "export":
        return { text: encodeAddressBook(await state.book()) };
      case "settings":
        return state.settings();
      case "set-gateway-port":
        return state.setSettings({ gatewayPort: request.port });
      case "probe": {
        const { gatewayPort } = await state.settings();
        return {
          port: gatewayPort,
          reachable: await probeGateway(gatewayPort, this.options.fetch),
        };
      }
      case "open": {
        const url = await this.urlFor(request.input);
        await this.options.tabs.open(
          url,
          request.newTab ? "newForegroundTab" : "currentTab",
          sender.tabId,
        );
        return { url };
      }
    }
  }

  /** The gateway URL for what the user typed. */
  async urlFor(input: string): Promise<string> {
    const { state } = this.options;
    const [book, settings] = await Promise.all([state.book(), state.settings()]);
    return siteUrl(resolveTarget(book, input), settings.gatewayPort);
  }

  async suggest(input: string): Promise<readonly OmniboxSuggestion[]> {
    const { suffix } = splitInput(input);
    return matchEntries(await this.options.state.book(), input).map((entry) => ({
      content: `${entry.petname}${suffix}`,
      description: `<match>${escapeXml(entry.petname)}</match> <dim>${escapeXml(
        [entry.note, `${entry.name.slice(0, 12)}…`]
          .filter((part) => part !== undefined)
          .join(" · "),
      )}</dim>`,
    }));
  }

  /**
   * Opens what was typed after the omnibox keyword. A petname that is not in the book opens the
   * address book page with that petname ready to add; other mistakes open it with the error.
   */
  async openFromOmnibox(input: string, disposition: Disposition): Promise<void> {
    let url: string;
    try {
      url = await this.urlFor(input);
    } catch (error) {
      const query =
        error instanceof TargetError && error.petname !== undefined
          ? `add=${encodeURIComponent(error.petname)}`
          : `error=${encodeURIComponent(errorReply(error).error)}`;
      url = this.options.pageUrl(`book.html?${query}`);
    }
    await this.options.tabs.open(url, disposition);
  }
}

/** Failures caused by the user's input or stored state, whose message is meant for the user. */
export function isExpectedError(error: unknown): boolean {
  return (
    error instanceof TargetError ||
    error instanceof ProtocolError ||
    (error instanceof Error && ["RequestError", "StateError"].includes(error.name))
  );
}

/** Turns any failure into a reply a page can show. Unexpected errors get a generic message. */
export function errorReply(error: unknown): Reply<never> & { ok: false } {
  if (error instanceof TargetError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.petname === undefined ? {} : { petname: error.petname }),
    };
  }
  if (error instanceof ProtocolError) {
    return { ok: false, error: error.message, code: error.code };
  }
  if (error instanceof Error && isExpectedError(error)) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "something went wrong; see the extension's service worker console" };
}
