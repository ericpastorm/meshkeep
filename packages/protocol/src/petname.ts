import { ProtocolError } from "./errors.js";
import { isIpnsName } from "./identifiers.js";

/** A DNS-label-like local nickname: lowercase letters, digits, and inner hyphens. */
const PETNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates a petname. Petnames are local and never globally unique; they must not look like an
 * IPNS name, so that `resolve <input>` is never ambiguous.
 */
export function parsePetname(input: string): string {
  if (!PETNAME_PATTERN.test(input)) {
    throw new ProtocolError(
      "invalid-petname",
      `petname must be 1-63 lowercase letters, digits, or inner hyphens: ${JSON.stringify(input)}`,
    );
  }
  if (isIpnsName(input)) {
    throw new ProtocolError("invalid-petname", `petname must not be an IPNS name: ${input}`);
  }
  return input;
}
