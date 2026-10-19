// Agent routes (prefix /api/v1/agent, all require auth).
// Contract: CONTRACTS.md — Step 7. Gate order on POST /tasks:
// auth → validation (project/thread owned → 404) → LOCKDOWN (403) →
// BROWSER_NOT_CONFIGURED (503) → LIMIT_EXCEEDED (429) → CREDITS_EXHAUSTED
// (402) → NO_PROVIDER_AVAILABLE (503) → CONSENT_REQUIRED (403).
// No demo agent runs, ever — the demo provider can't browse.

import type { FastifyInstance, FastifyReply } from "fastify";
import { v4 as uuidv4 } from "uuid";
import type {
  AgentApproval,
  AgentApprovalKind,
  AgentPlan,
  AgentPlanStep,
  AgentTask,
  AgentTaskStatus,
} from "@genze/shared";
import { BROWSER_NOT_CONFIGURED, CREDITS_EXHAUSTED } from "@genze/shared";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getUserCountry, hasLiveConsent } from "../users.js";
import { routeChat } from "../providers/models.js";
import { CONSENT_COPY } from "../providers/consentCopy.js";
import { chatAugmentations } from "../chat/lockdown.js";
import { checkLimit, sendLimitExceeded } from "../limits.js";
import { ensureDailyGrant, getBalance } from "../credits.js";
import { pickBrowserDriver } from "./browser.js";
import {
  cancelAgentTask,
  enqueueAgentTask,
  pauseForTakeover,
  resumeAgentTask,
  resumeFromTakeover,
  startAgentTask,
  type AgentPlan as RunnerPlan,
  type DbAgentTask,
} from "./runner.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = Record<string, unknown>;

function bodyOf(req: { body?: unknown }): Body {
  return (req.body as Body | undefined) ?? {};
}

function validId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

const TERMINAL: AgentTaskStatus[] = ["done", "failed", "cancelled", "limit_stopped"];

