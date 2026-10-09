export type ProtocolErrorCode =
  | "invalid-key"
  | "invalid-name"
  | "invalid-cid"
  | "invalid-petname"
  | "invalid-address-book"
  | "unsupported-format"
  | "duplicate-petname"
  | "unknown-petname";

/** A validation failure on untrusted protocol input. Always fail closed on it. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}
