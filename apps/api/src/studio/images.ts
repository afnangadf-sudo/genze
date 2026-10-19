// Step 9 — Studio images: generate, list, fetch, edit (variation).
// Generation runs in-process in the background (research-runner pattern,
// decision #42): POST returns 201 with status "pending"; the row flips to
// "ready" (bytes in the storage driver) or "failed" with a plain error.
// Metering: one usage_events row per finished image (feature='image',
// cost-only like compaction — no daily cap in v1).

import type { FastifyInstance, FastifyReply } from "fastify";
import type { StudioImage } from "@genze/shared";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getUserCountry, hasLiveConsent } from "../users.js";
import { getStorage } from "../storage/index.js";
import { signDownloadUrl, verifyDownloadLink } from "../storage/signed.js";
import { recordUsage } from "../usage.js";
import { CONSENT_COPY } from "../providers/consentCopy.js";
import {
  IMAGE_CATALOG,
  imageCostUsd,
  isDeadModelId,
  pickImageProvider,
  type ImageModelInfo,
} from "./catalog.js";
import { generateImageBytes, StudioProviderError, type ImageAspect } from "./providers.js";

const IMAGE_BASE = "/api/v1/studio/images";
const ASPECTS: ImageAspect[] = ["square", "wide", "tall"];
/** Aliases from the older "16:9"-style values; the wire contract is square/wide/tall. */
const ASPECT_ALIASES: Record<string, ImageAspect> = {
  "1:1": "square",
  "16:9": "wide",
  "9:16": "tall",
};

function resolveAspect(raw: unknown): ImageAspect | null {
  if (raw === undefined) return "square";
  if (typeof raw !== "string") return null;
  if ((ASPECTS as string[]).includes(raw)) return raw as ImageAspect;
  return ASPECT_ALIASES[raw] ?? null;
}

interface DbImage {
  id: string;
  user_id: string;
  prompt: string;
  provider: string;
  model: string;
  aspect_ratio: string;
  status: string;
  edit_source_key: string | null;
  created_at: Date;
}

