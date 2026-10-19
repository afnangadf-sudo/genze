// Skills routes (Step 6). Contract: CONTRACTS.md "Step 6 — Skills routes".
//
// Two plugins (both registered from src/index.ts):
//   skillsRoutes           — prefix /api/v1/skills  (skill CRUD)
//   skillAttachmentRoutes  — prefix /api/v1        (project + thread attach/detach)
//
// Built-in skills (user_id NULL) are read-only templates: PATCH/DELETE on
// them return 403 FORBIDDEN — the user clones one via POST instead.
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { SKILL_COLUMNS, UUID_RE, getVisibleSkill, toSkill, validateSkillInput, } from "./service.js";
const BUILTIN_READONLY = "Built-in skills are read-only. Create your own copy with POST /skills instead.";
function bodyOf(req) {
    return req.body ?? {};
}
export async function skillsRoutes(app) {
    // POST /skills — create an owned skill.
    app.post("/", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const parsed = validateSkillInput(bodyOf(req), false);
        if (!parsed.ok)
            return sendError(reply, 400, "VALIDATION_ERROR", parsed.message);
        const input = parsed.input;
        const id = uuidv4();
        const r = await getPool().query(`INSERT INTO skills (id, user_id, name, description, instructions, scripts, is_builtin)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, false)
       RETURNING ${SKILL_COLUMNS}`, [id, auth.userId, input.name, input.description, input.instructions, JSON.stringify(input.scripts ?? [])]);
        return reply.code(201).send({ data: { skill: toSkill(r.rows[0]) } });
    });
    // GET /skills — built-ins first, then the user's own.
    app.get("/", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const r = await getPool().query(`SELECT ${SKILL_COLUMNS} FROM skills
       WHERE user_id IS NULL OR user_id = $1
       ORDER BY is_builtin DESC, created_at ASC`, [auth.userId]);
        return reply.send({ data: { skills: r.rows.map(toSkill) } });
    });
    // GET /skills/:id
    app.get("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const skill = await getVisibleSkill(auth.userId, req.params.id);
        if (!skill)
            return sendError(reply, 404, "NOT_FOUND", "Skill not found.");
        return reply.send({ data: { skill: toSkill(skill) } });
    });
    // PATCH /skills/:id — partial update. Built-ins → 403 FORBIDDEN.
    app.patch("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const skill = await getVisibleSkill(auth.userId, req.params.id);
        if (!skill)
            return sendError(reply, 404, "NOT_FOUND", "Skill not found.");
        if (skill.is_builtin)
            return sendError(reply, 403, "FORBIDDEN", BUILTIN_READONLY);
        const parsed = validateSkillInput(bodyOf(req), true);
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
        if (input.scripts !== undefined) {
            sets.push(`scripts = $${sets.length + 1}::jsonb`);
            values.push(JSON.stringify(input.scripts));
        }
        if (sets.length === 0) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
        }
        values.push(skill.id);
        const r = await getPool().query(`UPDATE skills SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${values.length} RETURNING ${SKILL_COLUMNS}`, values);
        return reply.send({ data: { skill: toSkill(r.rows[0]) } });
    });
    // DELETE /skills/:id — built-ins → 403 FORBIDDEN.
    app.delete("/:id", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const skill = await getVisibleSkill(auth.userId, req.params.id);
        if (!skill)
            return sendError(reply, 404, "NOT_FOUND", "Skill not found.");
        if (skill.is_builtin)
            return sendError(reply, 403, "FORBIDDEN", BUILTIN_READONLY);
        await getPool().query("DELETE FROM skills WHERE id = $1", [skill.id]);
        return reply.send({ data: { deleted: true } });
    });
}
async function requireOwnedProject(userId, projectId) {
    if (!UUID_RE.test(projectId))
        return false;
    const r = await getPool().query("SELECT 1 FROM projects WHERE id = $1 AND user_id = $2", [
        projectId,
        userId,
    ]);
    return !!r.rowCount;
}
async function requireOwnedThread(userId, threadId) {
    if (!UUID_RE.test(threadId))
        return false;
    const r = await getPool().query("SELECT 1 FROM chat_threads WHERE id = $1 AND user_id = $2", [
        threadId,
        userId,
    ]);
    return !!r.rowCount;
}
export async function skillAttachmentRoutes(app) {
    // ---------- project skills ----------
    app.get("/projects/:id/skills", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const projectId = req.params.id;
        if (!(await requireOwnedProject(auth.userId, projectId))) {
            return sendError(reply, 404, "NOT_FOUND", "Project not found.");
        }
        const r = await getPool().query(`SELECT ${SKILL_COLUMNS} FROM skills s
       JOIN project_skills ps ON ps.skill_id = s.id
       WHERE ps.project_id = $1 AND (s.user_id IS NULL OR s.user_id = $2)
       ORDER BY s.name ASC`, [projectId, auth.userId]);
        return reply.send({ data: { skills: r.rows.map(toSkill) } });
    });
    app.post("/projects/:id/skills", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const projectId = req.params.id;
        if (!(await requireOwnedProject(auth.userId, projectId))) {
            return sendError(reply, 404, "NOT_FOUND", "Project not found.");
        }
        const skillId = bodyOf(req).skillId;
        const skill = typeof skillId === "string" ? await getVisibleSkill(auth.userId, skillId) : null;
        if (!skill)
            return sendError(reply, 404, "NOT_FOUND", "Skill not found.");
        await getPool().query("INSERT INTO project_skills (project_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [projectId, skill.id]);
        return reply.send({ data: { attached: true } });
    });
    app.delete("/projects/:id/skills/:skillId", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const { id: projectId, skillId } = req.params;
        if (!(await requireOwnedProject(auth.userId, projectId))) {
            return sendError(reply, 404, "NOT_FOUND", "Project not found.");
        }
        await getPool().query("DELETE FROM project_skills WHERE project_id = $1 AND skill_id = $2", [
            projectId,
            skillId,
        ]);
        return reply.send({ data: { detached: true } });
    });
    // ---------- thread skills ----------
    app.get("/chat/threads/:id/skills", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const threadId = req.params.id;
        if (!(await requireOwnedThread(auth.userId, threadId))) {
            return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
        }
        const r = await getPool().query(`SELECT ${SKILL_COLUMNS} FROM skills s
       JOIN thread_skills ts ON ts.skill_id = s.id
       WHERE ts.thread_id = $1 AND (s.user_id IS NULL OR s.user_id = $2)
       ORDER BY s.name ASC`, [threadId, auth.userId]);
        return reply.send({ data: { skills: r.rows.map(toSkill) } });
    });
    app.post("/chat/threads/:id/skills", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const threadId = req.params.id;
        if (!(await requireOwnedThread(auth.userId, threadId))) {
            return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
        }
        const skillId = bodyOf(req).skillId;
        const skill = typeof skillId === "string" ? await getVisibleSkill(auth.userId, skillId) : null;
        if (!skill)
            return sendError(reply, 404, "NOT_FOUND", "Skill not found.");
        await getPool().query("INSERT INTO thread_skills (thread_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [threadId, skill.id]);
        return reply.send({ data: { attached: true } });
    });
    app.delete("/chat/threads/:id/skills/:skillId", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const { id: threadId, skillId } = req.params;
        if (!(await requireOwnedThread(auth.userId, threadId))) {
            return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
        }
        await getPool().query("DELETE FROM thread_skills WHERE thread_id = $1 AND skill_id = $2", [
            threadId,
            skillId,
        ]);
        return reply.send({ data: { detached: true } });
    });
}
//# sourceMappingURL=routes.js.map