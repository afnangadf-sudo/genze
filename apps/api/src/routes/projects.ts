// Project routes (prefix /api/v1/projects, all require auth).
// Contract: CONTRACTS.md — Step 3. Projects hold saved instructions (used as
// the system prompt for their chats) and attached files.

import type { FastifyInstance } from "fastify";
import type { Project } from "@genze/shared";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { deleteProjectCascade } from "../library/cascade.js";

type Body = Record<string, unknown>;

function bodyOf(req: { body: unknown }): Body {
  return (req.body as Body | undefined) ?? {};
}

interface DbProject {
  id: string;
  title: string;
  instructions: string;
  default_style_id: string | null;
  file_count: string;
  created_at: Date;
  updated_at: Date;
}

function toProject(row: DbProject): Project {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    defaultStyleId: row.default_style_id,
    fileCount: Number(row.file_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT_WITH_COUNT = `
  SELECT p.id, p.title, p.instructions, p.default_style_id, p.created_at, p.updated_at,
         (SELECT count(*) FROM files f WHERE f.project_id = p.id) AS file_count
  FROM projects p`;

function validTitle(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 80;
}

function validInstructions(v: unknown): v is string {
  return typeof v === "string" && v.length <= 4000;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);
    if (!validTitle(body.title)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Title must be 1–80 characters.");
    }
    const instructions = body.instructions === undefined ? "" : body.instructions;
    if (!validInstructions(instructions)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Instructions must be at most 4000 characters.");
    }
    const id = uuidv4();
    await getPool().query(
      "INSERT INTO projects (id, user_id, title, instructions) VALUES ($1, $2, $3, $4)",
      [id, auth.userId, (body.title as string).trim(), instructions],
    );
    const created = await getPool().query<DbProject>(`${SELECT_WITH_COUNT} WHERE p.id = $1`, [id]);
    return reply.code(201).send({ data: { project: toProject(created.rows[0]) } });
  });

  app.get("/", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbProject>(
      `${SELECT_WITH_COUNT} WHERE p.user_id = $1 ORDER BY p.updated_at DESC`,
      [auth.userId],
    );
    return reply.send({ data: { projects: r.rows.map(toProject) } });
  });

  app.get("/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbProject>(
      `${SELECT_WITH_COUNT} WHERE p.id = $1 AND p.user_id = $2`,
      [(req.params as { id: string }).id, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Project not found.");
    return reply.send({ data: { project: toProject(r.rows[0]) } });
  });

  app.patch("/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    const body = bodyOf(req);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.title !== undefined) {
      if (!validTitle(body.title)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Title must be 1–80 characters.");
      }
      updates.push(`title = $${values.length + 1}`);
      values.push((body.title as string).trim());
    }
    if (body.instructions !== undefined) {
      if (!validInstructions(body.instructions)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Instructions must be at most 4000 characters.");
      }
      updates.push(`instructions = $${values.length + 1}`);
      values.push(body.instructions);
    }
    // Step 4: default writing style for Write drafts (owned style, or null to clear).
    if (body.defaultStyleId !== undefined) {
      if (body.defaultStyleId !== null) {
        if (typeof body.defaultStyleId !== "string" || !UUID_RE.test(body.defaultStyleId)) {
          return sendError(reply, 400, "VALIDATION_ERROR", "That writing style reference is not valid.");
        }
        const st = await getPool().query(
          "SELECT id FROM writing_styles WHERE id = $1 AND user_id = $2",
          [body.defaultStyleId, auth.userId],
        );
        if (!st.rowCount) {
          return sendError(reply, 400, "VALIDATION_ERROR", "That writing style is not available.");
        }
      }
      updates.push(`default_style_id = $${values.length + 1}`);
      values.push(body.defaultStyleId);
    }
    if (updates.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
    }
    values.push(id, auth.userId);
    const r = await getPool().query<{ id: string }>(
      `UPDATE projects SET ${updates.join(", ")}, updated_at = now()
       WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING id`,
      values,
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Project not found.");
    const updated = await getPool().query<DbProject>(`${SELECT_WITH_COUNT} WHERE p.id = $1`, [id]);
    return reply.send({ data: { project: toProject(updated.rows[0]) } });
  });

  app.delete("/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const ok = await deleteProjectCascade(auth.userId, (req.params as { id: string }).id);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "Project not found.");
    return reply.send({ data: { deleted: true } });
  });
}
