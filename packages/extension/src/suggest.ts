import type { AddressBook, AddressBookEntry } from "@meshkeep/protocol";

import { splitInput } from "./target.js";

/**
 * Address book entries matching what the user typed, best first: petnames that start with it,
 * then petnames, notes, and addresses that contain it.
 */
export function matchEntries(
  book: AddressBook,
  input: string,
  limit = 8,
): readonly AddressBookEntry[] {
  const query = splitInput(input).head.toLowerCase();
  if (query === "") {
    return book.entries.slice(0, limit);
  }
  const rank = (entry: AddressBookEntry): number => {
    if (entry.petname.startsWith(query)) {
      return 0;
    }
    if (entry.petname.includes(query)) {
      return 1;
    }
    if (entry.note?.toLowerCase().includes(query) === true) {
      return 2;
    }
    return entry.name.includes(query) ? 3 : -1;
  };
  return book.entries
    .map((entry) => ({ entry, rank: rank(entry) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((left, right) => left.rank - right.rank)
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}

/** Escapes text for an omnibox suggestion description, which Chrome parses as XML. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