function toStudioImage(row: DbImage): StudioImage {
  const ready = row.status === "ready";
  return {
    id: row.id,
    prompt: row.prompt,
    aspectRatio: (ASPECTS as string[]).includes(row.aspect_ratio)
      ? (row.aspect_ratio as ImageAspect)
      : "square",
    status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "pending",
    imageUrl: ready ? signDownloadUrl(row.id, IMAGE_BASE) : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function getImage(userId: string, id: string): Promise<DbImage | null> {
  const r = await getPool().query<DbImage>(
    "SELECT id, user_id, prompt, provider, model, aspect_ratio, status, edit_source_key, created_at FROM studio_images WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/* ---------- background generation ---------- */

const activeImages = new Set<string>();

/** Swappable enqueue seam (in-process today, per decision #42). */
export function enqueueImageJob(imageId: string): void {
  setImmediate(() => void runImageJob(imageId).catch((err) => console.warn("[studio] image job failed:", err)));
}

async function failImage(id: string, message: string): Promise<void> {
  await getPool().query("UPDATE studio_images SET status = 'failed', error = $2 WHERE id = $1", [
    id,
    message,
  ]);
}

async function runImageJob(imageId: string): Promise<void> {
  if (activeImages.has(imageId)) return;
  activeImages.add(imageId);
  try {
    const r = await getPool().query<DbImage & { storage_key: string | null }>(
      "SELECT id, user_id, prompt, provider, model, aspect_ratio, status, edit_source_key, storage_key FROM studio_images WHERE id = $1",
      [imageId],
    );
    if (!r.rowCount || r.rows[0].status !== "pending") return;
    const row = r.rows[0];
    const model = IMAGE_CATALOG.find((m) => m.id === row.model) ?? null;
    if (!model) {
      await failImage(imageId, "This image model is no longer available.");
      return;
    }
    let editOf: Buffer | undefined;
    if (row.edit_source_key) {
      try {
        editOf = await getStorage().get(row.edit_source_key);
      } catch {
        editOf = undefined;
      }
    }
    const bytes = await generateImageBytes(
      model as ImageModelInfo,
      row.prompt,
      (ASPECTS as string[]).includes(row.aspect_ratio) ? (row.aspect_ratio as ImageAspect) : "square",
      editOf,
    );
    const key = `studio-image-${uuidv4()}.png`;
    await getStorage().put(key, bytes);
    await getPool().query(
      "UPDATE studio_images SET status = 'ready', storage_key = $2, error = NULL WHERE id = $1",
      [imageId, key],
    );
    await recordUsage({
      userId: row.user_id,
      feature: "image",
      provider: row.provider,
      units: 1,
      costUsd: imageCostUsd(model as ImageModelInfo),
      details: { model: row.model },
    });
  } catch (err) {
    const message =
      err instanceof StudioProviderError
        ? err.message
        : "The image couldn't be created. Please try again.";
    await failImage(imageId, message);
  } finally {
    activeImages.delete(imageId);
  }
}

/** Boot sweep: a pending image at boot belonged to a dead process. */
export async function sweepStaleStudioImages(): Promise<number> {
  const r = await getPool().query(
    `UPDATE studio_images SET status = 'failed', error = 'The server restarted before this image was made. Please try again.'
     WHERE status = 'pending'`,
  );
  return r.rowCount ?? 0;
}

/* ---------- routes ---------- */

export async function studioImageRoutes(app: FastifyInstance): Promise<void> {
  // Create + generate in background.
  app.post("/images", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length < 3 || prompt.length > 2000) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Describe the image in 3–2000 characters.");
    }
    const aspect = resolveAspect(body.aspectRatio);
    if (!aspect) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Aspect ratio must be square, wide or tall.");
    }
    const preferred = body.provider === undefined ? undefined : body.provider;
    if (preferred !== undefined) {
      if (typeof preferred !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown image provider.");
      }
      if (isDeadModelId(preferred)) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "That image model is not available. Please pick another provider.",
        );
      }
      if (!IMAGE_CATALOG.some((m) => m.provider === preferred)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown image provider.");
      }
    }

    const country = (await getUserCountry(auth.userId)) ?? "";
    const route = pickImageProvider(country, preferred);
    if (!route) {
      return sendError(
        reply,
        503,
        "NO_PROVIDER_AVAILABLE",
        "Image generation isn't available for your region right now. Please try again later.",
      );
    }
    if (!(await hasLiveConsent(auth.userId, route.provider))) {
      const name = CONSENT_COPY[route.provider]?.name ?? route.provider;
      return sendError(
        reply,
        403,
        "CONSENT_REQUIRED",
        `To create pictures with ${name}, please allow Genze to share your image descriptions with them first.`,
      );
    }

    const id = uuidv4();
    const r = await getPool().query<DbImage>(
      `INSERT INTO studio_images (id, user_id, prompt, provider, model, aspect_ratio, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id, user_id, prompt, provider, model, aspect_ratio, status, edit_source_key, created_at`,
      [id, auth.userId, prompt, route.provider, route.model.id, aspect],
    );
    enqueueImageJob(id);
    return reply.code(201).send({ data: { image: toStudioImage(r.rows[0]) } });
  });

  app.get("/images", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbImage>(
      "SELECT id, user_id, prompt, provider, model, aspect_ratio, status, edit_source_key, created_at FROM studio_images WHERE user_id = $1 ORDER BY created_at DESC",
      [auth.userId],
    );
    return reply.send({ data: { images: r.rows.map(toStudioImage) } });
  });

  app.get("/images/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const image = await getImage(auth.userId, (req.params as { id: string }).id);
    if (!image) return sendError(reply, 404, "NOT_FOUND", "Image not found.");
    return reply.send({ data: { image: toStudioImage(image) } });
  });

  // Signed download (no auth header — the HMAC token is the authorization).
  app.get("/images/:id/download", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const query = req.query as { expires?: unknown; sig?: unknown };
    const check = verifyDownloadLink(id, query.expires, query.sig);
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
    const r = await getPool().query<{ storage_key: string | null; status: string }>(
      "SELECT storage_key, status FROM studio_images WHERE id = $1",
      [id],
    );
    if (!r.rowCount || r.rows[0].status !== "ready" || !r.rows[0].storage_key) {
      return sendError(reply, 404, "NOT_FOUND", "Image not found.");
    }
    let bytes: Buffer;
    try {
      bytes = await getStorage().get(r.rows[0].storage_key as string);
    } catch {
      return sendError(reply, 404, "NOT_FOUND", "Image not found.");
    }
    reply.header("Content-Type", "image/png");
    reply.header("Content-Length", String(bytes.length));
    reply.header("Content-Disposition", `attachment; filename="genze-image-${id}.png"`);
    return reply.send(bytes);
  });

  // Edit: image + prompt variation -> a NEW image row (the source is kept).
  app.post("/images/:id/edit", { preHandler: authenticate }, async (req, reply: FastifyReply) => {
    const auth = req.auth as { userId: string };
    const source = await getImage(auth.userId, (req.params as { id: string }).id);
    if (!source) return sendError(reply, 404, "NOT_FOUND", "Image not found.");
    if (source.status !== "ready") {
      return sendError(reply, 400, "VALIDATION_ERROR", "That image isn't ready to edit yet.");
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length < 3 || prompt.length > 2000) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Describe the change in 3–2000 characters.");
    }
    const country = (await getUserCountry(auth.userId)) ?? "";
    const route = pickImageProvider(country, source.provider);
    if (!route) {
      return sendError(
        reply,
        503,
        "NO_PROVIDER_AVAILABLE",
        "Image generation isn't available for your region right now. Please try again later.",
      );
    }
    if (!(await hasLiveConsent(auth.userId, route.provider))) {
      const name = CONSENT_COPY[route.provider]?.name ?? route.provider;
      return sendError(
        reply,
        403,
        "CONSENT_REQUIRED",
        `To edit pictures with ${name}, please allow Genze to share your image descriptions with them first.`,
      );
    }
    // The source bytes are loaded by the background job; stash the source
    // storage key on the new row and mark the prompt so the job edits.
    const srcKey = (
      await getPool().query<{ storage_key: string | null }>(
        "SELECT storage_key FROM studio_images WHERE id = $1",
        [source.id],
      )
    ).rows[0]?.storage_key;
    if (!srcKey) return sendError(reply, 404, "NOT_FOUND", "Image not found.");
    const id = uuidv4();
    const r = await getPool().query<DbImage>(
      `INSERT INTO studio_images (id, user_id, prompt, provider, model, aspect_ratio, status, edit_source_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id, user_id, prompt, provider, model, aspect_ratio, status, edit_source_key, created_at`,
      [id, auth.userId, prompt, route.provider, route.model.id, source.aspect_ratio, srcKey],
    );
    enqueueImageJob(id);
    return reply.code(201).send({ data: { image: toStudioImage(r.rows[0]) } });
  });

  app.delete("/images/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const ok = await deleteStudioImage(auth.userId, (req.params as { id: string }).id);
    if (!ok) return sendError(reply, 404, "NOT_FOUND", "Image not found.");
    return reply.send({ data: { deleted: true } });
  });
}

/** Delete an image row + its bytes (used by the route and the library). */
export async function deleteStudioImage(userId: string, imageId: string): Promise<boolean> {
  const r = await getPool().query<{ storage_key: string | null }>(
    "SELECT storage_key FROM studio_images WHERE id = $1 AND user_id = $2",
    [imageId, userId],
  );
  if (!r.rowCount) return false;
  await getPool().query("DELETE FROM studio_images WHERE id = $1", [imageId]);
  const key = r.rows[0].storage_key;
  if (key) {
    try {
      await getStorage().delete(key);
    } catch {
      // Row is gone; a stray object is harmless.
    }
  }
  return true;
}
