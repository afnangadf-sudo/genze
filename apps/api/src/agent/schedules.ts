// Agent schedules (Step 7b — backend-extra worker).
//
// Pure next-run math (`computeNextRun`), an in-process scheduler tick
// (`runDueSchedulesOnce`, driven by `startAgentScheduler`), and the
// schedule CRUD routes (`agentScheduleRoutes`, prefix /api/v1/agent).
//
// The agent core (sibling worker: apps/api/src/agent/runner.ts, guards.ts,
// routes.ts + migration 014) owns task execution, approvals, and the
// notification INSERTS. This module owns the schedule half: it creates the
// task row and hands it to the core via a dynamic import, so a missing
// core module can never crash the scheduler.

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentSchedule, AgentScheduleShape } from "@genze/shared";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Schedule math (pure, UTC).
// ---------------------------------------------------------------------------

/**
 * The next time strictly AFTER `from` that the schedule fires.
 * Exactly-on-the-hour rolls to the next day/week/interval — a schedule
 * that is due "now" was already handled by the current tick.
 */
export function computeNextRun(schedule: AgentScheduleShape, from: Date): Date {
  const t = from.getTime();
  if (schedule.kind === "interval_hours") {
    return new Date(t + schedule.hours * 3600_000);
  }
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  if (schedule.kind === "daily") {
    let next = Date.UTC(y, m, d, schedule.hour, schedule.minute, 0, 0);
    if (next <= t) next += 24 * 3600_000;
    return new Date(next);
  }
  // weekly
  const dayOffset = (schedule.weekday - from.getUTCDay() + 7) % 7;
  let next = Date.UTC(y, m, d + dayOffset, schedule.hour, schedule.minute, 0, 0);
  if (next <= t) next += 7 * 24 * 3600_000;
  return new Date(next);
}

// ---------------------------------------------------------------------------
// Schedule shape validation.
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/**
 * Parse + validate a schedule shape. Returns a plain-language message on
 * failure (no technical words in user-facing strings).
 */
export function parseScheduleShape(
  raw: unknown,
): { ok: true; schedule: AgentScheduleShape } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "Please choose how often this should run." };
  }
  const s = raw as Body;
  if (s.kind === "daily") {
    if (!isInt(s.hour) || (s.hour as number) < 0 || (s.hour as number) > 23) {
      return { ok: false, message: "Hour must be between 0 and 23." };
    }
    if (!isInt(s.minute) || (s.minute as number) < 0 || (s.minute as number) > 59) {
      return { ok: false, message: "Minute must be between 0 and 59." };
    }
    return { ok: true, schedule: { kind: "daily", hour: s.hour, minute: s.minute } };
  }
  if (s.kind === "weekly") {
    if (!isInt(s.weekday) || (s.weekday as number) < 0 || (s.weekday as number) > 6) {
      return { ok: false, message: "Weekday must be between 0 (Sunday) and 6 (Saturday)." };
    }
    if (!isInt(s.hour) || (s.hour as number) < 0 || (s.hour as number) > 23) {
      return { ok: false, message: "Hour must be between 0 and 23." };
    }
    if (!isInt(s.minute) || (s.minute as number) < 0 || (s.minute as number) > 59) {
      return { ok: false, message: "Minute must be between 0 and 59." };
    }
    return {
      ok: true,
      schedule: { kind: "weekly", weekday: s.weekday, hour: s.hour, minute: s.minute },
    };
  }
  if (s.kind === "interval_hours") {
    if (!isInt(s.hours) || (s.hours as number) < 1 || (s.hours as number) > 168) {
      return { ok: false, message: "Interval must be between 1 hour and 168 hours (one week)." };
    }
    return { ok: true, schedule: { kind: "interval_hours", hours: s.hours } };
  }
  return { ok: false, message: "Please choose how often this should run." };
}

// ---------------------------------------------------------------------------
// Runner seam.
//
// The core runner is owned by the sibling worker. We reach it via a dynamic
// import (no hard import cycle), with a test-only override so the scheduler
// tick is testable without the core module present.
// ---------------------------------------------------------------------------

type RunnerStart = (taskId: string) => Promise<void>;

let runnerOverride: RunnerStart | null = null;

/** Test-only seam: inject a stub for startAgentTask. Not for production. */
export function __setRunnerOverride(fn: RunnerStart | null): void {
  runnerOverride = fn;
}

async function startCoreTask(taskId: string): Promise<void> {
  if (runnerOverride) {
    await runnerOverride(taskId);
    return;
  }
  // Non-literal specifier on purpose: the sibling's runner.ts may not exist
  // yet at compile time; TS must not try to resolve it statically. At
  // runtime the import succeeds once the core lands, and failures are
  // caught by the caller and marked honestly.
  const runnerPath = "./runner.js";
  const mod = (await import(runnerPath)) as { startAgentTask: (id: string) => Promise<void> };
  await mod.startAgentTask(taskId);
}

