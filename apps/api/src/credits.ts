// Credit wallet (Step 5). Free plan only in v1: a daily grant of
// FREE_CREDITS_PER_DAY credits; spends block when the balance is too low.
// Expensive features (agent minutes, video seconds) call spendCredits in
// Steps 7/9 — this module ships the functions + tests now.

import { v4 as uuidv4 } from "uuid";
import { getPool } from "./db.js";
import { getUserPlan, utcDayKey } from "./limits.js";

const DEFAULT_FREE_CREDITS_PER_DAY = 100;

/** Read lazily at call time; unset/invalid => default. */
function freeCreditsPerDay(): number {
  const raw = (process.env.FREE_CREDITS_PER_DAY ?? "").trim();
  if (!raw) return DEFAULT_FREE_CREDITS_PER_DAY;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_FREE_CREDITS_PER_DAY;
}

export async function getBalance(userId: string): Promise<number> {
  const r = await getPool().query<{ credits: string }>(
    "SELECT credits FROM credit_balances WHERE user_id = $1",
    [userId],
  );
  return r.rowCount ? Number(r.rows[0].credits) : 0;
}

/** Credits granted to the user today (free-plan daily grant). */
export async function grantedToday(userId: string): Promise<number> {
  const reason = `daily_grant:${utcDayKey()}`;
  const r = await getPool().query<{ s: string | null }>(
    "SELECT COALESCE(sum(delta), 0) AS s FROM credit_ledger WHERE user_id = $1 AND reason = $2",
    [userId, reason],
  );
  return Number(r.rows[0].s);
}

/**
 * Grants today's free credits if not granted yet. Idempotent per UTC day:
 * the partial unique index on (user_id, reason) makes the ledger INSERT the
 * atomic gate — concurrent callers race, exactly one wins (rowCount 1).
 * Free plan only; paid users get 0. Returns the amount granted (0 = none).
 */
export async function ensureDailyGrant(userId: string): Promise<number> {
  if ((await getUserPlan(userId)) !== "free") return 0;
  const amount = freeCreditsPerDay();
  const reason = `daily_grant:${utcDayKey()}`;
  const pool = getPool();
  const inserted = await pool.query(
    "INSERT INTO credit_ledger (id, user_id, delta, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [uuidv4(), userId, amount, reason],
  );
  if ((inserted.rowCount ?? 0) === 0) return 0; // already granted today
  await pool.query(
    `INSERT INTO credit_balances (user_id, credits, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET credits = credit_balances.credits + $2, updated_at = now()`,
    [userId, amount],
  );
  return amount;
}

/** Alias kept for the Steps 7/9 call sites (grant + tests use this name). */
export async function grantDailyCredits(userId: string): Promise<number> {
  return ensureDailyGrant(userId);
}

/**
 * Spend `amount` credits for `reason`. The daily grant is applied lazily
 * first, so a first-of-the-day spend always sees today's grant.
 * Returns false when the balance is too low — the caller turns that into a
 * plain-language message (nothing is deducted, nothing is recorded).
 */
export async function spendCredits(
  userId: string,
  amount: number,
  reason: string,
): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  await ensureDailyGrant(userId);
  const pool = getPool();
  const balance = await getBalance(userId);
  if (balance < amount) return false;
  await pool.query(
    "UPDATE credit_balances SET credits = credits - $2, updated_at = now() WHERE user_id = $1",
    [userId, amount],
  );
  await pool.query(
    "INSERT INTO credit_ledger (id, user_id, delta, reason) VALUES ($1, $2, $3, $4)",
    [uuidv4(), userId, -amount, reason],
  );
  return true;
}
