import { createAddressBook, ipnsNameFromPublicKey } from "@meshkeep/protocol";
import { describe, expect, it } from "vitest";

import {
  parseGatewayPort,
  resolveTarget,
  siteOrigin,
  siteUrl,
  splitInput,
  TargetError,
  type TargetErrorCode,
} from "./target.js";

const NAME = ipnsNameFromPublicKey(new Uint8Array(32).fill(1));
const book = createAddressBook([{ petname: "their-blog", name: NAME }]);

function expectTargetError(action: () => unknown, code: TargetErrorCode) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TargetError);
    expect((error as TargetError).code).toBe(code);
    return error as TargetError;
  }
  return expect.fail(`expected TargetError ${code}`);
}

describe("splitInput", () => {
  it("splits the petname or address from the path, query, and fragment", () => {
    expect(splitInput("  their-blog  ")).toEqual({ head: "their-blog", suffix: "" });
    expect(splitInput("their-blog/posts/1.html?x=1#top")).toEqual({
      head: "their-blog",
      suffix: "/posts/1.html?x=1#top",
    });
    expect(splitInput("their-blog?q")).toEqual({ head: "their-blog", suffix: "?q" });
    expect(splitInput("their-blog#top")).toEqual({ head: "their-blog", suffix: "#top" });
    expect(splitInput(`ipns://${NAME}/a`)).toEqual({ head: NAME, suffix: "/a" });
    expect(splitInput(`/ipns/${NAME}`)).toEqual({ head: NAME, suffix: "" });
  });
});

describe("resolveTarget", () => {
  it("resolves petnames, ignoring case, and keeps the suffix", () => {
    expect(resolveTarget(book, "Their-Blog/about")).toEqual({
      name: NAME,
      petname: "their-blog",
      suffix: "/about",
    });
  });

  it("accepts an address that is not in the book, in any supported form", () => {
    expect(resolveTarget(book, NAME)).toEqual({ name: NAME, suffix: "" });
    expect(resolveTarget(book, `ipns://${NAME}/x`)).toEqual({ name: NAME, suffix: "/x" });
  });

  it("names the petname that is missing from the book", () => {
    const error = expectTargetError(() => resolveTarget(book, "unknown/x"), "unknown-petname");
    expect(error.petname).toBe("unknown");
  });

  it("refuses empty and malformed input", () => {
    expectTargetError(() => resolveTarget(book, "   "), "empty");
    expectTargetError(() => resolveTarget(book, "/path-only"), "empty");
    expectTargetError(() => resolveTarget(book, "not a name"), "invalid");
    expectTargetError(() => resolveTarget(book, "-bad"), "invalid");
    expectTargetError(() => resolveTarget(book, "https:"), "invalid");
  });
});

describe("site URLs", () => {
  it("gives each site its own origin on the local subdomain gateway", () => {
    expect(siteOrigin(NAME, 8080)).toBe(`http://${NAME}.ipns.localhost:8080`);
    expect(siteOrigin(NAME, 80)).toBe(`http://${NAME}.ipns.localhost`);
    expect(siteUrl({ name: NAME, suffix: "" }, 8080)).toBe(`http://${NAME}.ipns.localhost:8080/`);
    expect(siteUrl({ name: NAME, suffix: "?q=1#a" }, 8080)).toBe(
      `http://${NAME}.ipns.localhost:8080/?q=1#a`,
    );
    expect(siteUrl({ name: NAME, suffix: "/a b/ü" }, 8080)).toBe(
      `http://${NAME}.ipns.localhost:8080/a%20b/%C3%BC`,
    );
  });

  it("never lets the suffix leave the site's origin", () => {
    for (const suffix of ["//evil.example/", "/\\evil.example", "/..//evil.example", "/@evil"]) {
      expect(new URL(siteUrl({ name: NAME, suffix }, 8080)).origin).toBe(siteOrigin(NAME, 8080));
    }
  });

  it("accepts only valid ports", () => {
    expect(parseGatewayPort(1)).toBe(1);
    expect(parseGatewayPort(65_535)).toBe(65_535);
    for (const port of [0, 65_536, 80.5, Number.NaN, "8080", undefined]) {
      expectTargetError(() => parseGatewayPort(port), "invalid");
    }
  });
});
