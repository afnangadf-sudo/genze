// Agent notification read surface (Step 7b — backend-extra worker).
//
// The core runner (sibling worker) owns the WRITE side: it inserts exactly
// one notification row per agent task on terminal states (done/failed/
// cancelled) — "one notification on finish", per the no-annoyance rule.
// This module only adds the read side: list + mark-read.
//
// The table is created by the sibling's 014_agent.sql — see CONTRACTS.md
// Step 7. Its columns: id, user_id, task_id (NOT NULL), title,
// read (boolean, default false), created_at. If the table is somehow
// missing, GET returns an empty list and mark-read returns 404 — the
// migration (015) deliberately does not touch this table.

import type { FastifyInstance } from "fastify";
import type { AgentNotification } from "@genze/shared";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NotificationRow {
  id: string;
  task_id: string;
  title: string;
  read: boolean;
  created_at: Date | string;
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string })?.code === "42P01";
}

function toNotification(row: NotificationRow): AgentNotification {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    read: row.read,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function agentNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/notifications", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    let rows: NotificationRow[];
    try {
      const r = await getPool().query<NotificationRow>(
        `SELECT id, task_id, title, read, created_at
         FROM agent_notifications
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [auth.userId],
      );
      rows = r.rows;
    } catch (err) {
      if (isMissingTable(err)) return reply.send({ data: { notifications: [] } });
      throw err;
    }
    return reply.send({ data: { notifications: rows.map(toNotification) } });
  });

  app.post("/notifications/:id/read", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return sendError(reply, 404, "NOT_FOUND", "Notification not found.");
    }
    try {
      const r = await getPool().query(
        `UPDATE agent_notifications SET read = true
         WHERE id = $1 AND user_id = $2
         RETURNING id`,
        [id, auth.userId],
      );
      if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Notification not found.");
    } catch (err) {
      if (isMissingTable(err)) return sendError(reply, 404, "NOT_FOUND", "Notification not found.");
      throw err;
    }
    return reply.send({ data: { read: true } });
  });
}
