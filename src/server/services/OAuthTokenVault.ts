import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT = Buffer.from("ZEOT1");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

/** AES-256-GCM envelope for account OAuth credentials stored in the registry DB. */
export class OAuthTokenVault {
  private constructor(private readonly key: Uint8Array) {}

  static fromKey(key: Uint8Array): OAuthTokenVault {
    if (key.byteLength !== 32) throw new Error("OAuth token encryption key must be exactly 32 bytes.");
    return new OAuthTokenVault(key);
  }

  encrypt(value: unknown): Uint8Array {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([FORMAT, nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt<A>(envelope: Uint8Array): A {
    const bytes = Buffer.from(envelope);
    const headerLength = FORMAT.length + NONCE_LENGTH + TAG_LENGTH;
    if (bytes.length < headerLength || !bytes.subarray(0, FORMAT.length).equals(FORMAT)) {
      throw new Error("Stored OAuth token envelope has an unsupported format.");
    }
    const nonceStart = FORMAT.length;
    const tagStart = nonceStart + NONCE_LENGTH;
    const ciphertextStart = tagStart + TAG_LENGTH;
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(nonceStart, tagStart));
    decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(ciphertextStart)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as A;
  }
}
