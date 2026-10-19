// Step 9 — Video Director routes (prefix /api/v1/studio).
//
// Estimate-before-generate is a HARD GATE: POST /videos only plans (script +
// storyboard + estimate in the background); the video provider is never
// touched until POST /videos/:id/approve flips the project to `running`.
// Shot ops return the full {data:{video}} so the UI refreshes in one round
// trip (web reconciliation 2026-10-19).

import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  StudioVideo,
  StudioVideoStage,
  StudioVideoStageId,
  StudioShot,
} from "@genze/shared";
import { STUDIO_VIDEO_STAGE_IDS } from "@genze/shared";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../../db.js";
import { sendError } from "../../errors.js";
import { authenticate } from "../../middleware/authenticate.js";
import { getUserCountry, hasLiveConsent } from "../../users.js";
import { routeChat } from "../../providers/models.js";
import { CONSENT_COPY } from "../../providers/consentCopy.js";
import { getStorage } from "../../storage/index.js";
import { signDownloadUrl, verifyDownloadLink } from "../../storage/signed.js";
import { checkLimit, sendLimitExceeded } from "../../limits.js";
import { isDeadModelId, VIDEO_CATALOG } from "../catalog.js";
import {
  approveVideo,
  deleteVideoProject,
  enqueueVideoEstimate,
  getVideo,
  getVideoShots,
  isShotActive,
  regenerateShot,
  sweepStaleVideoProjects,
  videoMaxSecondsPerProject,
  type DbShot,
  type DbVideo,
} from "./runner.js";

export { sweepStaleVideoProjects };

const VIDEO_BASE = "/api/v1/studio/videos";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VIDEO_COLUMNS =
  "id, user_id, title, brief, target_minutes, preferred_provider, music_file_id, status, estimate, approved_at, current_stage, created_at, updated_at";

/* ---------------- serialization ---------------- */

function shotDownloadBase(videoId: string): string {
  return `${VIDEO_BASE}/${videoId}/shots`;
}

function toStudioShot(videoId: string, row: DbShot): StudioShot {
  const ready = row.status === "ready" && !!row.storage_key;
  return {
    id: row.id,
    order: row.n,
    prompt: row.prompt,
    durationSeconds: row.duration_s,
    status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "pending",
    previewUrl: ready ? signDownloadUrl(row.id, shotDownloadBase(videoId)) : null,
  };
}

type StageState = StudioVideoStage["status"];

function deriveStages(video: DbVideo, shots: DbShot[]): StudioVideoStage[] {
  const ids = [...STUDIO_VIDEO_STAGE_IDS] as StudioVideoStageId[];
  const idx = (id: string | null): number => (id ? ids.indexOf(id as StudioVideoStageId) : -1);
  const est = video.estimate;
  const progress = est?.progress;
  const activeName = video.current_stage ?? progress?.phase ?? null;
  const activeIdx = idx(activeName);
  const readyShots = shots.filter((s) => s.status === "ready").length;

  const stateOf = (id: StudioVideoStageId, i: number): { status: StageState; progress: number } => {
    if (video.status === "done") return { status: "done", progress: 100 };
    if (video.status === "failed" || video.status === "discarded") {
      if (i < activeIdx) return { status: "done", progress: 100 };
      if (i === activeIdx && activeIdx >= 0) return { status: "failed", progress: progress?.done ?? 0 };
      return { status: "waiting", progress: 0 };
    }
    if (video.status === "awaiting_approval") {
      return i <= idx("storyboard") ? { status: "done", progress: 100 } : { status: "waiting", progress: 0 };
    }
    // estimating / running
    if (i < activeIdx) return { status: "done", progress: 100 };
    if (i === activeIdx) {
      let p = 0;
      if (id === "shots" && shots.length > 0) p = Math.round((readyShots / shots.length) * 100);
      else if (progress && (progress.phase === id || (id === "script" && progress.phase === "estimate"))) p = progress.done;
      return { status: "running", progress: p };
    }
    // Stages before an unknown active stage but with evidence of completion.
    if (id === "idea") return { status: "done", progress: 100 };
    if ((id === "script" || id === "storyboard") && (est?.scriptMarkdown || shots.length > 0)) {
      return { status: "done", progress: 100 };
    }
    return { status: "waiting", progress: 0 };
  };

  return ids.map((id, i) => ({ id, ...stateOf(id, i) }));
}

