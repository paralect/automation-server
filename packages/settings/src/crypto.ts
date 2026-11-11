import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretBox = {
  seal(plain: string): string;
  open(sealed: string): string | null;
};

export function createSecretBox(passphrase: string): SecretBox {
  const key = Buffer.from(hkdfSync("sha256", passphrase, "automation-server", "settings-encryption", 32));
  return {
    seal(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    open(sealed) {
      if (!sealed.startsWith(PREFIX)) return null;
      try {
        const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
