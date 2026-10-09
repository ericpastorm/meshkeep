import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type AddressBook,
  createAddressBook,
  decodeAddressBook,
  decodePrivateKey,
  encodeAddressBook,
  encodePrivateKey,
  findEntry,
  ipnsNameFromPublicKey,
  isIpnsName,
  ProtocolError,
  type ProtocolErrorCode,
  parseContentCid,
  parseIpnsName,
  parsePetname,
  removeEntry,
  setEntry,
} from "./index.js";

const fixtures = new URL("../../../spec/fixtures/", import.meta.url);
const readFixture = (path: string) => readFileSync(new URL(path, fixtures), "utf8");
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

const keyFixture = JSON.parse(readFixture("keys/ed25519-kubo-0.42.json")) as {
  seedHex: string;
  publicKeyHex: string;
  privateKeyHex: string;
  ipnsName: string;
};
const NAME = keyFixture.ipnsName;
const V1_CID = "bafybeih3ovsytsdcmgcqyl6txyquj5nsd3d2svk3ezczlahga7dfql3mki";

function expectProtocolError(action: () => unknown, code: ProtocolErrorCode) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    return;
  }
  expect.fail(`expected ProtocolError ${code}`);
}

describe("keys", () => {
  it("encodes the Kubo-compatible private key and derives Kubo's IPNS name", () => {
    const seed = fromHex(keyFixture.seedHex);
    const publicKey = fromHex(keyFixture.publicKeyHex);

    expect(Buffer.from(encodePrivateKey({ seed, publicKey })).toString("hex")).toBe(
      keyFixture.privateKeyHex,
    );
    expect(ipnsNameFromPublicKey(publicKey)).toBe(NAME);
  });

  it("round-trips the private key encoding", () => {
    const decoded = decodePrivateKey(fromHex(keyFixture.privateKeyHex));

    expect(Buffer.from(decoded.seed).toString("hex")).toBe(keyFixture.seedHex);
    expect(Buffer.from(decoded.publicKey).toString("hex")).toBe(keyFixture.publicKeyHex);
  });

  it("rejects truncated, oversized, and non-Ed25519 keys", () => {
    const valid = fromHex(keyFixture.privateKeyHex);
    const rsaHeader = Uint8Array.from(valid);
    rsaHeader[1] = 0x00;

    expectProtocolError(() => decodePrivateKey(valid.subarray(0, 67)), "invalid-key");
    expectProtocolError(() => decodePrivateKey(Uint8Array.of(...valid, 0)), "invalid-key");
    expectProtocolError(() => decodePrivateKey(rsaHeader), "invalid-key");
    expectProtocolError(() => ipnsNameFromPublicKey(new Uint8Array(31)), "invalid-key");
  });
});

describe("identifiers", () => {
  it("canonicalizes IPNS names to base36", () => {
    const base32Form = "bafzaajaiaejcaa5ba677htqqxyoxbxiy45f4bglh4tldbg5fbvpr3xegmqjfkmny";

    expect(parseIpnsName(NAME)).toBe(NAME);
    expect(parseIpnsName(`/ipns/${NAME}`)).toBe(NAME);
    expect(parseIpnsName(base32Form)).toBe(NAME);
  });

  it.each([
    "",
    "demo",
    V1_CID,
    `/ipfs/${NAME}`,
    "example.com",
    "k51-not-a-name",
  ])("rejects %j as an IPNS name", (input) => {
    expect(isIpnsName(input)).toBe(false);
    expectProtocolError(() => parseIpnsName(input), "invalid-name");
  });

  it("canonicalizes content CIDs to base32 CIDv1", () => {
    expect(parseContentCid(V1_CID)).toBe(V1_CID);
    expect(parseContentCid(`/ipfs/${V1_CID}`)).toBe(V1_CID);
    expect(parseContentCid("QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR")).toBe(
      "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    );
  });

  it.each(["", NAME, "not-a-cid", "x".repeat(300)])("rejects %j as a content CID", (input) => {
    expectProtocolError(() => parseContentCid(input), "invalid-cid");
  });
});

describe("petnames", () => {
  it.each(["a", "demo", "my-site-2", "x".repeat(63)])("accepts %j", (input) => {
    expect(parsePetname(input)).toBe(input);
  });

  it.each([
    "",
    "Demo",
    "-demo",
    "demo-",
    "my_site",
    "x".repeat(64),
    "café",
  ])("rejects %j", (input) => {
    expectProtocolError(() => parsePetname(input), "invalid-petname");
  });

  it("rejects a petname that is also an IPNS name", () => {
    expectProtocolError(() => parsePetname(NAME), "invalid-petname");
  });
});

describe("address book", () => {
  const canonical = readFixture("address-book/valid/canonical.json");

  it("decodes and re-encodes the canonical fixture byte-for-byte", () => {
    expect(encodeAddressBook(decodeAddressBook(canonical))).toBe(canonical);
  });

  it("encodes every valid fixture canonically", () => {
    expect(
      encodeAddressBook(decodeAddressBook(readFixture("address-book/valid/unsorted.json"))),
    ).toBe(canonical);
    const empty = readFixture("address-book/valid/empty.json");
    expect(encodeAddressBook(decodeAddressBook(empty))).toBe(empty);
  });

  const invalidCases: Record<string, ProtocolErrorCode> = {
    "content-cid-as-name.json": "invalid-name",
    "duplicate-petname.json": "duplicate-petname",
    "empty-note.json": "invalid-address-book",
    "petname-is-name.json": "invalid-petname",
    "unknown-field.json": "invalid-address-book",
    "unknown-top-level-field.json": "invalid-address-book",
    "unsupported-format.json": "unsupported-format",
    "uppercase-petname.json": "invalid-petname",
  };

  it("has an expectation for every invalid fixture", () => {
    const files = readdirSync(new URL("address-book/invalid/", fixtures)).sort();
    expect(files).toEqual(Object.keys(invalidCases).sort());
  });

  it.each(Object.entries(invalidCases))("rejects invalid fixture %s", (file, code) => {
    expectProtocolError(() => decodeAddressBook(readFixture(`address-book/invalid/${file}`)), code);
  });

  it("rejects malformed JSON and non-object values", () => {
    expectProtocolError(() => decodeAddressBook("{"), "invalid-address-book");
    expectProtocolError(() => decodeAddressBook("[]"), "invalid-address-book");
    expectProtocolError(
      () => decodeAddressBook('{"format":"meshkeep-address-book-v1","entries":{}}'),
      "invalid-address-book",
    );
  });

  it("adds, replaces, looks up, and removes entries", () => {
    let book: AddressBook = createAddressBook();
    book = setEntry(book, { petname: "zeta", name: NAME });
    book = setEntry(book, { petname: "alpha", name: `/ipns/${NAME}`, note: "first" });

    expect(book.entries.map((entry) => entry.petname)).toEqual(["alpha", "zeta"]);
    expect(findEntry(book, "alpha")).toEqual({ petname: "alpha", name: NAME, note: "first" });
    expectProtocolError(
      () => setEntry(book, { petname: "alpha", name: NAME }),
      "duplicate-petname",
    );

    book = setEntry(book, { petname: "alpha", name: NAME }, { replace: true });
    expect(findEntry(book, "alpha")).toEqual({ petname: "alpha", name: NAME });

    book = removeEntry(book, "zeta");
    expect(book.entries).toHaveLength(1);
    expectProtocolError(() => removeEntry(book, "zeta"), "unknown-petname");
  });
});
