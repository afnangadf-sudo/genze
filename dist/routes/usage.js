// Usage dashboard (prefix /api/v1/usage).
//
// GET /usage/summary (auth) -> UsageSummary: per-feature used/cap/resetAt for
// the current UTC day, the credit balance + today's grant, and today's
// provider cost (SUM of usage_events.cost_usd). cap is null when the plan has
// no row for the feature (unlimited).
import { getPool } from "../db.js";
import { authenticate } from "../middleware/authenticate.js";
import { METERED_FEATURES, getPlanCap, getUserPlan, nextUtcMidnightIso, usageConsumed, utcDayKey, utcDayStart, } from "../limits.js";
import { getBalance, grantedToday } from "../credits.js";
export async function usageRoutes(app) {
    app.get("/summary", { preHandler: authenticate }, async (req, reply) => {
        const userId = req.auth.userId;
        const plan = await getUserPlan(userId);
        const midnight = utcDayStart().toISOString();
        const resetAt = nextUtcMidnightIso();
        const features = [];
        for (const feature of METERED_FEATURES) {
            features.push({
                feature,
                used: await usageConsumed(userId, feature),
                cap: await getPlanCap(plan, feature),
                resetAt,
            });
        }
        const cost = await getPool().query("SELECT COALESCE(sum(cost_usd), 0) AS s FROM usage_events WHERE user_id = $1 AND created_at >= $2", [userId, midnight]);
        const summary = {
            plan,
            day: utcDayKey(),
            features,
            credits: {
                balance: await getBalance(userId),
                grantedToday: await grantedToday(userId),
            },
            costUsdToday: Number(cost.rows[0].s),
        };
        return reply.send({ data: summary });
    });
}
//# sourceMappingURL=usage.js.map