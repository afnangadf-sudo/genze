// Short-lived signed download links. The download endpoint carries no auth
// header, so the token IS the authorization: HMAC-SHA256 over
// "<fileId>:<expiresUnix>" keyed by the server's JWT access secret.
// Verification is constant-time; expired or tampered links are rejected.
import crypto from "node:crypto";
import { loadConfig } from "../config.js";
export function signedLinkTtlSec() {
    const raw = Number(process.env.SIGNED_LINK_TTL_SEC);
    if (Number.isInteger(raw) && raw > 0 && raw <= 86400)
        return raw;
    return 900; // 15 minutes
}
function secret() {
    return Buffer.from(loadConfig().jwtAccessSecret, "utf8");
}
function signature(fileId, expires) {
    return crypto
        .createHmac("sha256", secret())
        .update(`${fileId}:${expires}`, "utf8")
        .digest("hex");
}
/** Build the relative download URL for a stored object (the web app prefixes
 *  API_BASE). `basePath` is the route prefix of the owning resource, e.g.
 *  "/api/v1/files" or "/api/v1/studio/images" — the download endpoint lives
 *  at "<basePath>/<id>/download". The HMAC covers only "<id>:<expires>", so
 *  verification is path-independent. */
export function signDownloadUrl(fileId, basePath = "/api/v1/files") {
    const expires = Math.floor(Date.now() / 1000) + signedLinkTtlSec();
    const sig = signature(fileId, expires);
    return `${basePath}/${fileId}/download?expires=${expires}&sig=${sig}`;
}
export function verifyDownloadLink(fileId, expiresRaw, sigRaw) {
    const expires = typeof expiresRaw === "string" ? Number(expiresRaw) : NaN;
    const sig = typeof sigRaw === "string" ? sigRaw : "";
    if (!Number.isInteger(expires) || expires <= 0 || sig.length === 0) {
        return { ok: false, reason: "invalid" };
    }
    const expected = signature(fileId, expires);
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, reason: "invalid" };
    }
    if (expires < Math.floor(Date.now() / 1000)) {
        return { ok: false, reason: "expired" };
    }
    return { ok: true };
}
//# sourceMappingURL=signed.js.map