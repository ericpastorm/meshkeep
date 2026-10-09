import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  timingSafeEqual,
} from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  decodePrivateKey,
  type Ed25519KeyMaterial,
  encodePrivateKey,
  ipnsNameFromPublicKey,
  parsePetname,
} from "@meshkeep/protocol";

import { CliError } from "./errors.js";
import { createPrivateFile, readLimitedFile } from "./files.js";

const KEY_SUFFIX = ".key";
const MAX_KEY_FILE_BYTES = 1024;
// DER prefixes for a raw 32-byte Ed25519 seed (PKCS#8) and public key (SPKI).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface StoredKey {
  readonly label: string;
  /** Canonical IPNS name: the site's address. */
  readonly name: string;
  /** `libp2p-protobuf-cleartext` private key bytes. */
  readonly privateKey: Uint8Array;
}

function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
}

/** Decodes a private key and proves its public half matches the seed. */
function verifyKey(bytes: Uint8Array, source: string): Ed25519KeyMaterial {
  let material: Ed25519KeyMaterial;
  try {
    material = decodePrivateKey(bytes);
  } catch (error) {
    throw new CliError(`${source}: ${(error as Error).message}`);
  }
  if (!timingSafeEqual(publicKeyFromSeed(material.seed), material.publicKey)) {
    throw new CliError(`${source}: public key does not match the private seed`);
  }
  return material;
}

export class Keystore {
  readonly directory: string;

  constructor(home: string) {
    this.directory = join(home, "keys");
  }

  private path(label: string): string {
    return join(this.directory, `${parsePetname(label)}${KEY_SUFFIX}`);
  }

  async create(label: string): Promise<StoredKey> {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const encoded = encodePrivateKey({ seed, publicKey: rawPublicKey });
    await createPrivateFile(this.path(label), encoded);
    return { label, name: ipnsNameFromPublicKey(rawPublicKey), privateKey: encoded };
  }

  async load(label: string): Promise<StoredKey> {
    const path = this.path(label);
    let bytes: Buffer;
    try {
      bytes = await readLimitedFile(path, MAX_KEY_FILE_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CliError(
          `no key named ${label}; create one with \`meshkeep key create ${label}\``,
        );
      }
      throw error;
    }
    const material = verifyKey(bytes, `key ${label}`);
    return { label, name: ipnsNameFromPublicKey(material.publicKey), privateKey: bytes };
  }

  async list(): Promise<StoredKey[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const labels = files
      .filter((file) => file.endsWith(KEY_SUFFIX))
      .map((file) => file.slice(0, -KEY_SUFFIX.length))
      .sort();
    return Promise.all(labels.map((label) => this.load(label)));
  }

  /** Imports a key file produced by `export` (or by `ipfs key export`) on another machine. */
  async importFile(label: string, file: string): Promise<StoredKey> {
    const bytes = await readLimitedFile(file, MAX_KEY_FILE_BYTES);
    const material = verifyKey(bytes, file);
    await createPrivateFile(this.path(label), bytes);
    return { label, name: ipnsNameFromPublicKey(material.publicKey), privateKey: bytes };
  }

  async exportFile(label: string, file: string): Promise<StoredKey> {
    const key = await this.load(label);
    await createPrivateFile(file, key.privateKey);
    return key;
  }
}
