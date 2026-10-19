// Gems routes (chat polish). Contract: CONTRACTS.md "Chat polish — Gems".
//
// Two plugins (registered from src/index.ts, mirroring the skills routes):
//   gemsRoutes            — prefix /api/v1/gems   (gem CRUD + sharing)
//   gemAttachmentRoutes   — prefix /api/v1        (skill/file attach/detach)
//
// Built-in gems (user_id NULL) are read-only templates: PATCH/DELETE and
// skill/file attach on them return 403 FORBIDDEN (clone it first); sharing
// a built-in is a 400 (they are already available to everyone).
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { loadConfig } from "../config.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { FILE_COLUMNS, toGenzeFile } from "../routes/files.js";
import { GEM_COLUMNS, UUID_RE, getOwnedGem, getVisibleGem, toGem, validateGemInput, } from "./service.js";
import { SKILL_COLUMNS, getVisibleSkill, toSkill } from "../skills/service.js";
const BUILTIN_READONLY = "Built-in Gems are read-only. Make your own copy first, then change that.";
function bodyOf(req) {
    return req.body ?? {};
}
function shareUrlFor(token) {
    return `${loadConfig().appUrl}/gems/shared/${token}`;
}
/** Validate skillIds/fileIds on gem create. Returns ids or a plain message. */
async function validateGemAttachments(userId, body) {
    const skillIds = [];
    if (body.skillIds !== undefined) {
        if (!Array.isArray(body.skillIds) ||
            body.skillIds.some((s) => typeof s !== "string")) {
            return { ok: false, message: "skillIds must be an array of skill ids." };
        }
        for (const id of body.skillIds) {
            const skill = await getVisibleSkill(userId, id);
            if (!skill)
                return { ok: false, message: "One of the skills isn't available." };
            skillIds.push(skill.id);
        }
    }
    const fileIds = [];
    if (body.fileIds !== undefined) {
        if (!Array.isArray(body.fileIds) || body.fileIds.some((f) => typeof f !== "string")) {
            return { ok: false, message: "fileIds must be an array of file ids." };
        }
        for (const id of body.fileIds) {
            if (!UUID_RE.test(id))
                return { ok: false, message: "One of the files isn't available." };
            const r = await getPool().query("SELECT id FROM files WHERE id = $1 AND user_id = $2 AND status = 'ready'", [id, userId]);
            if (!r.rowCount)
                return { ok: false, message: "One of the files isn't available." };
            fileIds.push(id);
        }
    }
    return { ok: true, skillIds, fileIds };
}
export async function gemsRoutes(app) {
    // POST /gems — create an owned gem (optionally with attached skills/files).
    app.post("/", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const body = bodyOf(req);
        const parsed = validateGemInput(body, false);
        if (!parsed.ok)
            return sendError(reply, 400, "VALIDATION_ERROR", parsed.message);
        const attachments = await validateGemAttachments(auth.userId, body);
        if (!attachments.ok)
            return sendError(reply, 400, "VALIDATION_ERROR", attachments.message);
        const input = parsed.input;
        const id = uuidv4();
        const r = await getPool().query(`INSERT INTO gems (id, user_id, name, description, instructions, starter_prompts, model_preference)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING ${GEM_COLUMNS}`, [
            id,
            auth.userId,
            input.name,
            input.description,
            input.instructions,
            JSON.stringify(input.starterPrompts ?? []),
            input.modelPreference ?? null,
        ]);
        for (const skillId of attachments.skillIds) {
            await getPool().query("INSERT INTO gem_skills (gem_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, skillId]);
        }
        for (const fileId of attachments.fileIds) {
            await getPool().query("INSERT INTO gem_files (gem_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, fileId]);
        }
        return reply.code(201).send({ data: { gem: toGem(r.rows[0]) } });
    });
    // GET /gems — built-ins first, then the user's own.
    app.get("/", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const r = await getPool().query(`SELECT ${GEM_COLUMNS} FROM gems
       WHERE user_id IS NULL OR user_id = $1
       ORDER BY user_id NULLS FIRST, created_at ASC`, [auth.userId]);
        return reply.send({ data: { gems: r.rows.map((row) => toGem(row)) } });
    });
    // GET /gems/:id — visible (own or built-in) else 404.
    app.get("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const gem = await getVisibleGem(auth.userId, req.params.id);
        if (!gem)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        return reply.send({ data: { gem: toGem(gem) } });
    });
    // PATCH /gems/:id — own gems only; built-ins → 403.
    app.patch("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const gemId = req.params.id;
        const visible = await getVisibleGem(auth.userId, gemId);
        if (!visible)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        if (visible.user_id === null)
            return sendError(reply, 403, "FORBIDDEN", BUILTIN_READONLY);
        const parsed = validateGemInput(bodyOf(req), true);
        if (!parsed.ok)
            return sendError(reply, 400, "VALIDATION_ERROR", parsed.message);
        const input = parsed.input;
        const sets = [];
        const values = [];
        if (input.name !== undefined) {
            sets.push(`name = $${sets.length + 1}`);
            values.push(input.name);
        }
        if (input.description !== undefined) {
            sets.push(`description = $${sets.length + 1}`);
            values.push(input.description);
        }
        if (input.instructions !== undefined) {
            sets.push(`instructions = $${sets.length + 1}`);
            values.push(input.instructions);
        }
        if (input.starterPrompts !== undefined) {
            sets.push(`starter_prompts = $${sets.length + 1}::jsonb`);
            values.push(JSON.stringify(input.starterPrompts));
        }
        if (input.modelPreference !== undefined) {
            sets.push(`model_preference = $${sets.length + 1}`);
            values.push(input.modelPreference);
        }
        if (sets.length === 0) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
        }
        values.push(visible.id);
        const r = await getPool().query(`UPDATE gems SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${values.length} RETURNING ${GEM_COLUMNS}`, values);
        return reply.send({ data: { gem: toGem(r.rows[0]) } });
    });
    // DELETE /gems/:id — own gems only; built-ins → 403. Threads keep working
    // (gem_id → NULL via ON DELETE SET NULL).
    app.delete("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const visible = await getVisibleGem(auth.userId, req.params.id);
        if (!visible)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        if (visible.user_id === null)
            return sendError(reply, 403, "FORBIDDEN", BUILTIN_READONLY);
        await getPool().query("DELETE FROM gems WHERE id = $1", [visible.id]);
        return reply.send({ data: { deleted: true } });
    });
    // POST /gems/:id/share — mint (or reuse) a share token; idempotent.
    // Built-ins → 400 (they are already available to everyone).
    app.post("/:id/share", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const gemId = req.params.id;
        const visible = await getVisibleGem(auth.userId, gemId);
        if (!visible)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        if (visible.user_id === null) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Built-in Gems are already available to everyone.");
        }
        // getVisibleGem returns only own-or-built-in gems; a built-in was
        // handled above, so anything left here is the caller's own gem.
        let token = visible.share_token;
        if (!token) {
            token = randomBytes(32).toString("hex");
            await getPool().query("UPDATE gems SET share_token = $1, updated_at = now() WHERE id = $2", [
                token,
                visible.id,
            ]);
        }
        return reply.send({ data: { shareUrl: shareUrlFor(token) } });
    });
    // DELETE /gems/:id/share — revoke the link. Existing copies keep working
    // (they are independent rows).
    app.delete("/:id/share", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const owned = await getOwnedGem(auth.userId, req.params.id);
        if (!owned)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        await getPool().query("UPDATE gems SET share_token = NULL, updated_at = now() WHERE id = $1", [
            owned.id,
        ]);
        return reply.send({ data: { revoked: true } });
    });
    // POST /gems/shared/:token — clone a shared gem into the caller's account.
    // Only name/description/instructions/starterPrompts/modelPreference travel;
    // attached skills/files never do (they are the original owner's context).
    app.post("/shared/:token", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const token = req.params.token;
        const r = await getPool().query(`SELECT ${GEM_COLUMNS} FROM gems WHERE share_token = $1`, [
            token,
        ]);
        const original = r.rowCount ? r.rows[0] : null;
        if (!original) {
            return sendError(reply, 404, "NOT_FOUND", "This share link doesn't work anymore.");
        }
        if (original.user_id === auth.userId) {
            return sendError(reply, 400, "VALIDATION_ERROR", "That's your own Gem — it's already in your list.");
        }
        const id = uuidv4();
        const inserted = await getPool().query(`INSERT INTO gems (id, user_id, name, description, instructions, starter_prompts, model_preference, copied_from)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING ${GEM_COLUMNS}`, [
            id,
            auth.userId,
            original.name,
            original.description,
            original.instructions,
            JSON.stringify(Array.isArray(original.starter_prompts) ? original.starter_prompts : []),
            original.model_preference,
            original.name,
        ]);
        return reply.code(201).send({ data: { gem: toGem(inserted.rows[0]) } });
    });
}
async function requireOwnedGem(userId, gemId) {
    const visible = await getVisibleGem(userId, gemId);
    if (!visible)
        return null;
    if (visible.user_id === null)
        return null; // built-in: read-only
    if (visible.user_id !== userId)
        return null;
    return visible;
}
export async function gemAttachmentRoutes(app) {
    // ---------- gem skills ----------
    app.get("/gems/:id/skills", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const gem = await requireOwnedGem(auth.userId, req.params.id);
        if (!gem)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        const r = await getPool().query(`SELECT ${SKILL_COLUMNS} FROM skills s
       JOIN gem_skills gs ON gs.skill_id = s.id
       WHERE gs.gem_id = $1 AND (s.user_id IS NULL OR s.user_id = $2)
       ORDER BY s.name ASC`, [gem.id, auth.userId]);
        return reply.send({ data: { skills: r.rows.map(toSkill) } });
    });
    app.post("/gems/:id/skills", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const gem = await requireOwnedGem(auth.userId, req.params.id);
        if (!gem) {
            // Distinguish: built-in gems exist but are read-only.
            const visible = await getVisibleGem(auth.userId, req.params.id);
            if (visible)
                return sendError(reply, 403, "FORBIDDEN", BUILTIN_READONLY);
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        }
        const skillId = bodyOf(req).skillId;
        const skill = typeof skillId === "string" ? await getVisibleSkill(auth.userId, skillId) : null;
        if (!skill)
            return sendError(reply, 400, "VALIDATION_ERROR", "That skill isn't available.");
        await getPool().query("INSERT INTO gem_skills (gem_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [gem.id, skill.id]);
        return reply.send({ data: { attached: true } });
    });
    app.delete("/gems/:id/skills/:skillId", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const { id: gemId, skillId } = req.params;
        const gem = await requireOwnedGem(auth.userId, gemId);
        if (!gem)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        await getPool().query("DELETE FROM gem_skills WHERE gem_id = $1 AND skill_id = $2", [
            gem.id,
            skillId,
        ]);
        return reply.send({ data: { detached: true } });
    });
    // ---------- gem files ----------
    app.get("/gems/:id/files", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const gem = await requireOwnedGem(auth.userId, req.params.id);
        if (!gem)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        const r = await getPool().query(`SELECT ${FILE_COLUMNS} FROM files f
       JOIN gem_files gf ON gf.file_id = f.id
       WHERE gf.gem_id = $1 AND f.user_id = $2
       ORDER BY f.created_at DESC`, [gem.id, auth.userId]);
        return reply.send({ data: { files: r.rows.map((row) => toGenzeFile(row, false)) } });
    });
    app.post("/gems/:id/files", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const gem = await requireOwnedGem(auth.userId, req.params.id);
        if (!gem) {
            const visible = await getVisibleGem(auth.userId, req.params.id);
            if (visible)
                return sendError(reply, 403, "FORBIDDEN", BUILTIN_READONLY);
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        }
        const fileId = bodyOf(req).fileId;
        if (typeof fileId !== "string" || !UUID_RE.test(fileId)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "That file isn't available.");
        }
        const r = await getPool().query("SELECT id FROM files WHERE id = $1 AND user_id = $2 AND status = 'ready'", [fileId, auth.userId]);
        if (!r.rowCount) {
            return sendError(reply, 400, "VALIDATION_ERROR", "That file isn't available.");
        }
        await getPool().query("INSERT INTO gem_files (gem_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [gem.id, fileId]);
        return reply.send({ data: { attached: true } });
    });
    app.delete("/gems/:id/files/:fileId", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const { id: gemId, fileId } = req.params;
        const gem = await requireOwnedGem(auth.userId, gemId);
        if (!gem)
            return sendError(reply, 404, "NOT_FOUND", "Gem not found.");
        await getPool().query("DELETE FROM gem_files WHERE gem_id = $1 AND file_id = $2", [gem.id, fileId]);
        return reply.send({ data: { detached: true } });
    });
}
//# sourceMappingURL=routes.js.map