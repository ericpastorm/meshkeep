import { describe, expect, it } from "vitest";

import { parseByteSize, parsePositiveInteger } from "./units.js";

describe("parseByteSize", () => {
  it.each([
    ["1083", 1083],
    ["1B", 1],
    ["1KiB", 1024],
    ["512MiB", 512 * 1024 ** 2],
    ["2GiB", 2 * 1024 ** 3],
    ["1TiB", 1024 ** 4],
  ])("parses %s", (input, expected) => {
    expect(parseByteSize(input)).toBe(expected);
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5GiB",
    "1GB",
    "1 GiB",
    "1gib",
    "01KiB",
    "9".repeat(20),
  ])("rejects %j", (input) => {
    expect(() => parseByteSize(input)).toThrow("invalid size");
  });
});

describe("parsePositiveInteger", () => {
  it("parses positive integers", () => {
    expect(parsePositiveInteger("5")).toBe(5);
  });

  it.each(["", "0", "-3", "1.5", "1e3", "abc", "9".repeat(20)])("rejects %j", (input) => {
    expect(() => parsePositiveInteger(input)).toThrow("expected a positive integer");
  });
});
