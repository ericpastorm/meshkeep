import { base32 } from "multiformats/bases/base32";
import { base36 } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";

import { ProtocolError } from "./errors.js";

/** Multicodec for a libp2p public key, used by IPNS names. */
export const LIBP2P_KEY_CODEC = 0x72;

const MAX_IDENTIFIER_LENGTH = 256;
const anyBase = base32.decoder.or(base36.decoder).or(base58btc.decoder);

function decodeCid(input: string): CID | undefined {
  if (input.length === 0 || input.length > MAX_IDENTIFIER_LENGTH) {
    return undefined;
  }
  try {
    // CIDv0 is bare base58btc without a multibase prefix.
    return input.startsWith("Qm") ? CID.parse(input) : CID.parse(input, anyBase);
  } catch {
    return undefined;
  }
}

function stripPrefix(input: string, prefix: string): string {
  return input.startsWith(prefix) ? input.slice(prefix.length) : input;
}

/**
 * Parses an IPNS name (`k51…`, base32 `bafz…`, or `/ipns/<name>`) and returns its canonical
 * base36 CIDv1 form, which is what Kubo prints and what Meshkeep stores.
 */
export function parseIpnsName(input: string): string {
  const cid = decodeCid(stripPrefix(input.trim(), "/ipns/"));
  if (cid === undefined || cid.version !== 1 || cid.code !== LIBP2P_KEY_CODEC) {
    throw new ProtocolError("invalid-name", `not an IPNS key name: ${JSON.stringify(input)}`);
  }
  return cid.toString(base36);
}

export function isIpnsName(input: string): boolean {
  try {
    parseIpnsName(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses an immutable content CID (bare or `/ipfs/<cid>`) and returns its canonical base32
 * CIDv1 form. CIDv0 inputs are upgraded; libp2p-key CIDs are rejected because they name keys,
 * not content.
 */
export function parseContentCid(input: string): string {
  const cid = decodeCid(stripPrefix(input.trim(), "/ipfs/"));
  if (cid === undefined || cid.code === LIBP2P_KEY_CODEC) {
    throw new ProtocolError("invalid-cid", `not a content CID: ${JSON.stringify(input)}`);
  }
  return cid.toV1().toString(base32);
}
