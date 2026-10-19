// Connector OAuth token encryption (Step 6).
//
// AES-256-GCM with a random 12-byte IV per value. Stored format is
// `iv:ciphertext:tag`, all hex. The 32-byte key comes from
// TOKEN_ENCRYPTION_KEY (see src/config.ts). Tokens are NEVER persisted in
// plaintext.
import crypto from "node:crypto";
import { loadConfig } from "../config.js";
const IV_BYTES = 12;
function key() {
    const hex = loadConfig().tokenEncryptionKey; // validated to 64 hex chars
    return Buffer.from(hex, "hex");
}
export function encryptToken(plaintext) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${ct.toString("hex")}:${tag.toString("hex")}`;
}
export function decryptToken(payload) {
    const parts = payload.split(":");
    if (parts.length !== 3 || !/^[0-9a-f]+$/.test(parts[0]) || !/^[0-9a-f]+$/.test(parts[2])) {
        throw new Error("[tokens] malformed encrypted token payload");
    }
    const [ivHex, ctHex, tagHex] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}
//# sourceMappingURL=tokens.js.map