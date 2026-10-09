import { ProtocolError } from "./errors.js";
import { parseIpnsName } from "./identifiers.js";
import { parsePetname } from "./petname.js";

export const ADDRESS_BOOK_FORMAT = "meshkeep-address-book-v1";
export const MAX_ADDRESS_BOOK_ENTRIES = 10_000;
export const MAX_ADDRESS_BOOK_BYTES = 4 * 1024 * 1024;
export const MAX_NOTE_LENGTH = 280;

export interface AddressBookEntry {
  readonly petname: string;
  /** Canonical base36 IPNS name. */
  readonly name: string;
  readonly note?: string;
}

/** Entries are always sorted by petname, and petnames are unique. */
export interface AddressBook {
  readonly format: typeof ADDRESS_BOOK_FORMAT;
  readonly entries: readonly AddressBookEntry[];
}

function invalid(message: string): ProtocolError {
  return new ProtocolError("invalid-address-book", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], at: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalid(`${at} has unknown field ${JSON.stringify(key)}`);
    }
  }
}

function parseNote(value: unknown, at: string): string {
  // Empty notes are rejected rather than normalized so each book has one canonical encoding.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters.
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${at}.note must be a non-empty string without control characters`);
  }
  if ([...value].length > MAX_NOTE_LENGTH) {
    throw invalid(`${at}.note exceeds ${MAX_NOTE_LENGTH} characters`);
  }
  return value;
}

function comparePetnames(left: AddressBookEntry, right: AddressBookEntry): number {
  return left.petname < right.petname ? -1 : left.petname > right.petname ? 1 : 0;
}

export function createAddressBook(entries: readonly AddressBookEntry[] = []): AddressBook {
  if (entries.length > MAX_ADDRESS_BOOK_ENTRIES) {
    throw invalid(`address book exceeds ${MAX_ADDRESS_BOOK_ENTRIES} entries`);
  }
  const seen = new Set<string>();
  const normalized = entries.map((entry, index) => {
    const at = `entries[${index}]`;
    const petname = parsePetname(entry.petname);
    if (seen.has(petname)) {
      throw new ProtocolError("duplicate-petname", `duplicate petname: ${petname}`);
    }
    seen.add(petname);
    const name = parseIpnsName(entry.name);
    return entry.note === undefined
      ? { petname, name }
      : { petname, name, note: parseNote(entry.note, at) };
  });
  return { format: ADDRESS_BOOK_FORMAT, entries: normalized.sort(comparePetnames) };
}

/** Validates an untrusted, already-decoded address book value. */
export function parseAddressBook(value: unknown): AddressBook {
  if (!isRecord(value)) {
    throw invalid("address book must be a JSON object");
  }
  if (value.format !== ADDRESS_BOOK_FORMAT) {
    throw new ProtocolError(
      "unsupported-format",
      `unsupported address book format: ${JSON.stringify(value.format)}`,
    );
  }
  requireOnlyKeys(value, ["format", "entries"], "address book");
  if (!Array.isArray(value.entries)) {
    throw invalid("entries must be an array");
  }
  if (value.entries.length > MAX_ADDRESS_BOOK_ENTRIES) {
    throw invalid(`address book exceeds ${MAX_ADDRESS_BOOK_ENTRIES} entries`);
  }
  const entries = value.entries.map((entry: unknown, index): AddressBookEntry => {
    const at = `entries[${index}]`;
    if (!isRecord(entry)) {
      throw invalid(`${at} must be an object`);
    }
    requireOnlyKeys(entry, ["petname", "name", "note"], at);
    if (typeof entry.petname !== "string" || typeof entry.name !== "string") {
      throw invalid(`${at} requires string petname and name`);
    }
    return entry.note === undefined
      ? { petname: entry.petname, name: entry.name }
      : { petname: entry.petname, name: entry.name, note: parseNote(entry.note, at) };
  });
  return createAddressBook(entries);
}

/** Decodes and validates address book JSON text with a size limit. */
export function decodeAddressBook(text: string): AddressBook {
  if (new TextEncoder().encode(text).length > MAX_ADDRESS_BOOK_BYTES) {
    throw invalid(`address book exceeds ${MAX_ADDRESS_BOOK_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("address book is not valid JSON");
  }
  return parseAddressBook(value);
}

/**
 * Canonical encoding: fixed key order, entries sorted by petname, absent notes omitted,
 * two-space indentation, and a trailing newline. Equal books always encode to equal bytes.
 */
export function encodeAddressBook(book: AddressBook): string {
  const canonical = createAddressBook(book.entries);
  const entries = canonical.entries.map((entry) =>
    entry.note === undefined
      ? { petname: entry.petname, name: entry.name }
      : { petname: entry.petname, name: entry.name, note: entry.note },
  );
  return `${JSON.stringify({ format: ADDRESS_BOOK_FORMAT, entries }, null, 2)}\n`;
}

export function findEntry(book: AddressBook, petname: string): AddressBookEntry | undefined {
  return book.entries.find((entry) => entry.petname === petname);
}

export function setEntry(
  book: AddressBook,
  entry: AddressBookEntry,
  options: { replace?: boolean } = {},
): AddressBook {
  const existing = findEntry(book, entry.petname);
  if (existing !== undefined && options.replace !== true) {
    throw new ProtocolError("duplicate-petname", `petname already exists: ${entry.petname}`);
  }
  return createAddressBook([
    ...book.entries.filter((candidate) => candidate.petname !== entry.petname),
    entry,
  ]);
}

export function removeEntry(book: AddressBook, petname: string): AddressBook {
  if (findEntry(book, petname) === undefined) {
    throw new ProtocolError("unknown-petname", `unknown petname: ${petname}`);
  }
  return createAddressBook(book.entries.filter((entry) => entry.petname !== petname));
}
