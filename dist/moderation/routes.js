// Moderation toolkit (Step 10, store readiness).
//
// The report/block buttons in mobile/web call these endpoints directly — the
// API is the store-side moderation surface in v1 (no external system).
// Reports are triaged by the app owner (requireOwner); blocks are per user.
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireOwner } from "../middleware/requireOwner.js";
const CONTENT_TYPES = [
    "chat_message",
    "image",
    "video",
    "audio",
    "gem",
    "shared_content",
];
const STATUSES = ["open", "triaged", "resolved", "dismissed"];
function authOf(req) {
    return req.auth;
}
function bodyOf(req) {
    return req.body ?? {};
}
function toReport(row) {
    return {
        id: row.id,
        reporterId: row.reporter_id,
        contentType: row.content_type,
        contentId: row.content_id,
        reason: row.reason,
        details: row.details,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
// ---------------------------------------------------------------------------
// POST /moderation/report (auth) { contentType, contentId, reason, details? }
// -> 201 { data: { report } }
// ---------------------------------------------------------------------------
async function report(req, reply) {
    const body = bodyOf(req);
    if (!CONTENT_TYPES.includes(body.contentType)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "contentType must be one of: chat_message, image, video, audio, gem, shared_content.");
    }
    if (typeof body.contentId !== "string" || !body.contentId.trim()) {
        return sendError(reply, 400, "VALIDATION_ERROR", "contentId is required.");
    }
    if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500) {
        return sendError(reply, 400, "VALIDATION_ERROR", "reason is required (max 500 characters).");
    }
    if (body.details !== undefined && (typeof body.details !== "string" || body.details.length > 2000)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "details must be text up to 2000 characters.");
    }
    const r = await getPool().query(`INSERT INTO moderation_reports (id, reporter_id, content_type, content_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, reporter_id, content_type, content_id, reason, details, status, created_at`, [
        uuidv4(),
        authOf(req).userId,
        body.contentType,
        body.contentId.trim(),
        body.reason.trim(),
        typeof body.details === "string" && body.details.trim() ? body.details.trim() : null,
    ]);
    return reply.code(201).send({ data: { report: toReport(r.rows[0]) } });
}
// ---------------------------------------------------------------------------
// GET /moderation/reports (owner) -> 200 { data: { reports } } newest first
// ---------------------------------------------------------------------------
async function listReports(_req, reply) {
    const r = await getPool().query(`SELECT id, reporter_id, content_type, content_id, reason, details, status, created_at
     FROM moderation_reports ORDER BY created_at DESC`);
    return reply.send({ data: { reports: r.rows.map(toReport) } });
}
// ---------------------------------------------------------------------------
// PATCH /moderation/reports/:id (owner) { status } -> 200 { data: { report } }
// ---------------------------------------------------------------------------
async function triageReport(req, reply) {
    const { id } = req.params;
    const { status } = bodyOf(req);
    if (!STATUSES.includes(status)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "status must be one of: open, triaged, resolved, dismissed.");
    }
    const r = await getPool().query(`UPDATE moderation_reports SET status = $1 WHERE id = $2
     RETURNING id, reporter_id, content_type, content_id, reason, details, status, created_at`, [status, id]);
    if (!r.rowCount)
        return sendError(reply, 404, "NOT_FOUND", "Report not found.");
    return reply.send({ data: { report: toReport(r.rows[0]) } });
}
// ---------------------------------------------------------------------------
// POST /moderation/block (auth) { userId } -> 201 (idempotent)
// DELETE /moderation/block/:userId (auth) -> 200 (idempotent)
// ---------------------------------------------------------------------------
async function blockUser(req, reply) {
    const { userId } = bodyOf(req);
    if (typeof userId !== "string" || !userId) {
        return sendError(reply, 400, "VALIDATION_ERROR", "userId is required.");
    }
    const me = authOf(req).userId;
    if (userId === me) {
        return sendError(reply, 400, "VALIDATION_ERROR", "You can't block yourself.");
    }
    const target = await getPool().query("SELECT id FROM users WHERE id = $1", [userId]);
    if (!target.rowCount)
        return sendError(reply, 404, "NOT_FOUND", "User not found.");
    await getPool().query("INSERT INTO blocked_users (user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [me, userId]);
    return reply.code(201).send({ data: { blocked: true } });
}
async function unblockUser(req, reply) {
    const { userId } = req.params;
    await getPool().query("DELETE FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2", [
        authOf(req).userId,
        userId,
    ]);
    return reply.send({ data: { unblocked: true } });
}
export async function moderationRoutes(app) {
    app.post("/report", { preHandler: authenticate }, report);
    app.get("/reports", { preHandler: requireOwner }, listReports);
    app.patch("/reports/:id", { preHandler: requireOwner }, triageReport);
    app.post("/block", { preHandler: authenticate }, blockUser);
    app.delete("/block/:userId", { preHandler: authenticate }, unblockUser);
}
//# sourceMappingURL=routes.js.map