import type { AddressBookEntry } from "@meshkeep/protocol";

import { byId, h, messageOf, send, shortName, showStatus } from "./ui.js";

const notice = byId<HTMLParagraphElement>("notice");
const addForm = byId<HTMLFormElement>("add-form");
const table = byId<HTMLTableElement>("entries");
const empty = byId<HTMLParagraphElement>("empty");
const importForm = byId<HTMLFormElement>("import-form");
const exportButton = byId<HTMLButtonElement>("export");
const gatewayForm = byId<HTMLFormElement>("gateway-form");
const gatewayStatus = byId<HTMLParagraphElement>("gateway-status");

function control<T extends HTMLInputElement>(form: HTMLFormElement, name: string): T {
  return form.elements.namedItem(name) as T;
}

/** Runs a change and reports its outcome; the list is reloaded either way. */
async function attempt(task: () => Promise<string>): Promise<boolean> {
  try {
    showStatus(notice, await task(), "ok");
    return true;
  } catch (error) {
    showStatus(notice, messageOf(error), "error");
    return false;
  } finally {
    await load();
  }
}

function row(entry: AddressBookEntry): HTMLTableRowElement {
  const petname = h("td", { class: "petname" }, entry.petname);
  const open = h("button", { type: "button" }, "Open");
  const rename = h("button", { type: "button" }, "Rename");
  const remove = h("button", { type: "button", class: "danger" }, "Remove");

  open.addEventListener("click", () =>
    attempt(async () => {
      await send({ type: "open", input: entry.petname, newTab: true });
      return "";
    }),
  );

  rename.addEventListener("click", () => {
    const field = h("input", {
      value: entry.petname,
      spellcheck: "false",
      "aria-label": `New petname for ${entry.petname}`,
    });
    const save = h("button", { type: "submit" }, "Save");
    const cancel = h("button", { type: "button" }, "Cancel");
    const editor = h("form", { class: "inline-edit" }, field, save, cancel);
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      void attempt(async () => {
        const result = await send({ type: "rename", from: entry.petname, to: field.value.trim() });
        return `Renamed ${result.from} to ${result.to}`;
      });
    });
    cancel.addEventListener("click", () => void load());
    petname.replaceChildren(editor);
    field.focus();
    field.select();
  });

  // Removing takes a second click, instead of a blocking confirm() dialog.
  remove.addEventListener("click", () => {
    if (remove.dataset.armed !== "true") {
      remove.dataset.armed = "true";
      remove.textContent = "Confirm removal";
      return;
    }
    void attempt(async () => {
      await send({ type: "remove", petname: entry.petname });
      return `Removed ${entry.petname}`;
    });
  });
  remove.addEventListener("blur", () => {
    remove.dataset.armed = "false";
    remove.textContent = "Remove";
  });

  return h(
    "tr",
    { "data-petname": entry.petname },
    petname,
    h("td", {}, h("code", { title: entry.name }, shortName(entry.name))),
    h("td", {}, entry.note ?? ""),
    h("td", { class: "actions" }, open, rename, remove),
  );
}

async function load(): Promise<void> {
  try {
    const { entries } = await send({ type: "book" });
    const body = table.tBodies[0];
    body?.replaceChildren(...entries.map(row));
    table.hidden = entries.length === 0;
    empty.hidden = entries.length > 0;
  } catch (error) {
    showStatus(notice, messageOf(error), "error");
  }
}

async function probe(): Promise<void> {
  try {
    const result = await send({ type: "probe" });
    showStatus(
      gatewayStatus,
      result.reachable
        ? `A gateway answers on port ${result.port}.`
        : `No gateway answers on port ${result.port}. Start Kubo, or change the port.`,
      result.reachable ? "ok" : "error",
    );
  } catch (error) {
    showStatus(gatewayStatus, messageOf(error), "error");
  }
}

addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const note = control(addForm, "note").value.trim();
  void attempt(async () => {
    const entry = await send({
      type: "add",
      petname: control(addForm, "petname").value.trim(),
      name: control(addForm, "name").value.trim(),
      ...(note === "" ? {} : { note }),
    });
    return `Added ${entry.petname}`;
  }).then((added) => {
    if (added) {
      addForm.reset();
    }
  });
});

importForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const file = control(importForm, "file").files?.[0];
  if (file === undefined) {
    return;
  }
  void attempt(async () => {
    const result = await send({
      type: "import",
      text: await file.text(),
      replace: control(importForm, "replace").checked,
    });
    return `Imported: ${result.added.length} added, ${result.replaced.length} replaced, ${result.unchanged.length} already present`;
  }).then((imported) => {
    if (imported) {
      importForm.reset();
    }
  });
});

exportButton.addEventListener("click", () =>
  attempt(async () => {
    const { text } = await send({ type: "export" });
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = h("a", { href: url, download: "meshkeep-address-book.json" });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return "Exported the address book";
  }),
);

gatewayForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const port = control(gatewayForm, "port").valueAsNumber;
  void attempt(async () => {
    const settings = await send({ type: "set-gateway-port", port });
    return `Saved: sites open on port ${settings.gatewayPort}`;
  }).then(probe);
});

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const add = params.get("add");
  const error = params.get("error");
  if (add !== null) {
    control(addForm, "petname").value = add;
    control(addForm, "name").focus();
    showStatus(notice, `${add} is not in your address book yet. Add its address below.`);
  } else if (error !== null) {
    showStatus(notice, error, "error");
  }
  try {
    const settings = await send({ type: "settings" });
    control(gatewayForm, "port").value = String(settings.gatewayPort);
  } catch (failure) {
    showStatus(gatewayStatus, messageOf(failure), "error");
  }
  await Promise.all([load(), probe()]);
}

void start();
