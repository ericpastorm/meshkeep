import { base36 } from "multiformats/bases/base36";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";

import { ProtocolError } from "./errors.js";
import { LIBP2P_KEY_CODEC } from "./identifiers.js";

export const ED25519_SEED_LENGTH = 32;
export const ED25519_PUBLIC_KEY_LENGTH = 32;

// libp2p key protobuf: `message Key { KeyType Type = 1; bytes Data = 2; }` with Ed25519 = 1.
// The private Data field is seed || public key, matching Kubo's
// `libp2p-protobuf-cleartext` key export/import format.
const PRIVATE_KEY_HEADER = Uint8Array.of(0x08, 0x01, 0x12, 0x40);
const PUBLIC_KEY_HEADER = Uint8Array.of(0x08, 0x01, 0x12, 0x20);
const PRIVATE_KEY_LENGTH =
  PRIVATE_KEY_HEADER.length + ED25519_SEED_LENGTH + ED25519_PUBLIC_KEY_LENGTH;

export interface Ed25519KeyMaterial {
  seed: Uint8Array;
  publicKey: Uint8Array;
}

function requireLength(bytes: Uint8Array, length: number, label: string): void {
  if (bytes.length !== length) {
    throw new ProtocolError("invalid-key", `${label} must be ${length} bytes, got ${bytes.length}`);
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function encodePrivateKey(key: Ed25519KeyMaterial): Uint8Array {
  requireLength(key.seed, ED25519_SEED_LENGTH, "Ed25519 seed");
  requireLength(key.publicKey, ED25519_PUBLIC_KEY_LENGTH, "Ed25519 public key");
  return concat(PRIVATE_KEY_HEADER, key.seed, key.publicKey);
}

/**
 * Decodes a `libp2p-protobuf-cleartext` Ed25519 private key. It does not check that the public
 * half derives from the seed; callers with a signing implementation must do that.
 */
export function decodePrivateKey(bytes: Uint8Array): Ed25519KeyMaterial {
  requireLength(bytes, PRIVATE_KEY_LENGTH, "encoded Ed25519 private key");
  if (!PRIVATE_KEY_HEADER.every((byte, index) => bytes[index] === byte)) {
    throw new ProtocolError("invalid-key", "not a libp2p Ed25519 private key");
  }
  const body = bytes.subarray(PRIVATE_KEY_HEADER.length);
  return {
    seed: body.slice(0, ED25519_SEED_LENGTH),
    publicKey: body.slice(ED25519_SEED_LENGTH),
  };
}

/** Derives the canonical IPNS name (base36 CIDv1, libp2p-key, identity multihash). */
export function ipnsNameFromPublicKey(publicKey: Uint8Array): string {
  requireLength(publicKey, ED25519_PUBLIC_KEY_LENGTH, "Ed25519 public key");
  const digest = identity.digest(concat(PUBLIC_KEY_HEADER, publicKey));
  return CID.createV1(LIBP2P_KEY_CODEC, digest).toString(base36);
}