// ---------------------------------------------------------------------------
// Scheduler tick.
// ---------------------------------------------------------------------------

export interface TickResult {
  due: number;
  started: number;
  errors: number;
}

interface ScheduleRow {
  id: string;
  user_id: string;
  title: string;
  task: string;
  auto_approve: boolean;
  approved_once: boolean;
  schedule: AgentScheduleShape;
}

/** One pass over due schedules. Pure of timers — tests call this directly. */
export async function runDueSchedulesOnce(now: Date = new Date()): Promise<TickResult> {
  const pool = getPool();
  const result: TickResult = { due: 0, started: 0, errors: 0 };
  let due: ScheduleRow[];
  try {
    const r = await pool.query<ScheduleRow>(
      `SELECT id, user_id, title, task, auto_approve, approved_once, schedule
       FROM agent_schedules
       WHERE enabled AND next_run_at <= $1::timestamptz`,
      [now.toISOString()],
    );
    due = r.rows;
  } catch (err) {
    // Table missing (e.g. migrations not run) — log honestly, never throw.
    console.warn("[agent-scheduler] could not read due schedules:", (err as Error)?.message ?? err);
    return result;
  }
  result.due = due.length;
  for (const s of due) {
    try {
      await fireSchedule(pool, s, now);
      result.started += 1;
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[agent-scheduler] schedule ${s.id} failed:`,
        (err as Error)?.message ?? err,
      );
    }
  }
  return result;
}

/**
 * Fire one schedule: create the task row (kind 'scheduled', status
 * 'planned'), stamp last/next run, then hand to the core runner when the
 * schedule may run on its own (auto-approve, or the user approved the
 * first run already). A missed tick runs late — exactly once — and the next
 * run is re-anchored to the actual run time.
 */
async function fireSchedule(
  pool: ReturnType<typeof getPool>,
  s: ScheduleRow,
  now: Date,
): Promise<void> {
  const shape = s.schedule;
  const next = computeNextRun(shape, now);
  const taskId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // `task` (request text) and `kind` ('scheduled') are the 014_agent.sql
    // columns; `schedule_id` links the run back to its schedule (015).
    await client.query(
      `INSERT INTO agent_tasks (id, user_id, title, status, kind, task, schedule_id)
       VALUES ($1, $2, $3, 'planned', 'scheduled', $4, $5)`,
      [taskId, s.user_id, s.title, s.task, s.id],
    );
    await client.query(
      `UPDATE agent_schedules
       SET last_run_at = $1::timestamptz, next_run_at = $2::timestamptz, updated_at = now()
       WHERE id = $3`,
      [now.toISOString(), next.toISOString(), s.id],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Hand to the core runner only when the schedule may run on its own.
  // Otherwise the task waits in 'planned' for the user's first approval.
  if (!(s.auto_approve || s.approved_once)) return;
  try {
    await startCoreTask(taskId);
  } catch (err) {
    // Honest failure: the runner module or the run itself failed.
    console.warn(`[agent-scheduler] startAgentTask(${taskId}) failed:`, (err as Error)?.message ?? err);
    await pool
      .query("UPDATE agent_tasks SET status = 'failed' WHERE id = $1", [taskId])
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Start the in-process tick loop. Reads AGENT_SCHEDULER_INTERVAL_MS
 * (default 60000). The timer is unref'd so it never keeps the process
 * alive. Documented as swappable for a real queue later — the DB rows are
 * the source of truth, so a different driver can read the same table.
 */
export function startAgentScheduler(): void {
  if (process.env.NODE_ENV === "test") return; // tests drive the tick directly
  const raw = Number(process.env.AGENT_SCHEDULER_INTERVAL_MS ?? 60000);
  const ms = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60000;
  const tick = (): void => {
    runDueSchedulesOnce().catch((err) =>
      console.warn("[agent-scheduler] tick failed:", (err as Error)?.message ?? err),
    );
  };
  const timer = setInterval(tick, ms);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[agent-scheduler] started, interval ${ms}ms`);
}

// ---------------------------------------------------------------------------
// Routes (Fastify plugin, registered under /api/v1/agent).
// Gate order on every route: auth → validation → ownership (404).
// ---------------------------------------------------------------------------

interface ScheduleDbRow {
  id: string;
  user_id: string;
  title: string;
  task: string;
  schedule: AgentScheduleShape;
  enabled: boolean;
  auto_approve: boolean;
  approved_once: boolean;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();
const isoReq = (v: Date | string): string => new Date(v).toISOString();

function toAgentSchedule(row: ScheduleDbRow): AgentSchedule {
  return {
    id: row.id,
    title: row.title,
    task: row.task,
    schedule: row.schedule,
    enabled: row.enabled,
    autoApprove: row.auto_approve,
    approvedOnce: row.approved_once,
    nextRunAt: iso(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}

function bodyOf(req: FastifyRequest): Body {
  return (req.body as Body | undefined) ?? {};
}

function validId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

async function getOwnedSchedule(userId: string, id: string): Promise<ScheduleDbRow | null> {
  const r = await getPool().query<ScheduleDbRow>(
    "SELECT * FROM agent_schedules WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

export async function agentScheduleRoutes(app: FastifyInstance): Promise<void> {
  // ---------- create ----------

  app.post("/schedules", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length < 3 || title.length > 80) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Give this schedule a name between 3 and 80 characters.");
    }
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (task.length < 3 || task.length > 2000) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Describe what the agent should do (3–2000 characters).");
    }
    const parsed = parseScheduleShape(body.schedule);
    if (!parsed.ok) return sendError(reply, 400, "VALIDATION_ERROR", parsed.message);
    const autoApprove = body.autoApprove === undefined ? false : body.autoApprove;
    if (typeof autoApprove !== "boolean") {
      return sendError(reply, 400, "VALIDATION_ERROR", "autoApprove must be true or false.");
    }

    const id = randomUUID();
    const now = new Date();
    const nextRunAt = computeNextRun(parsed.schedule, now);
    await getPool().query(
      `INSERT INTO agent_schedules
         (id, user_id, title, task, schedule, enabled, auto_approve, approved_once, next_run_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, true, $6, false, $7::timestamptz)`,
      [id, auth.userId, title, task, JSON.stringify(parsed.schedule), autoApprove, nextRunAt.toISOString()],
    );
    const row = await getOwnedSchedule(auth.userId, id);
    return reply.code(201).send({ data: { schedule: toAgentSchedule(row as ScheduleDbRow) } });
  });

  // ---------- list / get ----------

  app.get("/schedules", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<ScheduleDbRow>(
      "SELECT * FROM agent_schedules WHERE user_id = $1 ORDER BY created_at DESC",
      [auth.userId],
    );
    return reply.send({ data: { schedules: r.rows.map(toAgentSchedule) } });
  });

  app.get("/schedules/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    const row = await getOwnedSchedule(auth.userId, id);
    if (!row) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    return reply.send({ data: { schedule: toAgentSchedule(row) } });
  });

  // ---------- update ----------

  app.patch("/schedules/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    const body = bodyOf(req);

    const updates: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      updates.push(`${sql} = $${params.length}`);
    };

    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title.length < 3 || title.length > 80) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Give this schedule a name between 3 and 80 characters.");
      }
      push("title", title);
    }
    if (body.task !== undefined) {
      const task = typeof body.task === "string" ? body.task.trim() : "";
      if (task.length < 3 || task.length > 2000) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Describe what the agent should do (3–2000 characters).");
      }
      push("task", task);
    }
    if (body.schedule !== undefined) {
      const parsed = parseScheduleShape(body.schedule);
      if (!parsed.ok) return sendError(reply, 400, "VALIDATION_ERROR", parsed.message);
      push("schedule", JSON.stringify(parsed.schedule));
      // Re-anchor the next run to the new shape.
      push("next_run_at", computeNextRun(parsed.schedule, new Date()).toISOString());
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return sendError(reply, 400, "VALIDATION_ERROR", "enabled must be true or false.");
      }
      push("enabled", body.enabled);
    }
    if (body.autoApprove !== undefined) {
      if (typeof body.autoApprove !== "boolean") {
        return sendError(reply, 400, "VALIDATION_ERROR", "autoApprove must be true or false.");
      }
      push("auto_approve", body.autoApprove);
    }
    if (updates.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
    }
    const setSql = [...updates, "updated_at = now()"].join(", ");
    const r = await getPool().query<ScheduleDbRow>(
      `UPDATE agent_schedules SET ${setSql} WHERE id = $${params.length + 1} AND user_id = $${params.length + 2} RETURNING *`,
      [...params, id, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    return reply.send({ data: { schedule: toAgentSchedule(r.rows[0]) } });
  });

  // ---------- approve the first run ----------

  app.post("/schedules/:id/approve-first-run", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    const r = await getPool().query(
      `UPDATE agent_schedules SET approved_once = true, updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    return reply.send({ data: { approvedOnce: true } });
  });

  // ---------- delete ----------

  app.delete("/schedules/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    // Tasks already created are left alone; their schedule link is cleared
    // by the ON DELETE SET NULL foreign key.
    const r = await getPool().query(
      "DELETE FROM agent_schedules WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Schedule not found.");
    return reply.send({ data: { deleted: true } });
  });
}
