// Owner admin (prefix /api/v1/admin): provider kill switches.
//
// GET /admin/providers -> every known provider with configured / enabled /
// killedBy (env|db|null) + regions + capabilities. Never leaks key values
// (reuses getProviderStatus(), booleans only).
// PATCH /admin/providers/:id { killed } -> toggles the DB kill switch.
// An env kill always wins: a DB toggle cannot re-enable an env-disabled
// provider, and killedBy reports "env" in that case. A circuit-breaker trip
// shows as killedBy "db" with the stored reason (the shared
// ProviderAdminStatus type is extended locally, never edited).
import { getProviderStatus } from "../providers/registry.js";
import { isCircuitTripped, circuitTripInfo } from "../providers/circuit.js";
import { killedBy, setProviderKilled } from "../providers/killswitches.js";
import { requireOwner } from "../middleware/requireOwner.js";
import { sendError } from "../errors.js";
import { getPool } from "../db.js";
import { banUser, unbanUser } from "../abuse.js";
const KNOWN_PROVIDERS = [
    "anthropic",
    "openai",
    "google",
    "kling",
    "steel",
    "elevenlabs",
];
function toAdminRow(p) {
    const tripped = isCircuitTripped(p.id);
    const row = {
        id: p.id,
        configured: p.configured,
        enabled: p.enabled,
        killedBy: killedBy(p.id, tripped),
        regions: [...p.regions],
        capabilities: [...p.capabilities],
    };
    if (tripped) {
        const info = circuitTripInfo(p.id);
        if (info.reason)
            row.circuitReason = info.reason;
        row.trippedUntil = info.trippedUntil;
    }
    return row;
}
export async function adminRoutes(app) {
    app.get("/providers", { preHandler: requireOwner }, async (_req, reply) => {
        const providers = getProviderStatus().map(toAdminRow);
        return reply.send({ data: { providers } });
    });
    app.patch("/providers/:id", { preHandler: requireOwner }, async (req, reply) => {
        const id = req.params.id;
        if (!KNOWN_PROVIDERS.includes(id)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Unknown provider.");
        }
        const body = req.body ?? {};
        if (typeof body.killed !== "boolean") {
            return sendError(reply, 400, "VALIDATION_ERROR", "killed must be true or false.");
        }
        await setProviderKilled(id, body.killed);
        const status = getProviderStatus().find((p) => p.id === id);
        const provider = toAdminRow(status);
        return reply.send({ data: { provider } });
    });
    // ---------- user safety (owner only) ----------
    /** List users for the owner: who is in the app and who is suspended. */
    app.get("/users", { preHandler: requireOwner }, async (_req, reply) => {
        const r = await getPool().query(`SELECT id, email, is_owner, banned_at, ban_reason, created_at
       FROM users ORDER BY created_at DESC LIMIT 200`);
        return reply.send({
            data: {
                users: r.rows.map((u) => ({
                    id: u.id,
                    email: u.email,
                    isOwner: u.is_owner === true,
                    bannedAt: u.banned_at ? new Date(u.banned_at).toISOString() : null,
                    banReason: u.ban_reason,
                    createdAt: new Date(u.created_at).toISOString(),
                })),
            },
        });
    });
    /** Suspend a user immediately: their sessions are revoked on the spot. */
    app.post("/users/:id/ban", { preHandler: requireOwner }, async (req, reply) => {
        const id = req.params.id;
        const body = req.body ?? {};
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "Suspended by the app owner.";
        const target = await getPool().query("SELECT id, is_owner FROM users WHERE id = $1", [id]);
        if (!target.rowCount)
            return sendError(reply, 404, "NOT_FOUND", "User not found.");
        if (target.rows[0].is_owner === true) {
            return sendError(reply, 400, "VALIDATION_ERROR", "The app owner cannot be suspended.");
        }
        await banUser(id, reason);
        return reply.send({ data: { banned: true } });
    });
    /** Lift a suspension. */
    app.post("/users/:id/unban", { preHandler: requireOwner }, async (req, reply) => {
        const id = req.params.id;
        const target = await getPool().query("SELECT id FROM users WHERE id = $1", [id]);
        if (!target.rowCount)
            return sendError(reply, 404, "NOT_FOUND", "User not found.");
        await unbanUser(id);
        return reply.send({ data: { banned: false } });
    });
    /** Recent abuse signals for owner review (newest first). */
    app.get("/abuse-events", { preHandler: requireOwner }, async (_req, reply) => {
        const r = await getPool().query(`SELECT e.id, e.user_id, u.email, e.kind, e.detail, e.created_at
       FROM abuse_events e JOIN users u ON u.id = e.user_id
       ORDER BY e.created_at DESC LIMIT 100`);
        return reply.send({
            data: {
                events: r.rows.map((e) => ({
                    id: e.id,
                    userId: e.user_id,
                    email: e.email,
                    kind: e.kind,
                    detail: e.detail,
                    createdAt: new Date(e.created_at).toISOString(),
                })),
            },
        });
    });
}
//# sourceMappingURL=admin.js.map