export function toStudioVideo(video: DbVideo, shots: DbShot[]): StudioVideo {
  const est = video.estimate;
  return {
    id: video.id,
    brief: video.brief,
    targetMinutes: video.target_minutes,
    status: video.status,
    estimate: est
      ? {
          costUsd: est.costUsd ?? 0,
          totalSeconds: est.totalSeconds,
          estimatedMinutes: est.estimatedMinutes,
        }
      : null,
    stages: deriveStages(video, shots),
    shots: shots.map((s) => toStudioShot(video.id, s)),
    videoUrl:
      video.status === "done" && est?.output?.storageKey
        ? signDownloadUrl(video.id, VIDEO_BASE)
        : null,
    createdAt: new Date(video.created_at).toISOString(),
  };
}

async function fullVideo(userId: string, videoId: string): Promise<StudioVideo | null> {
  const video = await getVideo(userId, videoId);
  if (!video) return null;
  return toStudioVideo(video, await getVideoShots(videoId));
}

/* ---------------- routes ---------------- */

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  // Create: plans only. The estimate (script + storyboard + cost) computes
  // in the background; generation never starts here.
  app.post("/videos", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";
    if (brief.length < 3 || brief.length > 2000) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Describe your video in 3–2000 characters.");
    }
    let targetMinutes = 2;
    if (body.targetMinutes !== undefined) {
      if (typeof body.targetMinutes !== "number" || !Number.isInteger(body.targetMinutes) || body.targetMinutes < 1 || body.targetMinutes > 15) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Target length must be 1–15 minutes.");
      }
      targetMinutes = body.targetMinutes;
    }
    if (targetMinutes * 60 > videoMaxSecondsPerProject()) {
      return sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        `That length would generate ${targetMinutes * 60} seconds, over the ${videoMaxSecondsPerProject()}-second project cap.`,
      );
    }
    let preferred: string | null = null;
    if (body.provider !== undefined) {
      if (typeof body.provider !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown video provider.");
      }
      if (isDeadModelId(body.provider)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "That video model is not available. Please pick another provider.");
      }
      if (!VIDEO_CATALOG.some((m) => m.provider === body.provider)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown video provider.");
      }
      preferred = body.provider;
    }
    let musicFileId: string | null = null;
    if (body.musicFileId !== undefined) {
      if (typeof body.musicFileId !== "string" || !UUID_RE.test(body.musicFileId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "That music file isn't valid.");
      }
      const f = await getPool().query<{ id: string }>(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND status = 'ready'",
        [body.musicFileId, auth.userId],
      );
      if (!f.rowCount) return sendError(reply, 404, "NOT_FOUND", "Music file not found.");
      musicFileId = body.musicFileId;
    }

    // Text stages need a chat provider; without one there is nothing to plan with.
    const country = (await getUserCountry(auth.userId)) ?? "";
    const chatRoute = routeChat({ country, taskType: "long-context" });
    if (!chatRoute) {
      return sendError(reply, 503, "NO_PROVIDER_AVAILABLE", "No chat provider is available for your region right now. Please try again later.");
    }
    if (!(await hasLiveConsent(auth.userId, chatRoute.provider))) {
      const name = CONSENT_COPY[chatRoute.provider as "anthropic" | "openai" | "google"]?.name ?? chatRoute.provider;
      return sendError(reply, 403, "CONSENT_REQUIRED", `To plan videos with ${name}, please allow Genze to share your chat messages with them first.`);
    }

    const id = uuidv4();
    const title = brief.length <= 50 ? brief : `${brief.slice(0, 47)}…`;
    await getPool().query(
      `INSERT INTO video_projects (id, user_id, title, brief, target_minutes, preferred_provider, music_file_id, status, current_stage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'estimating', 'idea')`,
      [id, auth.userId, title, brief, targetMinutes, preferred, musicFileId],
    );
    enqueueVideoEstimate(id);
    const video = await fullVideo(auth.userId, id);
    return reply.code(201).send({ data: { video } });
  });

  app.get("/videos", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbVideo>(
      `SELECT ${VIDEO_COLUMNS} FROM video_projects WHERE user_id = $1 ORDER BY created_at DESC`,
      [auth.userId],
    );
    const videos: StudioVideo[] = [];
    for (const row of r.rows) videos.push(toStudioVideo(row, await getVideoShots(row.id)));
    return reply.send({ data: { videos } });
  });

  app.get("/videos/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const video = await fullVideo(auth.userId, (req.params as { id: string }).id);
    if (!video) return sendError(reply, 404, "NOT_FOUND", "Video not found.");
    return reply.send({ data: { video } });
  });

  // Approve: the hard gate. Generation starts only from here.
  app.post("/videos/:id/approve", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    const res = await approveVideo(auth.userId, id);
    if (!res.ok) {
      if (res.code === "LIMIT_EXCEEDED") return sendLimitExceeded(reply, "video");
      return sendError(reply, res.status, res.code, res.message);
    }
    const video = await fullVideo(auth.userId, id);
    return reply.send({ data: { video } });
  });

  // Delete: cancel a live run, then delete the project + shots + bytes.
  app.delete("/videos/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const ok = await deleteVideoProject(auth.userId, (req.params as { id: string }).id);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "Video not found.");
    return reply.send({ data: { deleted: true } });
  });

  // Signed download of the finished MP4 (no auth header — the token is the auth).
  app.get("/videos/:id/download", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const query = req.query as { expires?: unknown; sig?: unknown };
    const check = verifyDownloadLink(id, query.expires, query.sig);
    if (!check.ok) {
      return sendError(reply, 403, check.reason === "expired" ? "LINK_EXPIRED" : "LINK_INVALID", "This download link is not valid.");
    }
    const r = await getPool().query<{ estimate: { output?: { storageKey?: string } } | null; status: string }>(
      "SELECT estimate, status FROM video_projects WHERE id = $1",
      [id],
    );
    const key = r.rowCount ? r.rows[0].estimate?.output?.storageKey : undefined;
    if (!r.rowCount || r.rows[0].status !== "done" || !key) {
      return sendError(reply, 404, "NOT_FOUND", "Video not found.");
    }
    let bytes: Buffer;
    try {
      bytes = await getStorage().get(key);
    } catch {
      return sendError(reply, 404, "NOT_FOUND", "Video not found.");
    }
    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Length", String(bytes.length));
    reply.header("Content-Disposition", `attachment; filename="genze-video-${id}.mp4"`);
    return reply.send(bytes);
  });

  // ---------- per-shot ops (all return the full video) ----------

  const editable = (v: { status: string }): boolean =>
    v.status === "awaiting_approval" || v.status === "running";

  app.post("/videos/:id/shots/:shotId/regenerate", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const { id, shotId } = req.params as { id: string; shotId: string };
    const res = await regenerateShot(auth.userId, id, shotId);
    if (!res.ok) return sendError(reply, res.status, res.code, res.message);
    return reply.send({ data: { video: await fullVideo(auth.userId, id) } });
  });

  app.patch("/videos/:id/shots/:shotId/reorder", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const { id, shotId } = req.params as { id: string; shotId: string };
    const video = await getVideo(auth.userId, id);
    if (!video) return sendError(reply, 404, "NOT_FOUND", "Video not found.");
    if (!editable(video)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "This video can't be changed anymore.");
    }
    const shots = await getVideoShots(id);
    if (!shots.some((s) => s.id === shotId)) {
      return sendError(reply, 404, "NOT_FOUND", "Shot not found.");
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const order = body.order;
    const ids = shots.map((s) => s.id);
    if (
      !Array.isArray(order) ||
      order.length !== ids.length ||
      new Set(order).size !== ids.length ||
      order.some((o) => typeof o !== "string" || !ids.includes(o as string))
    ) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Order must list every shot exactly once.");
    }
    const pool = getPool();
    await pool.query("BEGIN");
    try {
      for (let i = 0; i < (order as string[]).length; i++) {
        await pool.query("UPDATE video_shots SET n = $2 WHERE id = $1", [(order as string[])[i], i]);
      }
      await pool.query("COMMIT");
    } catch {
      await pool.query("ROLLBACK");
      throw new Error("Reorder failed.");
    }
    await pool.query("UPDATE video_projects SET updated_at = now() WHERE id = $1", [id]);
    return reply.send({ data: { video: await fullVideo(auth.userId, id) } });
  });

  app.delete("/videos/:id/shots/:shotId", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const { id, shotId } = req.params as { id: string; shotId: string };
    const video = await getVideo(auth.userId, id);
    if (!video) return sendError(reply, 404, "NOT_FOUND", "Video not found.");
    if (!editable(video)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "This video can't be changed anymore.");
    }
    const s = await getPool().query<{ id: string; storage_key: string | null }>(
      "SELECT id, storage_key FROM video_shots WHERE id = $1 AND video_id = $2",
      [shotId, id],
    );
    if (!s.rowCount) return sendError(reply, 404, "NOT_FOUND", "Shot not found.");
    if (isShotActive(shotId)) {
      return sendError(reply, 409, "VALIDATION_ERROR", "That clip is rendering right now. Please wait.");
    }
    const pool = getPool();
    await pool.query("DELETE FROM video_shots WHERE id = $1", [shotId]);
    const remaining = await getVideoShots(id);
    for (let i = 0; i < remaining.length; i++) {
      await pool.query("UPDATE video_shots SET n = $2 WHERE id = $1", [remaining[i].id, i]);
    }
    await pool.query("UPDATE video_projects SET updated_at = now() WHERE id = $1", [id]);
    if (s.rows[0].storage_key) {
      try {
        await getStorage().delete(s.rows[0].storage_key as string);
      } catch { /* best effort */ }
    }
    return reply.send({ data: { video: await fullVideo(auth.userId, id) } });
  });

  // Preview: the shot already embeds previewUrl when ready; this refreshes it
  // (fresh signed link) and returns the full video in one round trip.
  app.get("/videos/:id/shots/:shotId/preview", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const { id, shotId } = req.params as { id: string; shotId: string };
    const video = await getVideo(auth.userId, id);
    if (!video) return sendError(reply, 404, "NOT_FOUND", "Video not found.");
    const s = await getPool().query<{ id: string; status: string }>(
      "SELECT id, status FROM video_shots WHERE id = $1 AND video_id = $2",
      [shotId, id],
    );
    if (!s.rowCount) return sendError(reply, 404, "NOT_FOUND", "Shot not found.");
    if (s.rows[0].status !== "ready") {
      return sendError(reply, 404, "NOT_FOUND", "That clip isn't ready yet.");
    }
    return reply.send({ data: { video: await fullVideo(auth.userId, id) } });
  });

  // Signed shot download (no auth header — the token is the auth).
  app.get("/videos/:id/shots/:shotId/download", async (req, reply: FastifyReply) => {
    const { id, shotId } = req.params as { id: string; shotId: string };
    const query = req.query as { expires?: unknown; sig?: unknown };
    const check = verifyDownloadLink(shotId, query.expires, query.sig);
    if (!check.ok) {
      return sendError(reply, 403, check.reason === "expired" ? "LINK_EXPIRED" : "LINK_INVALID", "This download link is not valid.");
    }
    const s = await getPool().query<{ storage_key: string | null; status: string }>(
      "SELECT storage_key, status FROM video_shots WHERE id = $1 AND video_id = $2",
      [shotId, id],
    );
    if (!s.rowCount || s.rows[0].status !== "ready" || !s.rows[0].storage_key) {
      return sendError(reply, 404, "NOT_FOUND", "Clip not found.");
    }
    let bytes: Buffer;
    try {
      bytes = await getStorage().get(s.rows[0].storage_key as string);
    } catch {
      return sendError(reply, 404, "NOT_FOUND", "Clip not found.");
    }
    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Length", String(bytes.length));
    return reply.send(bytes);
  });

  // ---------- SSE ----------

  app.get("/videos/:id/events", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    const first = await fullVideo(auth.userId, id);
    if (!first) return sendError(reply, 404, "NOT_FOUND", "Video not found.");

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
    // Declared up-front (TDZ guard — decision #63).
    let timer: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      raw.removeListener("close", onClose);
    };
    const onClose = (): void => cleanup();
    const finish = (video: StudioVideo): void => {
      const errMsg = (video.estimate as { error?: string } | null)?.error;
      if (video.status === "done") send({ type: "done", video });
      else send({ type: "error", code: "VIDEO_FAILED", message: errMsg ?? "The video couldn't be finished." });
      cleanup();
      try {
        raw.end();
      } catch { /* gone */ }
    };
    const emitStages = (video: StudioVideo, last: Map<string, string>): void => {
      for (const st of video.stages) {
        const key = `${st.id}:${st.status}:${st.progress}`;
        if (last.get(st.id) !== key) {
          last.set(st.id, key);
          const event: Record<string, unknown> = {
            type: "progress",
            stage: st.id,
            done: st.progress,
            total: 100,
          };
          if (st.status === "running") event.message = stageMessage(st.id);
          send(event);
        }
      }
    };

    const seen = new Map<string, string>();
    emitStages(first, seen);
    if (["done", "failed", "discarded"].includes(first.status)) {
      finish(first);
      return;
    }
    raw.on("close", onClose);
    timer = setInterval(async () => {
      if (closed) return;
      try {
        raw.write(": ping\n\n");
      } catch {
        cleanup();
        return;
      }
      const video = await fullVideo(auth.userId, id);
      if (!video) {
        send({ type: "error", code: "NOT_FOUND", message: "Video not found." });
        cleanup();
        try {
          raw.end();
        } catch { /* gone */ }
        return;
      }
      emitStages(video, seen);
      if (["done", "failed", "discarded"].includes(video.status)) finish(video);
    }, 500);
  });
}

function stageMessage(stage: string): string {
  switch (stage) {
    case "idea":
      return "Starting with your idea…";
    case "script":
      return "Writing the script…";
    case "storyboard":
      return "Planning the shots…";
    case "shots":
      return "Rendering the clips…";
    case "voiceover":
      return "Recording the voiceover…";
    case "music":
      return "Adding music…";
    case "captions":
      return "Writing captions…";
    case "assembly":
      return "Assembling the final video…";
    default:
      return "Working…";
  }
}
