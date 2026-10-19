// Small user/account reads shared by routes (moved out of routes/chat.ts so
// the Step 4 routes use identical queries).

import { isValidLanguageCode } from "@genze/shared";
import { getPool } from "./db.js";

export async function getUserCountry(userId: string): Promise<string | null> {
  const r = await getPool().query<{ country: string }>(
    "SELECT country FROM users WHERE id = $1",
    [userId],
  );
  return r.rowCount ? r.rows[0].country : null;
}

/** A live (unrevoked) consent record exists for this user + provider. */
export async function hasLiveConsent(userId: string, provider: string): Promise<boolean> {
  const r = await getPool().query(
    "SELECT 1 FROM consent_records WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL",
    [userId, provider],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Loose validation for free-text language codes (user correction 2026-10-18:
 * ANY BCP-47 code is accepted, not just the five UI languages).
 * Re-exported so routes keep one import site.
 */
export function isSupportedLanguage(value: unknown): value is string {
  return isValidLanguageCode(value);
}

/**
 * The user's preferred chat/UI language (`users.preferred_language`, any
 * BCP-47 code as free text). Falls back to 'en' when the row is missing or
 * holds an empty/invalid value.
 */
export async function getUserLanguage(userId: string): Promise<string> {
  const r = await getPool().query<{ preferred_language: string | null }>(
    "SELECT preferred_language FROM users WHERE id = $1",
    [userId],
  );
  if (!r.rowCount) return "en";
  const code = r.rows[0].preferred_language;
  return isValidLanguageCode(code) ? (code as string).toLowerCase() : "en";
}
