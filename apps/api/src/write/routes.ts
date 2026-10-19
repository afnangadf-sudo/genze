// Write routes (prefix /api/v1/write, all require auth).
// Contract: CONTRACTS.md — Step 4. Drafts (template-guided generation),
// revise (returns text; the client persists — decision #48), fact-check
// background jobs, writing styles, and real file exports via src/export/.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ClaimVerdict,
  FactCheck,
  ResearchJobStatus,
  WriteDraft,
  WriteTemplate,
  WritingStyle,
} from "@genze/shared";
import { isValidLanguageCode, languageDisplayName } from "@genze/shared";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getUserCountry, hasLiveConsent } from "../users.js";
import { routeChat } from "../providers/models.js";
import { CONSENT_COPY } from "../providers/consentCopy.js";
import { completeWithProvider } from "../providers/complete.js";
import { makeChatProvider } from "../providers/instances.js";
import { chatAugmentations } from "../chat/lockdown.js";
import { checkLimit, sendLimitExceeded } from "../limits.js";
import { recordUsage } from "../usage.js";
import { pickSearchProvider } from "../search/index.js";
import {
  draftToPptxBuffer,
  draftToXlsxBuffer,
  reportToDocxBuffer,
  reportToPdfBuffer,
} from "../export/index.js";
import { enqueueFactCheck, newFactCheckId, type DbFactCheck } from "./factcheck.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = Record<string, unknown>;

function bodyOf(req: FastifyRequest): Body {
  return (req.body as Body | undefined) ?? {};
}

function validId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

const TEMPLATES: WriteTemplate[] = [
  "article",
  "essay",
  "summary",
  "youtube-script",
  "podcast-outline",
  "email",
];

/** Server-side generation prompt per template (the client only sends a brief). */
const TEMPLATE_PROMPTS: Record<WriteTemplate, string> = {
  article:
    "Write a well-structured article based on the brief below. Use a clear headline, " +
    "short paragraphs, and subheadings where they help. Write in the same language as the brief.",
  essay:
    "Write a thoughtful essay based on the brief below, with a clear thesis, developed " +
    "arguments, and a strong conclusion. Write in the same language as the brief.",
  summary:
    "Write a concise summary of the brief below. Keep every key point and drop the filler. " +
    "Write in the same language as the brief.",
  "youtube-script":
    "Write an engaging YouTube video script based on the brief below: a strong hook in the " +
    "first 15 seconds, clear sections with spoken transitions, and a call to action at the end. " +
    "Write it to be read aloud, in the same language as the brief.",
  "podcast-outline":
    "Write a podcast episode outline based on the brief below: episode title, cold open, " +
    "segment-by-segment talking points with rough time estimates, and an outro. " +
    "Write in the same language as the brief.",
  email:
    "Write a clear, polite email based on the brief below, with a subject line and a proper " +
    "sign-off. Write in the same language as the brief.",
};

/** Translate prompt for a target language: meaning, tone and formatting preserved. */
function translatePrompt(code: string): string {
  const primary = code.toLowerCase().split(/[-_]/)[0];
  const script = primary === "ur" ? " (using the Urdu script)" : "";
  return (
    `Translate the following text into ${languageDisplayName(code)}${script}, ` +
    "preserving the meaning, tone, and formatting."
  );
}

const BASE_REVISE_PROMPTS: Record<string, string> = {
  shorter: "Rewrite the following text to be shorter and more concise, keeping all key points.",
  simpler: "Rewrite the following text in simpler, plainer language that anyone can follow.",
  formal: "Rewrite the following text in a more formal, professional tone.",
};

/**
 * Resolve any accepted revise action to its prompt, or null when unknown.
 * Accepts the base actions plus `translate-<code>` for ANY BCP-47 code
 * (user correction 2026-10-18: no language enum restriction).
 */
function revisePrompt(action: string): string | null {
  const base = BASE_REVISE_PROMPTS[action];
  if (base) return base;
  if (action.startsWith("translate-")) {
    const code = action.slice("translate-".length);
    if (isValidLanguageCode(code)) return translatePrompt(code);
  }
  return null;
}

