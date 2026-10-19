// Password hashing and token primitives. Contract recap:
// - passwords: bcrypt, cost 12
// - access token: JWT (HS256), 15 min expiry, claims { sub: userId, sid: sessionId }
// - refresh token: opaque, 48 random bytes hex-encoded, sha256 stored, 30-day
//   expiry (enforced via sessions.created_at), single-use rotation
// - email tokens (verify / reset / 2fa_pending): 32 random bytes hex-encoded,
//   sha256 stored
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
export const BCRYPT_COST = 12;
export const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_COST);
}
export function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
let dummyHash = null;
/**
 * Burns a little CPU on the "unknown email" path so it takes roughly as long
 * as a real bcrypt compare — slows user enumeration via login timing.
 * The result is intentionally discarded.
 */
export function dummyPasswordCompare(password) {
    dummyHash ??= bcrypt.hash("genze:dummy-password-for-timing", 4);
    return dummyHash.then((h) => bcrypt.compare(password, h));
}
export function sha256Hex(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
export function randomHex(bytes) {
    return crypto.randomBytes(bytes).toString("hex");
}
/** Opaque refresh token: 48 random bytes -> 96 hex chars. */
export function newRefreshToken() {
    return randomHex(48);
}
/** Email/2FA tokens: 32 random bytes -> 64 hex chars. */
export function newEmailToken() {
    return randomHex(32);
}
export function signAccessToken(userId, sessionId, secret) {
    return jwt.sign({ sub: userId, sid: sessionId }, secret, {
        algorithm: "HS256",
        expiresIn: "15m",
    });
}
export function verifyAccessToken(token, secret) {
    try {
        const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
        if (payload &&
            typeof payload === "object" &&
            typeof payload.sub === "string" &&
            typeof payload.sid === "string") {
            return { sub: payload.sub, sid: payload.sid };
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=crypto.js.map