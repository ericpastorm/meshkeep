// Helpers shared by the extension's pages. Pages never build HTML from strings: every value is
// set as text, so nothing from an address book can inject markup.
import type { Replies, Reply, Request } from "./messages.js";

export class ReplyError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly petname?: string,
  ) {
    super(message);
    this.name = "ReplyError";
  }
}

/** Sends a request to the background service worker and unwraps its reply. */
export async function send<T extends Request>(request: T): Promise<Replies[T["type"]]> {
  const reply = (await chrome.runtime.sendMessage(request)) as
    | Reply<Replies[T["type"]]>
    | undefined;
  if (reply === undefined) {
    throw new ReplyError("the extension did not answer; reload it and try again");
  }
  if (!reply.ok) {
    throw new ReplyError(reply.error, reply.code, reply.petname);
  }
  return reply.value;
}

type Child = Node | string;

/** Creates an element with attributes and children; strings become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element as T;
}

/** Shows a status line; `kind` sets its style. An empty text hides it. */
export function showStatus(
  element: HTMLElement,
  text: string,
  kind: "info" | "ok" | "error" = "info",
): void {
  element.textContent = text;
  element.dataset.kind = kind;
  element.hidden = text === "";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A shortened address for display; the full one goes in the title attribute. */
export function shortName(name: string): string {
  return `${name.slice(0, 12)}…${name.slice(-6)}`;
}
