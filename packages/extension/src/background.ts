// The background service worker: owns the extension's state and opens sites. It answers only the
// extension's own pages; the manifest declares no content scripts, no web-accessible resources,
// and no externally_connectable, so no website can send it anything.
import { parseRequest } from "./messages.js";
import { type Disposition, ExtensionService, errorReply, isExpectedError } from "./service.js";
import { ExtensionState, type KeyValueStorage } from "./state.js";

const storage: KeyValueStorage = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
};

const service = new ExtensionService({
  state: new ExtensionState(storage),
  fetch: (input, init) => fetch(input, init),
  pageUrl: (path) => chrome.runtime.getURL(path),
  tabs: {
    async open(url: string, disposition: Disposition, tabId?: number) {
      if (disposition === "currentTab") {
        await (tabId === undefined
          ? chrome.tabs.update({ url })
          : chrome.tabs.update(tabId, { url }));
      } else {
        await chrome.tabs.create({ url, active: disposition === "newForegroundTab" });
      }
    },
  },
});

const ownPages = chrome.runtime.getURL("");

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url?.startsWith(ownPages) !== true) {
    return false;
  }
  let request: ReturnType<typeof parseRequest>;
  try {
    request = parseRequest(message);
  } catch (error) {
    sendResponse(errorReply(error));
    return false;
  }
  const tabId = sender.tab?.id;
  service.handle(request, tabId === undefined ? {} : { tabId }).then(
    (value) => sendResponse({ ok: true, value }),
    (error: unknown) => {
      if (!isExpectedError(error)) {
        console.error(error);
      }
      sendResponse(errorReply(error));
    },
  );
  return true;
});

chrome.omnibox.setDefaultSuggestion({
  description: "Open a Meshkeep site: type a petname or a k51… address",
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  service.suggest(text).then(
    (suggestions) => suggest([...suggestions]),
    (error: unknown) => console.error(error),
  );
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  service.openFromOmnibox(text, disposition).catch((error: unknown) => console.error(error));
});