interface DbDraft {
  id: string;
  project_id: string | null;
  title: string;
  template: string;
  content: string;
  style_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DbStyle {
  id: string;
  name: string;
  description: string;
  created_at: Date;
}

function toDraft(row: DbDraft): WriteDraft {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    template: row.template as WriteTemplate,
    content: row.content,
    styleId: row.style_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toStyle(row: DbStyle): WritingStyle {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toFactCheck(row: DbFactCheck): FactCheck {
  return {
    id: row.id,
    draftId: row.draft_id,
    threadId: row.thread_id,
    status: row.status as ResearchJobStatus,
    claims: (row.claims ?? []).map((c) => ({
      claim: c.claim,
      verdict: c.verdict as ClaimVerdict,
      sources: c.sources ?? [],
    })),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function getOwnedDraft(userId: string, draftId: string): Promise<DbDraft | null> {
  const r = await getPool().query<DbDraft>(
    "SELECT * FROM write_drafts WHERE id = $1 AND user_id = $2",
    [draftId, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

async function getOwnedStyle(userId: string, styleId: string): Promise<DbStyle | null> {
  const r = await getPool().query<DbStyle>(
    "SELECT * FROM writing_styles WHERE id = $1 AND user_id = $2",
    [styleId, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/** Shared route+consent gates for generation-style calls. Returns the routed provider pieces or sends the error. */
async function gateProvider(
  userId: string,
  reply: Parameters<typeof sendError>[0],
): Promise<{ provider: ReturnType<typeof makeChatProvider>; providerId: string } | null> {
  const country = await getUserCountry(userId);
  if (!country) {
    sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    return null;
  }
  const route = routeChat({ country, taskType: "long-context" });
  if (!route) {
    sendError(
      reply,
      503,
      "NO_PROVIDER_AVAILABLE",
      "No writing provider is available for your region right now. Please try again later.",
    );
    return null;
  }
  if (!(await hasLiveConsent(userId, route.provider))) {
    const name = CONSENT_COPY[route.provider as keyof typeof CONSENT_COPY]?.name ?? route.provider;
    sendError(
      reply,
      403,
      "CONSENT_REQUIRED",
      `To write with ${name}, please allow Genze to share your writing with them first.`,
    );
    return null;
  }
  return {
    provider: makeChatProvider(route.provider as "anthropic" | "openai", route.model.id),
    providerId: route.provider,
  };
}

export async function writeRoutes(app: FastifyInstance): Promise<void> {
  // ---------- drafts ----------

  app.post("/drafts", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);

    const template = body.template;
    if (typeof template !== "string" || !(TEMPLATES as string[]).includes(template)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Unknown template.");
    }
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";
    if (brief.length < 3 || brief.length > 2000) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Brief must be 3–2000 characters.");
    }

    let projectId: string | null = null;
    let projectInstructions = "";
    let projectDefaultStyleId: string | null = null;
    if (body.projectId !== undefined && body.projectId !== null) {
      if (!validId(body.projectId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "That project reference is not valid.");
      }
      const pr = await getPool().query<{ id: string; instructions: string; default_style_id: string | null }>(
        "SELECT id, instructions, default_style_id FROM projects WHERE id = $1 AND user_id = $2",
        [body.projectId, auth.userId],
      );
      if (!pr.rowCount) return sendError(reply, 404, "NOT_FOUND", "Project not found.");
      projectId = pr.rows[0].id;
      projectInstructions = pr.rows[0].instructions ?? "";
      projectDefaultStyleId = pr.rows[0].default_style_id;
    }

    // Explicit style wins; otherwise the project's default style.
    let styleId: string | null = null;
    let styleDescription = "";
    const explicitStyle = body.styleId !== undefined && body.styleId !== null ? body.styleId : null;
    const resolvedStyleId: unknown = explicitStyle ?? projectDefaultStyleId;
    if (resolvedStyleId) {
      if (!validId(resolvedStyleId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "That style reference is not valid.");
      }
      const st = await getOwnedStyle(auth.userId, resolvedStyleId);
      if (!st) return sendError(reply, 404, "NOT_FOUND", "Writing style not found.");
      styleId = st.id;
      styleDescription = st.description;
    }

    // Draft generation is a chat-model call: it draws from the chat quota.
    // Checked after validation, before the provider gates (routing/consent).
    const limit = await checkLimit(auth.userId, "chat", 1);
    if (!limit.ok) return sendLimitExceeded(reply, "chat");

    const gated = await gateProvider(auth.userId, reply);
    if (!gated) return;

    const systemParts: string[] = [];
    if (styleDescription.trim()) {
      systemParts.push(`Write in this style:\n${styleDescription.trim()}`);
    }
    if (projectInstructions.trim()) {
      systemParts.push(`Project instructions:\n${projectInstructions.trim()}`);
    }
    systemParts.push(TEMPLATE_PROMPTS[template as WriteTemplate]);
    const system = systemParts.join("\n\n");

    let content: string;
    try {
      const r = await completeWithProvider(gated.provider, {
        system,
        messages: [{ role: "user", content: `Brief:\n\n${brief}` }],
      });
      content = r.text.trim();
    } catch {
      return sendError(reply, 502, "PROVIDER_ERROR", "The writing provider failed. Please try again.");
    }
    if (!content) {
      return sendError(reply, 502, "PROVIDER_ERROR", "The writing provider returned nothing. Please try again.");
    }

    const id = uuidv4();
    const title = brief.slice(0, 60);
    await getPool().query(
      `INSERT INTO write_drafts (id, user_id, project_id, title, template, content, style_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, auth.userId, projectId, title, template, content, styleId],
    );
    const created = await getOwnedDraft(auth.userId, id);
    return reply.code(201).send({ data: { draft: toDraft(created as DbDraft) } });
  });

  app.get("/drafts", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbDraft>(
      "SELECT * FROM write_drafts WHERE user_id = $1 ORDER BY updated_at DESC",
      [auth.userId],
    );
    return reply.send({ data: { drafts: r.rows.map(toDraft) } });
  });

  app.get("/drafts/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const draft = await getOwnedDraft(auth.userId, id);
    if (!draft) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    return reply.send({ data: { draft: toDraft(draft) } });
  });

  app.patch("/drafts/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const body = bodyOf(req);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || body.title.trim().length < 1 || body.title.trim().length > 120) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Title must be 1–120 characters.");
      }
      updates.push(`title = $${values.length + 1}`);
      values.push((body.title as string).trim());
    }
    if (body.content !== undefined) {
      if (typeof body.content !== "string" || body.content.length > 200_000) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Content is too long.");
      }
      updates.push(`content = $${values.length + 1}`);
      values.push(body.content);
    }
    if (updates.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
    }
    values.push(id, auth.userId);
    const r = await getPool().query(
      `UPDATE write_drafts SET ${updates.join(", ")}, updated_at = now()
       WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING id`,
      values,
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const updated = await getOwnedDraft(auth.userId, id);
    return reply.send({ data: { draft: toDraft(updated as DbDraft) } });
  });

  app.delete("/drafts/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const r = await getPool().query("DELETE FROM write_drafts WHERE id = $1 AND user_id = $2", [
      id,
      auth.userId,
    ]);
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    return reply.send({ data: { deleted: true } });
  });

  // ---------- revise (returns text; the client persists — decision #48) ----------

  app.post("/drafts/:id/revise", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const draft = await getOwnedDraft(auth.userId, id);
    if (!draft) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const body = bodyOf(req);
    const action = body.action;
    const prompt = typeof action === "string" ? revisePrompt(action) : null;
    if (!prompt) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Unknown revise action.");
    }
    const gated = await gateProvider(auth.userId, reply);
    if (!gated) return;
    try {
      const r = await completeWithProvider(gated.provider, {
        system: "You are an editor. Return only the revised text, nothing else.",
        messages: [
          {
            role: "user",
            content: `${prompt}\n\nText:\n\n${draft.content.slice(0, 50_000)}`,
          },
        ],
      });
      const revised = r.text.trim();
      if (!revised) {
        return sendError(reply, 502, "PROVIDER_ERROR", "The writing provider returned nothing. Please try again.");
      }
      return reply.send({ data: { revised } });
    } catch {
      return sendError(reply, 502, "PROVIDER_ERROR", "The writing provider failed. Please try again.");
    }
  });

  // ---------- fact-check ----------

  app.post("/drafts/:id/fact-check", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const draft = await getOwnedDraft(auth.userId, id);
    if (!draft) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const body = bodyOf(req);

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
      if (!chatAugmentations({ lockdown: t.rows[0].lockdown }).web) {
        return sendError(reply, 403, "LOCKDOWN", "Fact-check can't run while this chat is in lockdown.");
      }
    }

    if (!pickSearchProvider()) {
      return sendError(
        reply,
        503,
        "SEARCH_NOT_CONFIGURED",
        "Fact-check needs web search, which isn't set up yet. Please try again later.",
      );
    }

    const gated = await gateProvider(auth.userId, reply);
    if (!gated) return;

    const checkId = newFactCheckId();
    await getPool().query(
      `INSERT INTO fact_checks (id, user_id, draft_id, thread_id, status)
       VALUES ($1, $2, $3, $4, 'planned')`,
      [checkId, auth.userId, draft.id, threadId],
    );
    enqueueFactCheck(checkId);
    const r = await getPool().query<DbFactCheck>("SELECT * FROM fact_checks WHERE id = $1", [checkId]);
    return reply.code(201).send({ data: { check: toFactCheck(r.rows[0]) } });
  });

  app.get("/fact-checks/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Fact-check not found.");
    const r = await getPool().query<DbFactCheck>(
      "SELECT * FROM fact_checks WHERE id = $1 AND user_id = $2",
      [id, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Fact-check not found.");
    return reply.send({ data: { check: toFactCheck(r.rows[0]) } });
  });

  // ---------- export ----------

  app.get("/drafts/:id/export", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const draft = await getOwnedDraft(auth.userId, id);
    if (!draft) return sendError(reply, 404, "NOT_FOUND", "Draft not found.");
    const format = (req.query as { format?: unknown }).format;
    if (format !== "docx" && format !== "pdf" && format !== "xlsx" && format !== "pptx") {
      return sendError(reply, 400, "VALIDATION_ERROR", "Format must be docx, pdf, xlsx, or pptx.");
    }
    const ext = format;
    const filename = `draft-${draft.id}.${ext}`;
    let buffer: Buffer;
    let contentType: string;
    switch (format) {
      case "docx":
        buffer = await reportToDocxBuffer(draft.title, draft.content, []);
        contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        break;
      case "pdf":
        buffer = await reportToPdfBuffer(draft.title, draft.content, []);
        contentType = "application/pdf";
        break;
      case "xlsx":
        buffer = await draftToXlsxBuffer(draft.title, draft.content);
        contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        break;
      case "pptx":
        buffer = await draftToPptxBuffer(draft.title, draft.content);
        contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        break;
    }
    return reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buffer);
  });

  // ---------- styles ----------

  app.post("/styles", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (name.length < 1 || name.length > 60) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Name must be 1–60 characters.");
    }
    if (description.length < 1 || description.length > 2000) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Description must be 1–2000 characters.");
    }
    const id = uuidv4();
    await getPool().query(
      "INSERT INTO writing_styles (id, user_id, name, description) VALUES ($1, $2, $3, $4)",
      [id, auth.userId, name, description],
    );
    const created = await getOwnedStyle(auth.userId, id);
    return reply.code(201).send({ data: { style: toStyle(created as DbStyle) } });
  });

  app.get("/styles", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbStyle>(
      "SELECT * FROM writing_styles WHERE user_id = $1 ORDER BY created_at DESC",
      [auth.userId],
    );
    return reply.send({ data: { styles: r.rows.map(toStyle) } });
  });

  app.patch("/styles/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Writing style not found.");
    const body = bodyOf(req);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 1 || name.length > 60) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Name must be 1–60 characters.");
      }
      updates.push(`name = $${values.length + 1}`);
      values.push(name);
    }
    if (body.description !== undefined) {
      const description = typeof body.description === "string" ? body.description.trim() : "";
      if (description.length < 1 || description.length > 2000) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Description must be 1–2000 characters.");
      }
      updates.push(`description = $${values.length + 1}`);
      values.push(description);
    }
    if (updates.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
    }
    values.push(id, auth.userId);
    const r = await getPool().query(
      `UPDATE writing_styles SET ${updates.join(", ")} WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING id`,
      values,
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Writing style not found.");
    const updated = await getOwnedStyle(auth.userId, id);
    return reply.send({ data: { style: toStyle(updated as DbStyle) } });
  });

  app.delete("/styles/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const id = (req.params as { id: string }).id;
    if (!validId(id)) return sendError(reply, 404, "NOT_FOUND", "Writing style not found.");
    const r = await getPool().query("DELETE FROM writing_styles WHERE id = $1 AND user_id = $2", [
      id,
      auth.userId,
    ]);
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Writing style not found.");
    return reply.send({ data: { deleted: true } });
  });
}
