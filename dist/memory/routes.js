// Memory routes (prefix /api/v1/memory, all require auth).
// Contract: CONTRACTS.md — Step 4. Manual add/edit/delete/forget-all only —
// no automatic memory writes in v1 (decision #46). Reads happen on the
// threaded chat reply path (see routes/chat.ts), never in temp chat or
// lockdown.
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function bodyOf(req) {
    return req.body ?? {};
}
function toMemory(row) {
    return {
        id: row.id,
        content: row.content,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function validContent(v) {
    return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 500;
}
export async function memoryRoutes(app) {
    app.get("/", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const r = await getPool().query("SELECT * FROM user_memories WHERE user_id = $1 ORDER BY created_at DESC", [auth.userId]);
        return reply.send({ data: { memories: r.rows.map(toMemory) } });
    });
    app.post("/", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const body = bodyOf(req);
        if (!validContent(body.content)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Content must be 1–500 characters.");
        }
        const id = uuidv4();
        await getPool().query("INSERT INTO user_memories (id, user_id, content) VALUES ($1, $2, $3)", [
            id,
            auth.userId,
            body.content.trim(),
        ]);
        const created = await getPool().query("SELECT * FROM user_memories WHERE id = $1", [
            id,
        ]);
        return reply.code(201).send({ data: { memory: toMemory(created.rows[0]) } });
    });
    // Forget everything — registered before /:id so the static path wins.
    app.delete("/", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const r = await getPool().query("DELETE FROM user_memories WHERE user_id = $1", [auth.userId]);
        return reply.send({ data: { deleted: r.rowCount ?? 0 } });
    });
    app.patch("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const id = req.params.id;
        if (typeof id !== "string" || !UUID_RE.test(id)) {
            return sendError(reply, 404, "NOT_FOUND", "Memory not found.");
        }
        const body = bodyOf(req);
        if (!validContent(body.content)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Content must be 1–500 characters.");
        }
        const r = await getPool().query(`UPDATE user_memories SET content = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3 RETURNING *`, [body.content.trim(), id, auth.userId]);
        if (!r.rowCount)
            return sendError(reply, 404, "NOT_FOUND", "Memory not found.");
        return reply.send({ data: { memory: toMemory(r.rows[0]) } });
    });
    app.delete("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const id = req.params.id;
        if (typeof id !== "string" || !UUID_RE.test(id)) {
            return sendError(reply, 404, "NOT_FOUND", "Memory not found.");
        }
        const r = await getPool().query("DELETE FROM user_memories WHERE id = $1 AND user_id = $2", [
            id,
            auth.userId,
        ]);
        if (!r.rowCount)
            return sendError(reply, 404, "NOT_FOUND", "Memory not found.");
        return reply.send({ data: { deleted: true } });
    });
}
//# sourceMappingURL=routes.js.map