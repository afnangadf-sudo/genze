// Step 9 — Audio Overviews: a two-host spoken summary of the user's files.
//
// POST creates the row (status "pending") and a background job: script via
// the chat router (two-host dialogue; short≈2min / medium≈5min / long≈10min),
// TTS alternating two voices, concatenated MP3. The Library `audio` group
// picks up finished overviews with a playable signed URL.
// Voice cloning is NOT v1 (no such endpoint, by design).

import type { FastifyInstance } from "fastify";
import type { AudioOverview, AudioOverviewLength } from "@genze/shared";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getUserCountry, getUserLanguage, hasLiveConsent } from "../users.js";
import { routeChat } from "../providers/models.js";
import { makeChatProvider } from "../providers/instances.js";
import { completeWithProvider } from "../providers/complete.js";
import { CONSENT_COPY } from "../providers/consentCopy.js";
import { getStorage } from "../storage/index.js";
import { signDownloadUrl, verifyDownloadLink } from "../storage/signed.js";
import { recordUsage } from "../usage.js";
import { VoiceGateError, synthesizeSpeech, TTS_COST_PER_M } from "./voice.js";
import { concatMp3 } from "./video/assembly.js";

const OVERVIEW_BASE = "/api/v1/studio/audio-overviews";
const LENGTHS: AudioOverviewLength[] = ["short", "medium", "long"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Target spoken words per length (≈150 wpm: 2 / 5 / 10 minutes). */
const TARGET_WORDS: Record<AudioOverviewLength, number> = { short: 300, medium: 750, long: 1500 };

interface DbOverview {
  id: string;
  user_id: string;
  title: string;
  length: AudioOverviewLength;
  source_file_ids: string[];
  status: "pending" | "running" | "ready" | "failed";
  storage_key: string | null;
  error: string | null;
  created_at: Date;
}

const OVERVIEW_COLUMNS = "id, user_id, title, length, source_file_ids, status, storage_key, error, created_at";

function toAudioOverview(row: DbOverview): AudioOverview {
  return {
    id: row.id,
    title: row.title,
    length: row.length,
    status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "pending",
    audioUrl: row.status === "ready" && row.storage_key ? signDownloadUrl(row.id, OVERVIEW_BASE) : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function getOverview(userId: string, id: string): Promise<DbOverview | null> {
  const r = await getPool().query<DbOverview>(
    `SELECT ${OVERVIEW_COLUMNS} FROM audio_overviews WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/* ---------------- background job ---------------- */

const activeOverviews = new Set<string>();

export function enqueueAudioOverview(id: string): void {
  setImmediate(() =>
    void runAudioOverview(id).catch((err) => console.warn("[studio] audio overview failed:", err)),
  );
}

async function failOverview(id: string, message: string): Promise<void> {
  await getPool().query("UPDATE audio_overviews SET status = 'failed', error = $2 WHERE id = $1", [id, message]);
}

/** Boot sweep: stuck overviews fail honestly. */
export async function sweepStaleAudioOverviews(): Promise<number> {
  const r = await getPool().query(
    `UPDATE audio_overviews SET status = 'failed', error = 'The server restarted before this overview was made. Please try again.'
     WHERE status IN ('pending', 'running')`,
  );
  return r.rowCount ?? 0;
}

interface DialogueLine {
  host: "A" | "B";
  text: string;
}

function parseDialogue(script: string): DialogueLine[] {
  const lines: DialogueLine[] = [];
  for (const raw of script.split("\n")) {
    const m = raw.match(/^\s*Host\s+([AB])\s*:\s*(.+?)\s*$/i);
    if (m) lines.push({ host: m[1].toUpperCase() as "A" | "B", text: m[2] });
  }
  if (lines.length === 0 && script.trim()) {
    // The model ignored the format: read it all as Host A.
    lines.push({ host: "A", text: script.trim().slice(0, 12000) });
  }
  return lines;
}

export async function runAudioOverview(id: string): Promise<void> {
  if (activeOverviews.has(id)) return;
  activeOverviews.add(id);
  const pool = getPool();
  try {
    const r = await pool.query<DbOverview>(`SELECT ${OVERVIEW_COLUMNS} FROM audio_overviews WHERE id = $1`, [id]);
    if (!r.rowCount || r.rows[0].status !== "pending") return;
    const overview = r.rows[0];
    const userId = overview.user_id;
    await pool.query("UPDATE audio_overviews SET status = 'running' WHERE id = $1", [id]);

    const fileIds = overview.source_file_ids;
    const files = await pool.query<{ id: string; original_name: string; extracted_text: string | null }>(
      "SELECT id, original_name, extracted_text FROM files WHERE user_id = $1 AND id = ANY($2) AND status = 'ready'",
      [userId, fileIds],
    );
    if ((files.rowCount ?? 0) !== fileIds.length) {
      await failOverview(id, "Some of those files aren't available anymore.");
      return;
    }

    const country = (await getUserCountry(userId)) ?? "";
    const chatRoute = routeChat({ country, taskType: "long-context" });
    if (!chatRoute) {
      await failOverview(id, "No chat provider is available for your region right now.");
      return;
    }
    if (!(await hasLiveConsent(userId, chatRoute.provider))) {
      await failOverview(id, "Please allow the provider in consent settings first.");
      return;
    }
    const chatProvider = makeChatProvider(chatRoute.provider as "anthropic" | "openai", chatRoute.model.id);

    // File excerpts (bounded).
    let budget = 30000;
    const excerpts: string[] = [];
    for (const f of files.rows) {
      const text = (f.extracted_text ?? "").slice(0, budget);
      if (text.trim()) excerpts.push(`[File: ${f.original_name}]\n${text}`);
      budget -= text.length;
      if (budget <= 0) break;
    }
    if (excerpts.length === 0) {
      await failOverview(id, "Those files don't have any readable text to summarize.");
      return;
    }

    const targetWords = TARGET_WORDS[overview.length];
    const scriptRes = await completeWithProvider(chatProvider, {
      system:
        "You are writing a two-host podcast dialogue. Every line starts with " +
        '"Host A: " or "Host B: ". No narration, no stage directions, no headings.',
      messages: [
        {
          role: "user",
          content:
            `Write a lively two-host dialogue (Host A and Host B) summarizing the files below, ` +
            `about ${targetWords} words total. The hosts discuss the key points conversationally.\n\n` +
            excerpts.join("\n\n"),
        },
      ],
    });
    const lines = parseDialogue(scriptRes.text).filter((l) => l.text.length > 0);
    if (lines.length === 0) {
      await failOverview(id, "The script came back empty. Please try again.");
      return;
    }

    const language = await getUserLanguage(userId);
    const buffers: Buffer[] = [];
    for (const line of lines) {
      try {
        const tts = await synthesizeSpeech({ text: line.text, language, userId, country, voice: line.host });
        buffers.push(tts.audio);
        await recordUsage({
          userId,
          feature: "voice",
          provider: tts.provider,
          units: line.text.length / 1000,
          costUsd: (line.text.length / 1e6) * (TTS_COST_PER_M[tts.provider] ?? 15),
          details: { kind: "tts", model: tts.model, source: `overview:${id}` },
        });
      } catch (err) {
        await failOverview(
          id,
          err instanceof VoiceGateError ? err.message : "The narration couldn't be recorded.",
        );
        return;
      }
    }
    const audio = await concatMp3(buffers);
    const key = `studio-overview-${uuidv4()}.mp3`;
    await getStorage().put(key, audio);
    await pool.query("UPDATE audio_overviews SET status = 'ready', storage_key = $2, error = NULL WHERE id = $1", [
      id,
      key,
    ]);
  } catch (err) {
    await failOverview(id, err instanceof Error ? err.message : "The overview couldn't be made.");
  } finally {
    activeOverviews.delete(id);
  }
}

/* ---------------- routes ---------------- */

export async function audioOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.post("/audio-overviews", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const fileIds = body.fileIds;
    if (
      !Array.isArray(fileIds) ||
      fileIds.length === 0 ||
      fileIds.length > 10 ||
      fileIds.some((f) => typeof f !== "string" || !UUID_RE.test(f))
    ) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Choose 1–10 of your files.");
    }
    if (!LENGTHS.includes(body.length as AudioOverviewLength)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Length must be short, medium or long.");
    }
    const unique = [...new Set(fileIds as string[])];
    const ready = await getPool().query<{ id: string; original_name: string }>(
      "SELECT id, original_name FROM files WHERE user_id = $1 AND id = ANY($2) AND status = 'ready'",
      [auth.userId, unique],
    );
    if ((ready.rowCount ?? 0) !== unique.length) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Some of those files aren't available.");
    }
    // Chat + consent gates: no search needed, but the script needs a provider.
    const country = (await getUserCountry(auth.userId)) ?? "";
    const chatRoute = routeChat({ country, taskType: "long-context" });
    if (!chatRoute) {
      return sendError(reply, 503, "NO_PROVIDER_AVAILABLE", "No chat provider is available for your region right now. Please try again later.");
    }
    if (!(await hasLiveConsent(auth.userId, chatRoute.provider))) {
      const name = CONSENT_COPY[chatRoute.provider as "anthropic" | "openai" | "google"]?.name ?? chatRoute.provider;
      return sendError(reply, 403, "CONSENT_REQUIRED", `To make audio overviews with ${name}, please allow Genze to share your chat messages with them first.`);
    }
    const firstName = ready.rows[0]?.original_name ?? "files";
    const title = `Audio overview — ${firstName.length > 50 ? `${firstName.slice(0, 47)}…` : firstName}`;
    const id = uuidv4();
    const r = await getPool().query<DbOverview>(
      `INSERT INTO audio_overviews (id, user_id, title, length, source_file_ids, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING ${OVERVIEW_COLUMNS}`,
      [id, auth.userId, title, body.length, JSON.stringify(unique)],
    );
    enqueueAudioOverview(id);
    return reply.code(201).send({ data: { overview: toAudioOverview(r.rows[0]) } });
  });

  app.get("/audio-overviews", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbOverview>(
      `SELECT ${OVERVIEW_COLUMNS} FROM audio_overviews WHERE user_id = $1 ORDER BY created_at DESC`,
      [auth.userId],
    );
    return reply.send({ data: { overviews: r.rows.map(toAudioOverview) } });
  });

  app.get("/audio-overviews/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const overview = await getOverview(auth.userId, (req.params as { id: string }).id);
    if (!overview) return sendError(reply, 404, "NOT_FOUND", "Audio overview not found.");
    return reply.send({ data: { overview: toAudioOverview(overview) } });
  });

  app.get("/audio-overviews/:id/download", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const query = req.query as { expires?: unknown; sig?: unknown };
    const check = verifyDownloadLink(id, query.expires, query.sig);
    if (!check.ok) {
      return sendError(reply, 403, check.reason === "expired" ? "LINK_EXPIRED" : "LINK_INVALID", "This download link is not valid.");
    }
    const r = await getPool().query<{ storage_key: string | null; status: string }>(
      "SELECT storage_key, status FROM audio_overviews WHERE id = $1",
      [id],
    );
    if (!r.rowCount || r.rows[0].status !== "ready" || !r.rows[0].storage_key) {
      return sendError(reply, 404, "NOT_FOUND", "Audio overview not found.");
    }
    let bytes: Buffer;
    try {
      bytes = await getStorage().get(r.rows[0].storage_key as string);
    } catch {
      return sendError(reply, 404, "NOT_FOUND", "Audio overview not found.");
    }
    reply.header("Content-Type", "audio/mpeg");
    reply.header("Content-Length", String(bytes.length));
    return reply.send(bytes);
  });

  app.delete("/audio-overviews/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const ok = await deleteAudioOverview(auth.userId, (req.params as { id: string }).id);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "Audio overview not found.");
    return reply.send({ data: { deleted: true } });
  });
}

/** Delete an overview row + its bytes (used by the route and the library). */
export async function deleteAudioOverview(userId: string, overviewId: string): Promise<boolean> {
  const r = await getPool().query<{ storage_key: string | null }>(
    "SELECT storage_key FROM audio_overviews WHERE id = $1 AND user_id = $2",
    [overviewId, userId],
  );
  if (!r.rowCount) return false;
  await getPool().query("DELETE FROM audio_overviews WHERE id = $1", [overviewId]);
  if (r.rows[0].storage_key) {
    try {
      await getStorage().delete(r.rows[0].storage_key as string);
    } catch { /* best effort */ }
  }
  return true;
}
