// Research routes (prefix /api/v1/research, all require auth).
// Contract: CONTRACTS.md — Step 4. Gate order on POST /jobs:
// auth → validation → thread ownership (404) → LOCKDOWN (403) →
// SEARCH_NOT_CONFIGURED (503) → NO_PROVIDER_AVAILABLE (503) →
// CONSENT_REQUIRED (403). No demo research, ever.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ResearchJob, ResearchJobStatus, ResearchSource } from "@genze/shared";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getUserCountry, hasLiveConsent } from "../users.js";
import { routeChat } from "../providers/models.js";
import { CONSENT_COPY } from "../providers/consentCopy.js";
import { chatAugmentations } from "../chat/lockdown.js";
import { pickSearchProvider } from "../search/index.js";
import { checkLimit, sendLimitExceeded } from "../limits.js";
import {
  reportToDocxBuffer,
  reportToMarkdown,
  reportToPdfBuffer,
  formatCitation,
  type ExportSource,
} from "../export/index.js";
import {
  deleteResearchJob,
  enqueueResearchJob,
  newJobId,
  type DbResearchJob,
  type ResearchStatus,
} from "./runner.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = Record<string, unknown>;

function bodyOf(req: FastifyRequest): Body {
  return (req.body as Body | undefined) ?? {};
}

