// File routes (prefix /api/v1/files, auth except signed downloads).
// Contract: CONTRACTS.md — Step 3. Uploads: PDF, DOCX, XLSX/CSV, images,
// audio. Text is extracted at upload; downloads go through short-lived
// signed links, never public URLs.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import type { GenzeFile } from "@genze/shared";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { extractFile, kindForMime, type FileKind } from "../files/extract.js";
import { getStorage } from "../storage/index.js";
import { signDownloadUrl, verifyDownloadLink } from "../storage/signed.js";
import { deleteFileCascade } from "../library/cascade.js";

const UPLOAD_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: "15 minutes" } };

export function maxFileMb(): number {
  const raw = Number(process.env.MAX_FILE_MB);
  if (Number.isInteger(raw) && raw > 0 && raw <= 1024) return raw;
  return 50;
}

const KIND_EXTENSION: Record<FileKind, string> = {
  pdf: ".pdf",
  docx: ".docx",
  xlsx: ".xlsx",
  csv: ".csv",
  image: ".bin",
  audio: ".bin",
};

const IMAGE_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

const AUDIO_EXTENSION: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
};

function extensionFor(kind: FileKind, mime: string): string {
  if (kind === "image") return IMAGE_EXTENSION[mime] ?? ".bin";
  if (kind === "audio") return AUDIO_EXTENSION[mime] ?? ".bin";
  return KIND_EXTENSION[kind];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DbFile {
  id: string;
  project_id: string | null;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  status: string;
  transcript_status: string | null;
  image_width: number | null;
  image_height: number | null;
  extracted_text: string | null;
  created_at: Date;
}

export function toGenzeFile(row: DbFile, includeText: boolean): GenzeFile {
  return {
    id: row.id,
    projectId: row.project_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status as GenzeFile["status"],
    transcriptStatus: row.transcript_status as GenzeFile["transcriptStatus"],
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    hasText: !!row.extracted_text && row.extracted_text.length > 0,
    createdAt: new Date(row.created_at).toISOString(),
    ...(includeText ? { extractedText: row.extracted_text } : {}),
  };
}

export const FILE_COLUMNS =
  "id, project_id, original_name, mime_type, size_bytes, status, transcript_status, image_width, image_height, extracted_text, created_at";

async function projectOwnedBy(userId: string, projectId: string): Promise<boolean> {
  const r = await getPool().query("SELECT 1 FROM projects WHERE id = $1 AND user_id = $2", [
    projectId,
    userId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Safety net at the plugin level; the per-request check below is what
  // tests and the UI rely on (env is read at request time).
  await app.register(multipart, {
    limits: { fileSize: maxFileMb() * 1024 * 1024, files: 1 },
  });

  // ---------- upload ----------

  app.post("/", { preHandler: authenticate, config: UPLOAD_RATE_LIMIT }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    let part: Awaited<ReturnType<FastifyRequest["file"]>>;
    try {
      part = await req.file();
    } catch {
      return sendError(reply, 413, "FILE_TOO_LARGE", "That file is too big to upload.");
    }
    if (!part) {
      return sendError(reply, 400, "VALIDATION_ERROR", "No file was attached.");
    }

    const mime = (part.mimetype || "").toLowerCase();
    const kind = kindForMime(mime);
    if (!kind) {
      return sendError(
        reply,
        400,
        "UNSUPPORTED_FILE_TYPE",
        "This kind of file isn't supported. You can upload PDF, Word, spreadsheet, image or audio files.",
      );
    }

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      return sendError(reply, 413, "FILE_TOO_LARGE", "That file is too big to upload.");
    }
    if (buffer.length > maxFileMb() * 1024 * 1024) {
      return sendError(
        reply,
        413,
        "FILE_TOO_LARGE",
        `That file is too big. The limit is ${maxFileMb()} MB per file.`,
      );
    }
    if (buffer.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "That file is empty.");
    }

    // Optional projectId multipart field.
    let projectId: string | null = null;
    const rawProjectId = (part.fields as Record<string, { value?: unknown } | undefined>)
      ?.projectId?.value;
    if (rawProjectId !== undefined) {
      if (typeof rawProjectId !== "string" || !UUID_RE.test(rawProjectId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown project.");
      }
      if (!(await projectOwnedBy(auth.userId, rawProjectId))) {
        return sendError(reply, 404, "NOT_FOUND", "Project not found.");
      }
      projectId = rawProjectId;
    }

    const originalName =
      typeof part.filename === "string" && part.filename.length > 0 ? part.filename.slice(0, 200) : "file";
    const id = uuidv4();
    const storageKey = `${uuidv4()}${extensionFor(kind, mime)}`;

    await getStorage().put(storageKey, buffer);
    const pool = getPool();
    await pool.query(
      `INSERT INTO files (id, user_id, project_id, original_name, mime_type, size_bytes, storage_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'extracting')`,
      [id, auth.userId, projectId, originalName, mime, buffer.length, storageKey],
    );

    // Extract inline; a failure marks the file failed but keeps it stored.
    try {
      const result = await extractFile(kind, mime, originalName, buffer);
      await pool.query(
        `UPDATE files
         SET status = 'ready', extracted_text = $2, transcript_status = $3,
             image_width = $4, image_height = $5,
             search = to_tsvector('english', coalesce($6,'') || ' ' || coalesce($2,''))
         WHERE id = $1`,
        [id, result.text, result.transcriptStatus, result.imageWidth, result.imageHeight, originalName],
      );
    } catch {
      await pool.query("UPDATE files SET status = 'failed' WHERE id = $1", [id]);
    }

    const r = await pool.query<DbFile>(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1`, [id]);
    return reply.code(201).send({ data: { file: toGenzeFile(r.rows[0], false) } });
  });

  // ---------- list ----------

  app.get("/", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const q = (req.query as { projectId?: unknown }).projectId;
    let rows;
    if (typeof q === "string" && q.length > 0) {
      if (!UUID_RE.test(q)) return sendError(reply, 400, "VALIDATION_ERROR", "Unknown project.");
      rows = (
        await getPool().query<DbFile>(
          `SELECT ${FILE_COLUMNS} FROM files WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
          [auth.userId, q],
        )
      ).rows;
    } else {
      rows = (
        await getPool().query<DbFile>(
          `SELECT ${FILE_COLUMNS} FROM files WHERE user_id = $1 ORDER BY created_at DESC`,
          [auth.userId],
        )
      ).rows;
    }
    return reply.send({ data: { files: rows.map((r) => toGenzeFile(r, false)) } });
  });

  // ---------- one file (with extracted text) ----------

  app.get("/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbFile>(
      `SELECT ${FILE_COLUMNS} FROM files WHERE id = $1 AND user_id = $2`,
      [(req.params as { id: string }).id, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "File not found.");
    return reply.send({ data: { file: toGenzeFile(r.rows[0], true) } });
  });

  // ---------- signed download link ----------

  app.get("/:id/link", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const fileId = (req.params as { id: string }).id;
    const r = await getPool().query<{ id: string }>(
      "SELECT id FROM files WHERE id = $1 AND user_id = $2",
      [fileId, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "File not found.");
    return reply.send({ data: { url: signDownloadUrl(fileId) } });
  });

  // ---------- download via signed link (no auth header — the token is the auth) ----------

  app.get("/:id/download", async (req, reply: FastifyReply) => {
    const fileId = (req.params as { id: string }).id;
    const query = req.query as { expires?: unknown; sig?: unknown };
    const check = verifyDownloadLink(fileId, query.expires, query.sig);
    if (!check.ok) {
      return sendError(
        reply,
        403,
        check.reason === "expired" ? "LINK_EXPIRED" : "LINK_INVALID",
        check.reason === "expired"
          ? "This download link has expired. Please make a new one."
          : "This download link is not valid.",
      );
    }
    const r = await getPool().query<DbFile & { storage_key: string }>(
      `SELECT ${FILE_COLUMNS}, storage_key FROM files WHERE id = $1`,
      [fileId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "File not found.");
    const row = r.rows[0];
    let bytes: Buffer;
    try {
      bytes = await getStorage().get(row.storage_key);
    } catch {
      return sendError(reply, 404, "NOT_FOUND", "File not found.");
    }
    const safeName = row.original_name.replace(/["\r\n]/g, "_");
    reply.header("Content-Type", row.mime_type);
    reply.header("Content-Length", String(bytes.length));
    reply.header("Content-Disposition", `attachment; filename="${safeName}"`);
    return reply.send(bytes);
  });

  // ---------- delete ----------

  app.delete("/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const ok = await deleteFileCascade(auth.userId, (req.params as { id: string }).id);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "File not found.");
    return reply.send({ data: { deleted: true } });
  });
}
