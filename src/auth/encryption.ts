import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTED_PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    console.warn("[Encryption] TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars) — tokens stored as plaintext");
    return null;
  }
  return buf;
}

/**
 * Encrypts a string with AES-256-GCM.
 * Returns "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>".
 * Falls back to plaintext if TOKEN_ENCRYPTION_KEY is not set.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(12); // 96-bit IV — recommended for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 128-bit authentication tag

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a value produced by encrypt().
 * Returns the value unchanged if it isn't in the encrypted format
 * (handles plaintext rows written before encryption was enabled).
 */
export function decrypt(value: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // plaintext or legacy row

  const key = getKey();
  if (!key) {
    console.error("[Encryption] TOKEN_ENCRYPTION_KEY not set but DB contains encrypted tokens");
    return value;
  }

  const payload = value.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    console.error("[Encryption] Unrecognised encrypted token format");
    return value;
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  } catch {
    // Auth tag mismatch means the data was tampered with or the key is wrong
    console.error("[Encryption] Decryption failed — wrong key or tampered ciphertext");
    throw new Error("Token decryption failed");
  }
}