function toResearchJob(row: DbResearchJob): ResearchJob {
  const p = row.progress ?? { phase: "queued", done: 0, total: 100 };
  return {
    id: row.id,
    threadId: row.thread_id,
    topic: row.topic,
    status: row.status as ResearchJobStatus,
    plan: row.plan ? { steps: row.plan.steps } : null,
    progress: {
      phase: String(p.phase ?? "queued"),
      done: Number(p.done ?? 0),
      total: Number(p.total ?? 100),
      message: typeof p.message === "string" ? p.message : undefined,
    },
    reportMarkdown: row.report_markdown,
    sources: (row.sources ?? []) as ResearchSource[],
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function getOwnedJob(userId: string, jobId: string): Promise<DbResearchJob | null> {
  const r = await getPool().query<DbResearchJob>(
    "SELECT * FROM research_jobs WHERE id = $1 AND user_id = $2",
    [jobId, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

function validId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

const TERMINAL: ResearchStatus[] = ["done", "failed", "cancelled"];

export async function researchRoutes(app: FastifyInstance): Promise<void> {
  // ---------- create ----------

  app.post("/jobs", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);

    // Validation.
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (topic.length < 3 || topic.length > 200) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Topic must be 3–200 characters.");
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
      // Locked thread → 403 LOCKDOWN (contract's exact message).
      if (!chatAugmentations({ lockdown: t.rows[0].lockdown }).web) {
        return sendError(reply, 403, "LOCKDOWN", "Research can't run while this chat is in lockdown.");
      }
    }

    // Daily limit: creating the job counts the unit (starting it later
    // does not double-count; the background runner's token rows are
    // cost-only). Checked before any provider is spent.
    const limit = await checkLimit(auth.userId, "research", 1);
    if (!limit.ok) return sendLimitExceeded(reply, "research");

    // Search provider gate — 503, never a fake report.
    const searchProvider = pickSearchProvider();
    if (!searchProvider) {
      return sendError(
        reply,
        503,
        "SEARCH_NOT_CONFIGURED",
        "Research needs web search, which isn't set up yet. Please try again later.",
      );
    }

    // Chat provider gate (one routed provider per job, decision #45).
    const country = await getUserCountry(auth.userId);
    if (!country) return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const route = routeChat({ country, taskType: "long-context" });
    if (!route) {
      return sendError(
        reply,
        503,
        "NO_PROVIDER_AVAILABLE",
        "No research provider is available for your region right now. Please try again later.",
      );
    }

    // Consent gate (checked once, at creation — decision #45).
    if (!(await hasLiveConsent(auth.userId, route.provider))) {
      const name =
        CONSENT_COPY[route.provider as keyof typeof CONSENT_COPY]?.name ?? route.provider;
      return sendError(
        reply,
        403,
        "CONSENT_REQUIRED",
        `To research with ${name}, please allow Genze to share your research topic with them first.`,
      );
    }

    const id = newJobId();
    const progress = {
      phase: "queued",
      done: 0,
      total: 100,
      provider: route.provider,
      model: route.model.id,
    };
    await getPool().query(
      `INSERT INTO research_jobs (id, user_id, thread_id, topic, status, progress)
       VALUES ($1, $2, $3, $4, 'planned', $5::jsonb)`,
      [id, auth.userId, threadId, topic, JSON.stringify(progress)],
    );
    // The plan phase runs in the background; the user starts execution
    // explicitly via POST /jobs/:id/start (plan-confirmation gate).
    enqueueResearchJob(id);

    const job = await getOwnedJob(auth.userId, id);
    return reply.code(201).send({ data: { job: toResearchJob(job as DbResearchJob) } });
  });

  // ---------- start ----------

  app.post("/jobs/:id/start", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    const r = await getPool().query<DbResearchJob>(
      `UPDATE research_jobs SET status = 'running', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'planned' RETURNING *`,
      [id, auth.userId],
    );
    if (!r.rowCount) {
      const existing = await getOwnedJob(auth.userId, id);
      if (!existing) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
      return sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "This research can't be started in its current state.",
      );
    }
    enqueueResearchJob(id);
    return reply.send({ data: { job: toResearchJob(r.rows[0]) } });
  });

  // ---------- list / get ----------

  app.get("/jobs", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbResearchJob>(
      "SELECT * FROM research_jobs WHERE user_id = $1 ORDER BY created_at DESC",
      [auth.userId],
    );
    return reply.send({ data: { jobs: r.rows.map(toResearchJob) } });
  });

  app.get("/jobs/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    const job = await getOwnedJob(auth.userId, id);
    if (!job) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    return reply.send({ data: { job: toResearchJob(job) } });
  });

  // ---------- SSE progress events ----------

  app.get("/jobs/:id/events", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    const first = await getOwnedJob(auth.userId, id);
    if (!first) return sendError(reply, 404, "NOT_FOUND", "Research not found.");

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
    // job before the polling interval is created (TDZ guard).
    let timer: ReturnType<typeof setInterval> | undefined;
    const sendProgress = (job: DbResearchJob): void => {
      const j = toResearchJob(job);
      const event: Record<string, unknown> = {
        type: "progress",
        phase: j.progress.phase,
        done: j.progress.done,
        total: j.progress.total,
      };
      if (j.progress.message !== undefined) event.message = j.progress.message;
      send(event);
    };
    const finish = (job: DbResearchJob): void => {
      if (job.status === "done") send({ type: "done" });
      else send({ type: "error", code: "RESEARCH_FAILED", message: job.error ?? "Research failed." });
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

    sendProgress(first);
    if (TERMINAL.includes(first.status)) {
      finish(first);
      return;
    }

    let last = JSON.stringify(first.progress);
    timer = setInterval(async () => {
      if (closed) return;
      try {
        raw.write(": ping\n\n");
      } catch {
        cleanup();
        return;
      }
      const job = await getOwnedJob(auth.userId, id);
      if (!job) {
        send({ type: "error", code: "NOT_FOUND", message: "Research not found." });
        cleanup();
        try {
          raw.end();
        } catch {
          // gone
        }
        return;
      }
      const cur = JSON.stringify(job.progress);
      if (cur !== last) {
        last = cur;
        sendProgress(job);
      }
      if (TERMINAL.includes(job.status)) finish(job);
    }, 500);
    raw.on("close", onClose);
  });

  // ---------- delete ----------

  app.delete("/jobs/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    const ok = await deleteResearchJob(auth.userId, id);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    return reply.send({ data: { deleted: true } });
  });

  // ---------- export ----------

  app.get("/jobs/:id/export", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    const job = await getOwnedJob(auth.userId, id);
    if (!job) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    if (job.status !== "done" || !job.report_markdown) {
      return sendError(reply, 404, "NOT_FOUND", "The research report is not ready yet.");
    }
    const format = (req.query as { format?: unknown }).format;
    if (format !== "pdf" && format !== "docx" && format !== "md") {
      return sendError(reply, 400, "VALIDATION_ERROR", "Format must be pdf, docx, or md.");
    }
    const sources: ExportSource[] = (job.sources ?? []).map((s) => ({
      n: s.n,
      title: s.title,
      url: s.url,
    }));
    const filename = `research-${job.id}.${format}`;
    if (format === "md") {
      const md = reportToMarkdown(job.topic, job.report_markdown, sources);
      return reply
        .header("Content-Type", "text/markdown; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(md);
    }
    const buffer =
      format === "pdf"
        ? await reportToPdfBuffer(job.topic, job.report_markdown, sources)
        : await reportToDocxBuffer(job.topic, job.report_markdown, sources);
    const contentType =
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buffer);
  });

  // ---------- citations ----------

  app.get("/jobs/:id/citations", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    const job = await getOwnedJob(auth.userId, id);
    if (!job) return sendError(reply, 404, "NOT_FOUND", "Research not found.");
    const style = (req.query as { style?: unknown }).style;
    if (style !== "apa" && style !== "mla") {
      return sendError(reply, 400, "VALIDATION_ERROR", "Style must be apa or mla.");
    }
    const citations = (job.sources ?? []).map((s) => ({
      n: s.n,
      text: formatCitation(style, { title: s.title, url: s.url, fetchedAt: s.fetchedAt }),
    }));
    return reply.send({ data: { citations } });
  });
}
