// Pure server-side verification of a Sign in with Apple identity token.
//
// No network here: the caller supplies the JWKS (fetched via ./jwks.ts).
// Signature verification uses node:crypto directly (no new dependency).

import crypto from "node:crypto";
import type { AppleJwk } from "./jwks.js";

export const APPLE_ISSUER = "https://appleid.apple.com";
/** Clock-skew tolerance on the token expiry check. */
const EXP_SKEW_MS = 60 * 1000;

export interface AppleIdTokenClaims {
  /** Stable Apple user id — the `users.apple_sub` key. */
  sub: string;
  /** Verified email from Apple (private-relay addresses accepted as-is). */
  email: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
}

export class AppleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleTokenError";
  }
}

function b64urlDecode(segment: string): Buffer {
  // Buffer.from(s, "base64url") throws on malformed input.
  return Buffer.from(segment, "base64url");
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  let raw: Buffer;
  try {
    raw = b64urlDecode(segment);
  } catch {
    throw new AppleTokenError(`Apple token ${what} is not valid.`);
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppleTokenError(`Apple token ${what} is not valid JSON.`);
  }
}

export function verifyAppleIdentityToken(
  token: string,
  opts: { clientId: string; nonce?: string; jwks: AppleJwk[] },
): AppleIdTokenClaims {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new AppleTokenError("Apple token must have three parts.");
  }
  const [rawHeader, rawPayload, rawSignature] = segments;
  const header = decodeSegment(rawHeader, "header");
  const payload = decodeSegment(rawPayload, "payload");

  if (header.alg !== "RS256") {
    throw new AppleTokenError("Apple token must be signed with RS256.");
  }
  if (typeof header.kid !== "string" || !header.kid) {
    throw new AppleTokenError("Apple token is missing its key id.");
  }
  const jwk = opts.jwks.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new AppleTokenError("Apple token was signed by an unknown key.");
  }

  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
  } catch {
    throw new AppleTokenError("Apple's signing key is unusable.");
  }
  let signature: Buffer;
  try {
    signature = b64urlDecode(rawSignature);
  } catch {
    throw new AppleTokenError("Apple token signature is not valid.");
  }
  const signingInput = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
  const ok = crypto.verify("RSA-SHA256", signingInput, key, signature);
  if (!ok) {
    throw new AppleTokenError("Apple token signature does not check out.");
  }

  if (payload.iss !== APPLE_ISSUER) {
    throw new AppleTokenError("Apple token was not issued by Apple.");
  }
  const aud = payload.aud;
  const audOk =
    (typeof aud === "string" && aud === opts.clientId) ||
    (Array.isArray(aud) && aud.includes(opts.clientId));
  if (!audOk) {
    throw new AppleTokenError("Apple token was issued for a different app.");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now() - EXP_SKEW_MS) {
    throw new AppleTokenError("Apple token has expired.");
  }
  if (opts.nonce !== undefined) {
    if (typeof payload.nonce !== "string" || payload.nonce !== opts.nonce) {
      throw new AppleTokenError("Apple token nonce does not match.");
    }
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new AppleTokenError("Apple token has no user id.");
  }
  if (typeof payload.email !== "string" || !payload.email) {
    throw new AppleTokenError("Apple didn't share an email address. Please try signing in again.");
  }

  return {
    sub: payload.sub,
    email: payload.email.trim().toLowerCase(),
    iss: payload.iss as string,
    aud: aud as string | string[],
    exp: payload.exp,
    ...(typeof payload.nonce === "string" ? { nonce: payload.nonce } : {}),
  };
}
