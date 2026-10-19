// Daily usage limits (Step 5 enforcement).
//
// Quota consumption is measured in *quota units*, which differ from the
// token units stored on usage_events rows (those stay token-denominated for
// cost attribution):
//   - chat:     one completed reply = one row (feature='chat', non-demo).
//   - research: one row in research_jobs (created today) OR fact_checks
//               (created today) — both draw from the same pool. The
//               background runner's token metering rows are cost-only.
//   - files:    whole MB per upload (units on the feature='files' row).
//   - agent:    minutes; video: seconds (sum of units; wired in Steps 7/9).
// Daily reset is UTC midnight (decision #79).
import { LIMIT_EXCEEDED } from "@genze/shared";
import { getPool } from "./db.js";
import { sendError } from "./errors.js";
export const METERED_FEATURES = ["chat", "research", "agent", "video", "files"];
/** Start of the current UTC day. */
export function utcDayStart(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
/** ISO timestamp of the next UTC midnight (when quotas reset). */
export function nextUtcMidnightIso(now = new Date()) {
    return new Date(utcDayStart(now).getTime() + 24 * 3600 * 1000).toISOString();
}
/** UTC calendar day covered by the current figures, YYYY-MM-DD. */
export function utcDayKey(now = new Date()) {
    return utcDayStart(now).toISOString().slice(0, 10);
}
export async function getUserPlan(userId) {
    const r = await getPool().query("SELECT plan FROM users WHERE id = $1", [userId]);
    if (!r.rowCount)
        return "free";
    return r.rows[0].plan === "paid" ? "paid" : "free";
}
// Free-plan env overrides (read lazily at call time; unset/invalid values
// fall through to the seeded plan_limits rows). agent/video have no env
// override in v1 — they come from plan_limits.
const FREE_ENV_CAPS = {
    chat: "FREE_CHAT_PER_DAY",
    research: "FREE_RESEARCH_PER_DAY",
    files: "FREE_FILE_MB_PER_DAY",
};
function freeCapFromEnv(feature) {
    const name = FREE_ENV_CAPS[feature];
    if (!name)
        return null;
    const raw = (process.env[name] ?? "").trim();
    if (!raw)
        return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}
/**
 * Daily cap for (plan, feature). Null when no row exists = unlimited.
 * Free plan: env override wins, then the seeded plan_limits row.
 * Paid plan: the seeded (10x placeholder) row.
 */
export async function getPlanCap(plan, feature) {
    if (plan === "free") {
        const envCap = freeCapFromEnv(feature);
        if (envCap !== null)
            return envCap;
    }
    const r = await getPool().query("SELECT daily_cap FROM plan_limits WHERE plan = $1 AND feature = $2", [plan, feature]);
    if (!r.rowCount)
        return null;
    return Number(r.rows[0].daily_cap);
}
/** Quota units consumed today for (user, feature). */
export async function usageConsumed(userId, feature) {
    const midnight = utcDayStart().toISOString();
    const pool = getPool();
    if (feature === "research") {
        const r = await pool.query(`SELECT (SELECT count(*) FROM research_jobs WHERE user_id = $1 AND created_at >= $2)
            + (SELECT count(*) FROM fact_checks WHERE user_id = $1 AND created_at >= $2) AS n`, [userId, midnight]);
        return Number(r.rows[0].n);
    }
    if (feature === "chat") {
        // usage_events.units stores tokens (cost attribution); the quota is in
        // messages, so we count rows. Demo rows never consume quota (decision #79).
        const r = await pool.query(`SELECT count(*) AS n FROM usage_events
       WHERE user_id = $1 AND feature = 'chat' AND created_at >= $2
         AND (provider IS NULL OR provider <> 'demo')`, [userId, midnight]);
        return Number(r.rows[0].n);
    }
    // files (whole MB), agent (minutes), video (seconds): units ARE quota units.
    const r = await pool.query(`SELECT COALESCE(sum(units), 0) AS s FROM usage_events
     WHERE user_id = $1 AND feature = $2 AND created_at >= $3
       AND (provider IS NULL OR provider <> 'demo')`, [userId, feature, midnight]);
    return Number(r.rows[0].s);
}
/**
 * True when the user may spend `units` of `feature` right now. Checks BEFORE
 * spending / persisting, never after.
 */
export async function checkLimit(userId, feature, units = 1) {
    const plan = await getUserPlan(userId);
    const cap = await getPlanCap(plan, feature);
    if (cap === null)
        return { ok: true };
    const used = await usageConsumed(userId, feature);
    if (used + units > cap)
        return { ok: false, resetAt: nextUtcMidnightIso() };
    return { ok: true };
}
const FEATURE_LABELS = {
    chat: "chat",
    research: "research",
    agent: "agent time",
    video: "video generation",
    files: "file uploads",
};
/**
 * 429 LIMIT_EXCEEDED with a plain-language message and
 * details { feature, resetAt } per the shared LimitExceededDetails contract.
 */
export function sendLimitExceeded(reply, feature) {
    return sendError(reply, 429, LIMIT_EXCEEDED, `You've reached today's limit for ${FEATURE_LABELS[feature]}. Your limit resets at midnight (UTC).`, { feature, resetAt: nextUtcMidnightIso() });
}
//# sourceMappingURL=limits.js.map