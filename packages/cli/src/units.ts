import { CliError } from "./errors.js";

const BYTE_UNITS: Record<string, number> = {
  "": 1,
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/** Parses a positive byte size such as `1083`, `512MiB`, or `2GiB` (binary units only). */
export function parseByteSize(input: string): number {
  const match = /^([1-9]\d*)(B|KiB|MiB|GiB|TiB)?$/.exec(input);
  const multiplier = BYTE_UNITS[match?.[2] ?? ""];
  const value =
    match === null || multiplier === undefined ? Number.NaN : Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`invalid size ${JSON.stringify(input)}; use bytes or B, KiB, MiB, GiB, TiB`);
  }
  return value;
}

export function parsePositiveInteger(input: string): number {
  const value = /^[1-9]\d*$/.test(input) ? Number(input) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`expected a positive integer, got ${JSON.stringify(input)}`);
  }
  return value;
}

/** Parses a retention count: a positive integer, or `all` (returned as 0). */
export function parseKeepCount(input: string): number {
  if (input === "all") {
    return 0;
  }
  if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input))) {
    throw new CliError(`expected a positive integer or "all", got ${JSON.stringify(input)}`);
  }
  return Number(input);
}