function toAgentTask(row: DbAgentTask): AgentTask {
  const plan = row.plan as RunnerPlan | null;
  return {
    id: row.id,
    kind: row.kind === "scheduled" ? "scheduled" : "task",
    title: row.title,
    task: row.task,
    status: row.status,
    plan: plan
      ? {
          steps: plan.steps.map(
            (s): AgentPlanStep => ({
              n: s.n,
              action: s.action,
              url: s.url,
              description: s.description,
            }),
          ),
          estimatedMinutes: plan.estimatedMinutes,
          estimatedCostUsd: plan.estimatedCostUsd,
          requiresBrowser: plan.requiresBrowser,
        }
      : null,
    projectId: row.project_id,
    threadId: row.thread_id,
    stepsUsed: row.steps_used,
    liveViewUrl: row.live_view_url,
    reportMarkdown: row.report_markdown,
    resultFiles: (row.result_files ?? []) as AgentTask["resultFiles"],
    screenshots: (row.screenshots ?? []) as AgentTask["screenshots"],
    error: row.error,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function getOwnedTask(userId: string, taskId: string): Promise<DbAgentTask | null> {
  const r = await getPool().query<DbAgentTask>(
    "SELECT * FROM agent_tasks WHERE id = $1 AND user_id = $2",
    [taskId, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

interface DbApproval {
  id: string;
  user_id: string;
  task_id: string;
  kind: string;
  summary: string;
  details: unknown;
  status: string;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
}

function toAgentApproval(row: DbApproval): AgentApproval {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as AgentApprovalKind,
    summary: row.summary,
    details: (row.details ?? null) as AgentApproval["details"],
    status: row.status as AgentApproval["status"],
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}

/**
 * Initial events for a fresh SSE subscriber: the current state, then one
 * `approval_required` per pending approval — a newly opened tab shows the
 * approval card immediately instead of waiting for the next poll tick.
 * Exported for unit tests.
 */
export async function replayEventsFor(task: DbAgentTask): Promise<unknown[]> {
  const events: unknown[] = [];
  const j = toAgentTask(task);
  events.push({ type: "plan", plan: j.plan });
  events.push({
    type: "status",
    status: task.status,
    stepsUsed: task.steps_used,
    liveViewUrl: task.live_view_url,
  });
  if (!TERMINAL.includes(task.status)) {
    const ap = await getPool().query<DbApproval>(
      `SELECT * FROM agent_approvals WHERE task_id = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [task.id],
    );
    for (const row of ap.rows) {
      events.push({ type: "approval_required", approval: toAgentApproval(row) });
    }
  }
  return events;
}

/** Derive task text from a chat thread: title + last user message (≤2000 chars). */
async function deriveTaskFromThread(threadId: string): Promise<string> {
  const t = await getPool().query<{ title: string }>(
    "SELECT title FROM chat_threads WHERE id = $1",
    [threadId],
  );
  const m = await getPool().query<{ content: string }>(
    `SELECT content FROM chat_messages WHERE thread_id = $1 AND role = 'user'
     ORDER BY created_at DESC LIMIT 1`,
    [threadId],
  );
  const title = t.rowCount ? t.rows[0].title.trim() : "";
  const lastUser = m.rowCount ? m.rows[0].content.trim() : "";
  let text = title;
  if (lastUser) text = text ? `${text}\n\nLast message: ${lastUser}` : lastUser;
  text = text.trim();
  if (text.length > 2000) text = text.slice(0, 2000);
  return text;
}

/** Browser must be configured outside tests, or runs are impossible. */
function browserGate(reply: FastifyReply): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (pickBrowserDriver().isConfigured()) return true;
  sendError(reply, 503, BROWSER_NOT_CONFIGURED, "The browser service isn't set up yet. Please try again later.");
  return false;
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // ---------- create ----------

  app.post("/tasks", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);

    // Validation: `task` is optional when `threadId` is given (the task text
    // is derived from the thread). At least one of the two is required.
    const rawTask = typeof body.task === "string" ? body.task.trim() : "";
    if (rawTask && (rawTask.length < 3 || rawTask.length > 2000)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Please describe the task in 3–2000 characters.");
    }
    let projectId: string | null = null;
    if (body.projectId !== undefined && body.projectId !== null) {
      if (!validId(body.projectId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "That project reference is not valid.");
      }
      projectId = body.projectId as string;
      const p = await getPool().query("SELECT id FROM projects WHERE id = $1 AND user_id = $2", [
        projectId,
        auth.userId,
      ]);
      if (!p.rowCount) return sendError(reply, 404, "NOT_FOUND", "Project not found.");
    }
    let threadId: string | null = null;
    if (body.threadId !== undefined && body.threadId !== null) {
      if (!validId(body.threadId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "That chat reference is not valid.");
      }
      threadId = body.threadId as string;
      const t = await getPool().query<{ lockdown: boolean }>(
        "SELECT lockdown FROM chat_threads WHERE id = $1 AND user_id = $2",
        [threadId, auth.userId],
      );
      if (!t.rowCount) return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
      if (!chatAugmentations({ lockdown: t.rows[0].lockdown }).agent) {
        return sendError(
          reply,
          403,
          "LOCKDOWN",
          "The agent can't run while this chat is in lockdown.",
        );
      }
    }

    // Chat handoff: no task text — derive it from the thread.
    let taskText = rawTask;
    if (!taskText && threadId) {
      taskText = await deriveTaskFromThread(threadId);
    }
    if (!taskText) {
      return sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "Please describe the task, or pick a chat with something in it.",
      );
    }

    // Browser gate: no key (outside tests) → 503, never a fake run.
    if (!browserGate(reply)) return;

    // Daily agent-time limit (1 minute to start the run).
    const limit = await checkLimit(auth.userId, "agent", 1);
    if (!limit.ok) return sendLimitExceeded(reply, "agent");

    // Credits: the run bills 1 credit per started minute; it can't start broke.
    await ensureDailyGrant(auth.userId);
    if ((await getBalance(auth.userId)) < 1) {
      return sendError(
        reply,
        402,
        CREDITS_EXHAUSTED,
        "You're out of credits, so the agent can't start. Credits refill tomorrow.",
      );
    }

    // Chat provider gate (one routed provider per task; no demo agent, ever).
    const country = await getUserCountry(auth.userId);
    if (!country) return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const route = routeChat({ country, taskType: "reasoning" });
    if (!route) {
      return sendError(
        reply,
        503,
        "NO_PROVIDER_AVAILABLE",
        "No agent provider is available for your region right now. Please try again later.",
      );
    }

    // Consent gate (checked once, at creation).
    if (!(await hasLiveConsent(auth.userId, route.provider))) {
      const name =
        CONSENT_COPY[route.provider as keyof typeof CONSENT_COPY]?.name ?? route.provider;
      return sendError(
        reply,
        403,
        "CONSENT_REQUIRED",
        `To run the agent with ${name}, please allow Genze to share your task with them first.`,
      );
    }

    const id = uuidv4();
    const title = taskText.length > 80 ? `${taskText.slice(0, 77)}…` : taskText;
    await getPool().query(
      `INSERT INTO agent_tasks (id, user_id, kind, title, task, status, project_id, thread_id)
       VALUES ($1, $2, 'task', $3, $4, 'planned', $5, $6)`,
      [id, auth.userId, title, taskText, projectId, threadId],
    );
    // The plan is generated in the background; the user approves it before
    // any browser work starts (plan-confirmation gate).
    enqueueAgentTask(id);

    const task = await getOwnedTask(auth.userId, id);
    return reply.code(201).send({ data: { task: toAgentTask(task as DbAgentTask) } });
  });

  // ---------- list / get ----------

  app.get("/tasks", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbAgentTask>(
      "SELECT * FROM agent_tasks WHERE user_id = $1 ORDER BY created_at DESC",
      [auth.userId],
    );
    return reply.send({ data: { tasks: r.rows.map(toAgentTask) } });
  });

  app.get("/tasks/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    const task = await getOwnedTask(auth.userId, id);
    if (!task) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    return reply.send({ data: { task: toAgentTask(task) } });
  });

  // ---------- approve (plan → running) ----------

  app.post("/tasks/:id/approve", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    const r = await getPool().query<DbAgentTask>(
      `UPDATE agent_tasks SET status = 'running', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status IN ('planned', 'awaiting_approval')
       RETURNING *`,
      [id, auth.userId],
    );
    if (!r.rowCount) {
      const existing = await getOwnedTask(auth.userId, id);
      if (!existing) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
      return sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "This task can't be started in its current state.",
      );
    }
    // `approved_once` bookkeeping is the sibling worker's seam; here we just run.
    startAgentTask(id);
    return reply.send({ data: { task: toAgentTask(r.rows[0]) } });
  });

  // ---------- cancel ----------

  app.post("/tasks/:id/cancel", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    const ok = await cancelAgentTask(id, auth.userId);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    const task = await getOwnedTask(auth.userId, id);
    return reply.send({ data: { task: task ? toAgentTask(task) : null, cancelled: true } });
  });

  // ---------- SSE events ----------

  app.get("/tasks/:id/events", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    const first = await getOwnedTask(auth.userId, id);
    if (!first) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    const send = (event: unknown): void => {
      if (closed) return;
      try {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    };
    // Declared up-front: finish()/cleanup() may run for an already-terminal
    // task before the polling interval is created (TDZ guard).
    let timer: ReturnType<typeof setInterval> | undefined;
    const stateEvent = (task: DbAgentTask): Record<string, unknown> => ({
      type: "status",
      status: task.status,
      stepsUsed: task.steps_used,
      liveViewUrl: task.live_view_url,
    });
    const finish = (task: DbAgentTask): void => {
      if (task.status === "done") send({ type: "done", report: task.report_markdown });
      else {
        const code =
          task.status === "cancelled"
            ? "AGENT_CANCELLED"
            : task.status === "limit_stopped"
              ? "AGENT_LIMIT_STOPPED"
              : "AGENT_FAILED";
        send({ type: "error", code, message: task.error ?? "The agent task failed." });
      }
      cleanup();
      try {
        raw.end();
      } catch {
        // already gone
      }
    };
    const cleanup = (): void => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      raw.removeListener("close", onClose);
    };
    const onClose = (): void => cleanup();

    // Replay: current state, then any pending approvals (fresh tabs see the
    // approval card immediately).
    const replayed = await replayEventsFor(first);
    for (const e of replayed) send(e);
    if (TERMINAL.includes(first.status)) {
      finish(first);
      return;
    }

    let lastState = JSON.stringify([first.status, first.steps_used, first.live_view_url]);
    // Approvals already replayed must not re-fire on the first poll tick.
    let lastApproval: string | null = null;
    for (const e of replayed) {
      const ev = e as { type?: string; approval?: { id?: string } };
      if (ev.type === "approval_required" && ev.approval?.id) lastApproval = ev.approval.id;
    }
    timer = setInterval(async () => {
      if (closed) return;
      try {
        raw.write(": ping\n\n");
      } catch {
        cleanup();
        return;
      }
      const task = await getOwnedTask(auth.userId, id);
      if (!task) {
        send({ type: "error", code: "NOT_FOUND", message: "Agent task not found." });
        cleanup();
        try {
          raw.end();
        } catch {
          // gone
        }
        return;
      }
      const cur = JSON.stringify([task.status, task.steps_used, task.live_view_url]);
      if (cur !== lastState) {
        lastState = cur;
        const tj = toAgentTask(task);
        if (tj.plan) send({ type: "plan", plan: tj.plan });
        send(stateEvent(task));
      }
      // Approval gate: surface a pending approval exactly once per id.
      const ap = await getPool().query<DbApproval>(
        `SELECT * FROM agent_approvals WHERE task_id = $1 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      if (ap.rowCount && ap.rows[0].id !== lastApproval) {
        lastApproval = ap.rows[0].id;
        send({ type: "approval_required", approval: toAgentApproval(ap.rows[0]) });
      }
      if (TERMINAL.includes(task.status)) finish(task);
    }, 500);
    raw.on("close", onClose);
  });

  // ---------- approval decision ----------

  app.post("/approvals/:id/decide", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Approval not found.");
    const body = bodyOf(req);
    if (typeof body.approve !== "boolean") {
      return sendError(reply, 400, "VALIDATION_ERROR", "Please say yes or no to the request.");
    }
    const r = await getPool().query<DbApproval>(
      "SELECT * FROM agent_approvals WHERE id = $1 AND user_id = $2",
      [id, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Approval not found.");
    const approval = r.rows[0];
    if (approval.status !== "pending") {
      return sendError(reply, 400, "VALIDATION_ERROR", "This request was already decided.");
    }
    if (new Date(approval.expires_at).getTime() < Date.now()) {
      return sendError(
        reply,
        410,
        "CONFIRMATION_EXPIRED",
        "This request expired. The task was stopped.",
      );
    }
    const decided: "approved" | "rejected" = body.approve ? "approved" : "rejected";
    await getPool().query(
      "UPDATE agent_approvals SET status = $1, decided_at = now() WHERE id = $2",
      [decided, id],
    );
    await getPool().query(
      "INSERT INTO connector_audit_log (id, user_id, connector_id, action, details) VALUES ($1, $2, 'agent', $3, $4::jsonb)",
      [
        uuidv4(),
        auth.userId,
        "approval_decided",
        JSON.stringify({ taskId: approval.task_id, approvalId: id, decided }),
      ],
    );
    // Wake the runner immediately (it also polls every 2s as a backstop).
    resumeAgentTask(approval.task_id);
    const updated = await getPool().query<DbApproval>("SELECT * FROM agent_approvals WHERE id = $1", [id]);
    return reply.send({ data: { approval: toAgentApproval(updated.rows[0]) } });
  });

  // ---------- takeover ----------

  app.post("/tasks/:id/takeover", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    const body = bodyOf(req);
    if (body.action !== "take" && body.action !== "release") {
      return sendError(reply, 400, "VALIDATION_ERROR", "Action must be take or release.");
    }
    const task = await getOwnedTask(auth.userId, id);
    if (!task) return sendError(reply, 404, "NOT_FOUND", "Agent task not found.");
    if (body.action === "take") {
      if (TERMINAL.includes(task.status)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "This task already finished.");
      }
      pauseForTakeover(id);
      await getPool().query(
        `UPDATE agent_tasks SET status = 'paused_takeover', updated_at = now()
         WHERE id = $1 AND status IN ('running', 'awaiting_confirmation')`,
        [id],
      );
      await getPool().query(
        "INSERT INTO connector_audit_log (id, user_id, connector_id, action, details) VALUES ($1, $2, 'agent', 'takeover', $3::jsonb)",
        [uuidv4(), auth.userId, JSON.stringify({ taskId: id, action: "take" })],
      );
    } else {
      resumeFromTakeover(id);
      await getPool().query(
        `UPDATE agent_tasks SET status = 'running', updated_at = now()
         WHERE id = $1 AND status = 'paused_takeover'`,
        [id],
      );
      await getPool().query(
        "INSERT INTO connector_audit_log (id, user_id, connector_id, action, details) VALUES ($1, $2, 'agent', 'takeover', $3::jsonb)",
        [uuidv4(), auth.userId, JSON.stringify({ taskId: id, action: "release" })],
      );
    }
    const updated = await getOwnedTask(auth.userId, id);
    return reply.send({ data: { task: updated ? toAgentTask(updated) : null } });
  });
}
