import {
  type AddressBook,
  createAddressBook,
  decodeAddressBook,
  encodeAddressBook,
} from "@meshkeep/protocol";

import { DEFAULT_GATEWAY_PORT, parseGatewayPort } from "./target.js";

/** The part of `chrome.storage.local` the extension uses, so tests can supply a fake. */
export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Settings {
  readonly gatewayPort: number;
}

const BOOK_KEY = "addressBook";
const SETTINGS_KEY = "settings";

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

/**
 * The extension's state. The address book is stored as canonical `meshkeep-address-book-v1`
 * text, so an export is byte-for-byte what `meshkeep book export` would print. Changes run one at
 * a time, so two pages editing at once never lose an update.
 */
export class ExtensionState {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: KeyValueStorage) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async book(): Promise<AddressBook> {
    const stored = await this.storage.get(BOOK_KEY);
    if (stored === undefined) {
      return createAddressBook();
    }
    try {
      if (typeof stored !== "string") {
        throw new Error("it is not text");
      }
      return decodeAddressBook(stored);
    } catch (error) {
      throw new StateError(`the stored address book cannot be read: ${(error as Error).message}`);
    }
  }

  /** Applies `change` to the current book and stores the result; a failed change stores nothing. */
  updateBook<T>(change: (book: AddressBook) => { book: AddressBook; result: T }): Promise<T> {
    return this.serial(async () => {
      const { book, result } = change(await this.book());
      await this.storage.set(BOOK_KEY, encodeAddressBook(book));
      return result;
    });
  }

  async settings(): Promise<Settings> {
    const stored = await this.storage.get(SETTINGS_KEY);
    if (typeof stored !== "object" || stored === null) {
      return { gatewayPort: DEFAULT_GATEWAY_PORT };
    }
    try {
      return { gatewayPort: parseGatewayPort((stored as { gatewayPort?: unknown }).gatewayPort) };
    } catch {
      return { gatewayPort: DEFAULT_GATEWAY_PORT };
    }
  }

  setSettings(settings: Settings): Promise<Settings> {
    const next = { gatewayPort: parseGatewayPort(settings.gatewayPort) };
    return this.serial(async () => {
      await this.storage.set(SETTINGS_KEY, next);
      return next;
    });
  }
}
