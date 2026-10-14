import { type AddressBook, createAddressBook } from "@meshkeep/protocol";

import { matchEntries } from "./suggest.js";
import { byId, h, messageOf, ReplyError, send, shortName, showStatus } from "./ui.js";

const form = byId<HTMLFormElement>("open-form");
const input = byId<HTMLInputElement>("target");
const message = byId<HTMLParagraphElement>("message");
const matches = byId<HTMLUListElement>("matches");
const gateway = byId<HTMLSpanElement>("gateway");

let book: AddressBook = createAddressBook();

async function open(target: string): Promise<void> {
  try {
    await send({ type: "open", input: target, newTab: false });
    // Opened as the toolbar popup, close it; opened in a tab, the tab is already navigating.
    if ((await chrome.tabs.getCurrent()) === undefined) {
      window.close();
    }
  } catch (error) {
    showStatus(message, messageOf(error), "error");
    if (error instanceof ReplyError && error.code === "unknown-petname" && error.petname) {
      message.append(
        " ",
        h(
          "a",
          { href: `book.html?add=${encodeURIComponent(error.petname)}`, target: "_blank" },
          "Add it",
        ),
      );
    }
  }
}

function render(): void {
  matches.replaceChildren(
    ...matchEntries(book, input.value).map((entry) => {
      const button = h(
        "button",
        { type: "button", title: entry.name },
        h("span", { class: "petname" }, entry.petname),
        h("span", { class: "detail" }, entry.note ?? shortName(entry.name)),
      );
      button.addEventListener("click", () => open(entry.petname));
      return h("li", {}, button);
    }),
  );
  if (book.entries.length === 0) {
    matches.append(h("li", { class: "empty" }, "Your address book is empty."));
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void open(input.value);
});
input.addEventListener("input", () => {
  showStatus(message, "");
  render();
});

async function start(): Promise<void> {
  try {
    book = createAddressBook((await send({ type: "book" })).entries);
    render();
  } catch (error) {
    showStatus(message, messageOf(error), "error");
  }
  try {
    const probe = await send({ type: "probe" });
    gateway.textContent = probe.reachable
      ? `Local gateway on port ${probe.port}`
      : `No local gateway on port ${probe.port}`;
    gateway.dataset.kind = probe.reachable ? "ok" : "error";
  } catch (error) {
    gateway.textContent = messageOf(error);
    gateway.dataset.kind = "error";
  }
}

void start();
