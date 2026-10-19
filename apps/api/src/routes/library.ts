// Library routes (prefix /api/v1/library, all require auth).
// Contract: CONTRACTS.md — Step 3. One search across projects, chats and
// files; report/video/agent-task groups exist as empty stubs for later steps.

import type { FastifyInstance } from "fastify";
import type { LibraryGroup, LibraryItem, LibraryItemType } from "@genze/shared";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { deleteFileCascade, deleteProjectCascade, deleteThreadCascade } from "../library/cascade.js";
import { deleteResearchJob } from "../research/runner.js";
import { deleteStudioImage } from "../studio/images.js";
import { deleteAudioOverview } from "../studio/audioOverviews.js";
import { deleteVideoProject } from "../studio/video/runner.js";
import { signDownloadUrl } from "../storage/signed.js";

const RECENT_LIMIT = 5;
const SEARCH_LIMIT = 20;

function like(q: string): string {
  return `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

interface Row {
  id: string;
  title: string;
  snippet: string | null;
  updated_at: Date;
}

function toItem(row: Row): LibraryItem {
  return {
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function searchProjects(userId: string, q: string | null): Promise<LibraryItem[]> {
  const pool = getPool();
  const rows = q
    ? (
        await pool.query<Row>(
          `SELECT id, title, left(instructions, 160) AS snippet, updated_at
           FROM projects WHERE user_id = $1 AND (title ILIKE $2 OR instructions ILIKE $2)
           ORDER BY updated_at DESC LIMIT ${SEARCH_LIMIT}`,
          [userId, like(q)],
        )
      ).rows
    : (
        await pool.query<Row>(
          `SELECT id, title, left(instructions, 160) AS snippet, updated_at
           FROM projects WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${RECENT_LIMIT}`,
          [userId],
        )
      ).rows;
  return rows.map(toItem);
}

async function searchChats(userId: string, q: string | null): Promise<LibraryItem[]> {
  const pool = getPool();
  const rows = q
    ? (
        await pool.query<Row>(
          `SELECT t.id, t.title, NULL::text AS snippet, t.updated_at
           FROM chat_threads t
           WHERE t.user_id = $1 AND (
             t.title ILIKE $2 OR EXISTS (
               SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id AND m.content ILIKE $2
             )
           )
           ORDER BY t.updated_at DESC LIMIT ${SEARCH_LIMIT}`,
          [userId, like(q)],
        )
      ).rows
    : (
        await pool.query<Row>(
          `SELECT id, title, NULL::text AS snippet, updated_at
           FROM chat_threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${RECENT_LIMIT}`,
          [userId],
        )
      ).rows;
  return rows.map(toItem);
}

async function searchFiles(userId: string, q: string | null): Promise<LibraryItem[]> {
  const pool = getPool();
  const rows = q
    ? (
        await pool.query<Row>(
          `SELECT id, original_name AS title, left(extracted_text, 160) AS snippet, created_at AS updated_at
           FROM files
           WHERE user_id = $1 AND search @@ plainto_tsquery('english', $2)
           ORDER BY created_at DESC LIMIT ${SEARCH_LIMIT}`,
          [userId, q],
        )
      ).rows
    : (
        await pool.query<Row>(
          `SELECT id, original_name AS title, left(extracted_text, 160) AS snippet, created_at AS updated_at
           FROM files WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${RECENT_LIMIT}`,
          [userId],
        )
      ).rows;
  return rows.map(toItem);
}

// Step 4: the `report` group lists the user's research jobs (title = topic,
// snippet = report excerpt). The `reports` stub table from Step 3 stays
// unused — research jobs are the real reports.
async function searchReports(userId: string, q: string | null): Promise<LibraryItem[]> {
  const pool = getPool();
  const rows = q
    ? (
        await pool.query<Row>(
          `SELECT id, topic AS title, left(report_markdown, 160) AS snippet, updated_at
           FROM research_jobs WHERE user_id = $1 AND topic ILIKE $2
           ORDER BY updated_at DESC LIMIT ${SEARCH_LIMIT}`,
          [userId, like(q)],
        )
      ).rows
    : (
        await pool.query<Row>(
          `SELECT id, topic AS title, left(report_markdown, 160) AS snippet, updated_at
           FROM research_jobs WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${RECENT_LIMIT}`,
          [userId],
        )
      ).rows;
  return rows.map(toItem);
}

// Step 9: the `image` group lists generated pictures (title = prompt).
async function searchImages(userId: string, q: string | null): Promise<LibraryItem[]> {
  const pool = getPool();
  const rows = q
    ? (
        await pool.query<Row>(
          `SELECT id, prompt AS title, (provider || ' · ' || aspect_ratio) AS snippet, created_at AS updated_at
           FROM studio_images WHERE user_id = $1 AND status = 'ready' AND prompt ILIKE $2
           ORDER BY created_at DESC LIMIT ${SEARCH_LIMIT}`,
          [userId, like(q)],
        )
      ).rows
    : (
        await pool.query<Row>(
          `SELECT id, prompt AS title, (provider || ' · ' || aspect_ratio) AS snippet, created_at AS updated_at
           FROM studio_images WHERE user_id = $1 AND status = 'ready'
           ORDER BY created_at DESC LIMIT ${RECENT_LIMIT}`,
          [userId],
        )
      ).rows;
  return rows.map((row) => ({
    ...toItem(row),
    thumbnailUrl: signDownloadUrl(row.id, "/api/v1/studio/images"),
  }));
}

// Step 9: the `audio` group lists finished audio overviews (playable link).
async function searchAudio(userId: string, q: string | null): Promise<LibraryItem[]> {
  const pool = getPool();
  const rows = q
    ? (
        await pool.query<Row>(
          `SELECT id, title, (length || ' · ' || jsonb_array_length(source_file_ids) || ' source files') AS snippet,
                  created_at AS updated_at
           FROM audio_overviews WHERE user_id = $1 AND status = 'ready' AND title ILIKE $2
           ORDER BY created_at DESC LIMIT ${SEARCH_LIMIT}`,
          [userId, like(q)],
        )
      ).rows
    : (
        await pool.query<Row>(
          `SELECT id, title, (length || ' · ' || jsonb_array_length(source_file_ids) || ' source files') AS snippet,
                  created_at AS updated_at
           FROM audio_overviews WHERE user_id = $1 AND status = 'ready'
           ORDER BY created_at DESC LIMIT ${RECENT_LIMIT}`,
          [userId],
        )
      ).rows;
  return rows.map((row) => ({
    ...toItem(row),
    playUrl: signDownloadUrl(row.id, "/api/v1/studio/audio-overviews"),
  }));
}

// Step 9: the `video` group now lists real Video Director projects
// (replacing the Step 3 stub table).
async function searchVideos(userId: string, q: string | null): Promise<LibraryItem[]> {
  const pool = getPool();
  const rows = q
    ? (
        await pool.query<Row>(
          `SELECT id, title, left(brief, 160) AS snippet, updated_at
           FROM video_projects WHERE user_id = $1 AND status <> 'discarded'
             AND (title ILIKE $2 OR brief ILIKE $2)
           ORDER BY updated_at DESC LIMIT ${SEARCH_LIMIT}`,
          [userId, like(q)],
        )
      ).rows
    : (
        await pool.query<Row>(
          `SELECT id, title, left(brief, 160) AS snippet, updated_at
           FROM video_projects WHERE user_id = $1 AND status <> 'discarded'
           ORDER BY updated_at DESC LIMIT ${RECENT_LIMIT}`,
          [userId],
        )
      ).rows;
  return rows.map(toItem);
}

async function recentStub(
  userId: string,
  table: "sources" | "reports" | "agent_tasks",
): Promise<LibraryItem[]> {
  const rows = (
    await getPool().query<Row>(
      `SELECT id, title, NULL::text AS snippet, created_at AS updated_at
       FROM ${table} WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${RECENT_LIMIT}`,
      [userId],
    )
  ).rows;
  return rows.map(toItem);
}

const DELETABLE: LibraryItemType[] = ["project", "chat", "file", "report", "image", "audio", "video"];

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const rawQ = (req.query as { q?: unknown }).q;
    const q = typeof rawQ === "string" && rawQ.trim().length > 0 ? rawQ.trim().slice(0, 200) : null;

    const [projects, chats, files, reports, videos, agentTasks, images, audio] = await Promise.all([
      searchProjects(auth.userId, q),
      searchChats(auth.userId, q),
      searchFiles(auth.userId, q),
      // Step 4: real research jobs fill the report group.
      searchReports(auth.userId, q),
      // Step 9: real video projects fill the video group.
      searchVideos(auth.userId, q),
      recentStub(auth.userId, "agent_tasks"),
      // Step 9: generated images + audio overviews.
      searchImages(auth.userId, q),
      searchAudio(auth.userId, q),
    ]);

    const groups: LibraryGroup[] = [
      { type: "project", items: projects },
      { type: "chat", items: chats },
      { type: "file", items: files },
      { type: "report", items: reports },
      { type: "video", items: videos },
      { type: "agent-task", items: agentTasks },
      { type: "image", items: images },
      { type: "audio", items: audio },
    ];
    return reply.send({ data: { groups, query: q } });
  });

  app.delete("/:type/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const { type, id } = req.params as { type: string; id: string };
    if (!DELETABLE.includes(type as LibraryItemType)) {
      return sendError(reply, 404, "NOT_FOUND", "Nothing to delete here.");
    }
    let ok = false;
    if (type === "project") ok = await deleteProjectCascade(auth.userId, id);
    else if (type === "chat") ok = await deleteThreadCascade(auth.userId, id);
    else if (type === "report") ok = await deleteResearchJob(auth.userId, id);
    else if (type === "image") ok = await deleteStudioImage(auth.userId, id);
    else if (type === "audio") ok = await deleteAudioOverview(auth.userId, id);
    else if (type === "video") ok = await deleteVideoProject(auth.userId, id);
    else ok = await deleteFileCascade(auth.userId, id);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "Item not found.");
    return reply.send({ data: { deleted: true } });
  });
}
