// Abuse protection: manual owner bans + automatic bans on hammering.
// A banned user's sessions are revoked immediately, so the kick-out is
// instant; `authenticate` rejects them on every request afterwards.

import { getPool } from "./db.js";

/** Rate-limit (429) hits inside this window that trigger an automatic ban. */
const AUTO_BAN_WINDOW_MINUTES = 10;
const AUTO_BAN_THRESHOLD = 15;

export type AbuseKind = "rate_limit" | "injection" | "manual";

/** Record one abuse signal for a user. Never throws. */
export async function recordAbuseEvent(
  userId: string,
  kind: AbuseKind,
  detail?: string,
): Promise<void> {
  try {
    await getPool().query(
      "INSERT INTO abuse_events (user_id, kind, detail) VALUES ($1, $2, $3)",
      [userId, kind, detail ?? null],
    );
  } catch {
    /* abuse logging must never break the request */
  }
}

/** Ban a user immediately and revoke all their sessions. */
export async function banUser(userId: string, reason: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE users SET banned_at = now(), ban_reason = $2 WHERE id = $1 AND banned_at IS NULL",
    [userId, reason],
  );
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
    userId,
  ]);
  await recordAbuseEvent(userId, "manual", reason);
}

/** Lift a ban. */
export async function unbanUser(userId: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = $1",
    [userId],
  );
}

/** True when the user is currently banned. */
export async function isBanned(userId: string): Promise<boolean> {
  const r = await getPool().query("SELECT banned_at FROM users WHERE id = $1", [userId]);
  return !!r.rowCount && r.rows[0].banned_at !== null;
}

/**
 * Count recent rate-limit hits; auto-ban past the threshold.
 * Fire-and-forget from the 429 path — never blocks the response.
 */
export async function maybeAutoBan(userId: string): Promise<boolean> {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM abuse_events
       WHERE user_id = $1 AND kind = 'rate_limit'
       AND created_at > now() - ($2 || ' minutes')::interval`,
      [userId, String(AUTO_BAN_WINDOW_MINUTES)],
    );
    const hits = r.rows[0]?.n ?? 0;
    if (hits >= AUTO_BAN_THRESHOLD) {
      const already = await isBanned(userId);
      if (!already) {
        await banUser(
          userId,
          `Automatic: too many abusive requests (${hits} in ${AUTO_BAN_WINDOW_MINUTES} minutes).`,
        );
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
