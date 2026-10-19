// Step 8 — browser profile vault.
//
// The authenticated browser profile (a cookies snapshot JSON blob) is
// encrypted at rest with the SAME key as connector OAuth tokens
// (TOKEN_ENCRYPTION_KEY, AES-256-GCM via connectors/tokens.ts), with a
// distinct purpose prefix inside the plaintext:
//
//   "genze:browser-profile:v1:" + <profile JSON>
//
// The prefix gives domain separation: a profile blob can never be
// decrypted and mistaken for an OAuth token (or vice versa), because the
// consumer validates the prefix after decryption and refuses anything
// else. Decision: reuse the existing key with a purpose label instead of
// a new BROWSER_VAULT_KEY — one fewer secret to provision (zero-setup
// rule), same cryptographic strength. Logged in DECISIONS.md.

import { encryptToken, decryptToken } from "../connectors/tokens.js";

export const BROWSER_PROFILE_PURPOSE = "genze:browser-profile:v1:";

export function encryptProfile(profileJson: string): string {
  return encryptToken(BROWSER_PROFILE_PURPOSE + profileJson);
}

export function decryptProfile(blob: string): string {
  const plaintext = decryptToken(blob);
  if (!plaintext.startsWith(BROWSER_PROFILE_PURPOSE)) {
    throw new Error("[browser-vault] profile blob has an unexpected purpose label");
  }
  return plaintext.slice(BROWSER_PROFILE_PURPOSE.length);
}
