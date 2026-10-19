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

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

let dummyHash: Promise<string> | null = null;
/**
 * Burns a little CPU on the "unknown email" path so it takes roughly as long
 * as a real bcrypt compare — slows user enumeration via login timing.
 * The result is intentionally discarded.
 */
export function dummyPasswordCompare(password: string): Promise<boolean> {
  dummyHash ??= bcrypt.hash("genze:dummy-password-for-timing", 4);
  return dummyHash.then((h) => bcrypt.compare(password, h));
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Opaque refresh token: 48 random bytes -> 96 hex chars. */
export function newRefreshToken(): string {
  return randomHex(48);
}

/** Email/2FA tokens: 32 random bytes -> 64 hex chars. */
export function newEmailToken(): string {
  return randomHex(32);
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
}

export function signAccessToken(userId: string, sessionId: string, secret: string): string {
  return jwt.sign({ sub: userId, sid: sessionId }, secret, {
    algorithm: "HS256",
    expiresIn: "15m",
  });
}

export function verifyAccessToken(token: string, secret: string): AccessTokenClaims | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (
      payload &&
      typeof payload === "object" &&
      typeof payload.sub === "string" &&
      typeof payload.sid === "string"
    ) {
      return { sub: payload.sub, sid: payload.sid };
    }
    return null;
  } catch {
    return null;
  }
}
