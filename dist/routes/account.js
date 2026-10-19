// Account routes (prefix /api/v1/account): profile, GDPR-style export,
// and hard account deletion (cascades to every related row).
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { verifyPassword } from "../crypto.js";
import { authenticate } from "../middleware/authenticate.js";
import { isSupportedLanguage } from "../users.js";
function authOf(req) {
    return req.auth;
}
function bodyOf(req) {
    return req.body ?? {};
}
const USER_COLUMNS = "id, email, email_verified, country, totp_enabled, preferred_language, plan, is_owner, ai_notice_accepted_at, created_at";
function toPublicUser(row) {
    return {
        id: row.id,
        email: row.email,
        emailVerified: row.email_verified,
        country: row.country,
        totpEnabled: row.totp_enabled,
        preferredLanguage: row.preferred_language,
        plan: row.plan === "paid" ? "paid" : "free",
        isOwner: row.is_owner === true,
        aiNoticeAccepted: row.ai_notice_accepted_at != null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
async function me(req, reply) {
    const r = await getPool().query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
        authOf(req).userId,
    ]);
    if (!r.rowCount)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    return reply.send({ data: { user: toPublicUser(r.rows[0]) } });
}
// PATCH /account/me { preferredLanguage?, aiNoticeAccepted? }.
// aiNoticeAccepted=true records the Apple 5.1.2(i) AI notice acceptance
// (stamp now()); the record is append-only — false is a no-op success and
// never clears it.
async function updateMe(req, reply) {
    const body = bodyOf(req);
    const sets = [];
    const values = [];
    let aiNoticeNoop = false;
    if (body.preferredLanguage !== undefined) {
        if (!isSupportedLanguage(body.preferredLanguage)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Unknown language.");
        }
        sets.push(`preferred_language = $${sets.length + 1}`);
        values.push(body.preferredLanguage.toLowerCase());
    }
    if (body.aiNoticeAccepted !== undefined) {
        if (typeof body.aiNoticeAccepted !== "boolean") {
            return sendError(reply, 400, "VALIDATION_ERROR", "aiNoticeAccepted must be true or false.");
        }
        if (body.aiNoticeAccepted) {
            sets.push("ai_notice_accepted_at = now()");
        }
        else {
            aiNoticeNoop = true;
        }
    }
    if (sets.length === 0) {
        if (aiNoticeNoop) {
            // false is a no-op: return the current profile unchanged.
            const current = await getPool().query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
                authOf(req).userId,
            ]);
            if (!current.rowCount)
                return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
            return reply.send({ data: { user: toPublicUser(current.rows[0]) } });
        }
        return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
    }
    values.push(authOf(req).userId);
    const r = await getPool().query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING ${USER_COLUMNS}`, values);
    if (!r.rowCount)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    return reply.send({ data: { user: toPublicUser(r.rows[0]) } });
}
async function exportData(req, reply) {
    const { userId, sessionId } = authOf(req);
    const pool = getPool();
    const u = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
    if (!u.rowCount)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    const s = await pool.query("SELECT id, device_name, ip, created_at, last_active_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    const devices = s.rows.map((x) => ({
        id: x.id,
        deviceName: x.device_name ?? "Unknown device",
        ip: x.ip ?? null,
        lastActiveAt: new Date(x.last_active_at).toISOString(),
        createdAt: new Date(x.created_at).toISOString(),
        current: x.id === sessionId,
    }));
    const c = await pool.query("SELECT provider, granted_at, revoked_at FROM consent_records WHERE user_id = $1", [
        userId,
    ]);
    const consentRecords = c.rows.map((x) => ({
        provider: x.provider,
        grantedAt: new Date(x.granted_at).toISOString(),
        revokedAt: x.revoked_at ? new Date(x.revoked_at).toISOString() : null,
    }));
    const e = await pool.query("SELECT id, feature, provider, units, cost_usd, created_at FROM usage_events WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    const usageSummary = e.rows.map((x) => ({
        id: x.id,
        feature: x.feature,
        provider: x.provider ?? null,
        units: Number(x.units),
        costUsd: x.cost_usd === null || x.cost_usd === undefined ? null : Number(x.cost_usd),
        createdAt: new Date(x.created_at).toISOString(),
    }));
    const payload = {
        user: toPublicUser(u.rows[0]),
        devices,
        consentRecords,
        usageSummary,
        exportedAt: new Date().toISOString(),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", `attachment; filename="genze-export-${stamp}.json"`);
    return reply.send(payload);
}
async function deleteAccount(req, reply) {
    const { userId } = authOf(req);
    const pool = getPool();
    const r = await pool.query("SELECT id, password_hash FROM users WHERE id = $1", [userId]);
    if (!r.rowCount)
        return sendError(reply, 401, "UNAUTHORIZED", "Account no longer exists.");
    const user = r.rows[0];
    const body = req.body ?? {};
    if (user.password_hash) {
        // Password account: prove ownership with the password.
        if (typeof body.password !== "string" || !(await verifyPassword(body.password, user.password_hash))) {
            return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid password.");
        }
    }
    else if (body.oauthConfirm !== true) {
        // OAuth-only account (no password to check): require explicit confirmation.
        return sendError(reply, 400, "VALIDATION_ERROR", "Please confirm account deletion.");
    }
    // FK cascades wipe sessions, email_tokens, consent_records, usage_events
    // and credit_balances with the user row.
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    return reply.send({ data: { ok: true } });
}
export async function accountRoutes(app) {
    app.get("/me", { preHandler: authenticate }, me);
    app.patch("/me", { preHandler: authenticate }, updateMe);
    app.get("/export", { preHandler: authenticate }, exportData);
    app.delete("/", { preHandler: authenticate }, deleteAccount);
}
//# sourceMappingURL=account.js.map