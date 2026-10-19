// Chat routes (prefix /api/v1/chat, all require auth). Contract: CONTRACTS.md
// Step 2 — streaming replies, smart router, consent gates, demo mode, metering.
// Quick wins — temporary chat, lockdown mode, thread compaction.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ChatMessage,
  ChatRole,
  ChatStreamEvent,
  ChatThread,
  ConsentProviderStatus,
  ProviderId,
  TaskType,
} from "@genze/shared";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getProvider } from "../providers/registry.js";
import { REGION_MAP } from "../providers/regions.js";
import {
  CHAT_IMPLEMENTED,
  chatReplyCost,
  findChatModel,
  routeChat,
  type ModelInfo,
} from "../providers/models.js";
import type { ChatProvider, ChatMessageInput } from "../providers/chatProvider.js";
import { makeChatProvider } from "../providers/instances.js";
import { makeDemoProvider } from "../providers/demo.js";
import { FreeUnavailable, isFreeEnabled, makeFreeProvider } from "../providers/free.js";
import { CONSENT_COPY } from "../providers/consentCopy.js";
import { getUserCountry, getUserLanguage, hasLiveConsent } from "../users.js";
import { buildFileContext } from "../files/context.js";
import { chatAugmentations } from "../chat/lockdown.js";
import { applyLanguageInstruction } from "../chat/language.js";
import { assembleSystemPrefix } from "../chat/systemPrompt.js";
import { tutorBlock } from "../chat/tutor.js";
import { compactionSystemPrefix, maybeCompactThread } from "../chat/compaction.js";
import { buildSkillsBlock } from "../skills/service.js";
import { buildGemBlock, getVisibleGem, type DbGem } from "../gems/service.js";
import {
  parseConfirmedActions,
  parseUseConnectors,
  runConnectorToolLoop,
  type ConnectorStreamEvent,
} from "../chat/connectorTools.js";
import { checkLimit, sendLimitExceeded } from "../limits.js";
import { recordProviderFailure, recordProviderSuccess } from "../providers/circuit.js";

const DEFAULT_TITLE = "New chat";
const HISTORY_MESSAGE_LIMIT = 40;
const HISTORY_CHAR_LIMIT = 120_000;
const HEARTBEAT_MS = 15_000;
const TASK_TYPES: TaskType[] = ["chat", "reasoning", "long-context"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENTS = 10;
const TEMP_MESSAGE_LIMIT = 40;
const CONSENT_PROVIDERS = ["anthropic", "openai", "google", "free"] as const;
type ConsentProviderId = (typeof CONSENT_PROVIDERS)[number];

const SYSTEM_PROMPT =
  "You are Genze, a warm and genuinely helpful personal assistant. " +
  "Talk like a thoughtful friend, not a robot: plain everyday words, no jargon, " +
  "no stiff formal phrases, and never performative filler like 'Great question!' or 'I'd be happy to help!'. " +
  "Always reply in the same language and script the user writes in — if they write Urdu, " +
  "answer in natural Urdu the way a person texts, warm and a little playful when it fits. " +
  "Keep simple answers short. Give more detail only when the question truly needs it. " +
  "You may have opinions and a little personality; never be preachy or lecture. " +
  "If you don't know something, say so honestly instead of guessing. " +
  "When the user gives you a task, do the work yourself instead of explaining how they could do it. " +
  "Safety: if someone asks for something genuinely harmful — weapons, violence, " +
  "hurting people, sexual content involving children, or breaking the law — " +
  "refuse briefly and kindly in their own language (like 'I can't help with that'), " +
  "without a lecture. You may offer a safe alternative when one fits.";

const THREAD_COLUMNS =
  "id, title, project_id, gem_id, tutor_mode, lockdown, compaction_summary, compacted_through_message_id, created_at, updated_at";

type Body = Record<string, unknown>;

function bodyOf(req: FastifyRequest): Body {
  return (req.body as Body | undefined) ?? {};
}

interface DbThread {
  id: string;
  title: string;
  project_id: string | null;
  gem_id: string | null;
  tutor_mode: boolean;
  lockdown: boolean;
  compaction_summary: string | null;
  compacted_through_message_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DbMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  demo: boolean;
  created_at: Date;
}

function toChatThread(row: DbThread): ChatThread {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    gemId: row.gem_id,
    tutorMode: row.tutor_mode,
    lockdown: row.lockdown,
    compacted: row.compaction_summary !== null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toChatMessage(row: DbMessage): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as ChatRole,
    content: row.content,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    demo: row.demo,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function getThread(userId: string, threadId: string): Promise<DbThread | null> {
  const r = await getPool().query<DbThread>(
    `SELECT ${THREAD_COLUMNS} FROM chat_threads WHERE id = $1 AND user_id = $2`,
    [threadId, userId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/** The provider could actually serve this user for chat right now. */
function isChatRequired(provider: ConsentProviderId, country: string): boolean {
  // The keyless free provider is global (no region rules, no key needed) —
  // only the kill switch / env toggle can take it away.
  if (provider === "free") return isFreeEnabled();
  const cc = country.trim().toUpperCase();
  if (!CHAT_IMPLEMENTED.includes(provider)) return false;
  const p = getProvider(provider as ProviderId);
  if (!p.isConfigured() || !p.isEnabled()) return false;
  const allowed = REGION_MAP.get(cc);
  return !!allowed && allowed.includes(provider as ProviderId);
}

/**
 * Keyless provider choice (no provider key configured): the free AI provider
 * gives real answers; the demo provider (nothing leaves the server) is the
 * final fallback, reached automatically if the free service fails mid-stream.
 *
 * Consent is required for the free provider because chat messages leave the
 * server — the caller returns 403 CONSENT_REQUIRED when it is missing.
 */
async function resolveKeylessProvider(
  userId: string,
): Promise<{ provider: ChatProvider; demo: boolean; needsConsent: boolean }> {
  if (isFreeEnabled()) {
    if (await hasLiveConsent(userId, "free")) {
      return { provider: makeFreeProvider(), demo: false, needsConsent: false };
    }
    return { provider: makeDemoProvider(), demo: true, needsConsent: true };
  }
  return { provider: makeDemoProvider(), demo: true, needsConsent: false };
}

interface PersistInfo {
  threadId: string;
  userId: string;
  messageId: string;
  /** JSON string for usage_events.details. */
  details: string;
}

interface RunChatStreamArgs {
  req: FastifyRequest;
  reply: FastifyReply;
  provider: ChatProvider;
  providerId: string;
  model: ModelInfo | null;
  demo: boolean;
  system: string;
  history: ChatMessageInput[];
  /** Echoed as threadId in the start event ("temporary" for temp chat). */
  streamThreadId: string;
  /** Null for temporary chat: no message row, no thread touch. */
  persist: PersistInfo | null;
  /** Extra events emitted immediately after the start event. */
  afterStart: ChatStreamEvent[];
  /**
   * Optional pre-stream phase (Step 6 connector tool loop). Runs after the
   * start event so plain-language activity phases keep their position and
   * heartbeats cover the MCP round-trips. May extend the system prompt with
   * tool results, and may set halt:true to end the stream WITHOUT persisting
   * an assistant message or metering a chat reply (confirmation pause).
   */
  preStream?: (ctx: {
    sendEvent: (event: ChatStreamEvent) => void;
    signal: AbortSignal;
    system: string;
  }) => Promise<{ halt: boolean; system: string }>;
}

/**
 * Shared SSE streaming core. Partial replies are DISCARDED: nothing is
 * persisted or metered unless the provider stream completes. The metering row
 * is always written (even for temp chat — usage_events carries no content).
 */
async function runChatStream(args: RunChatStreamArgs): Promise<void> {
  const { req, reply, provider, providerId, model, demo, system, history } = args;
  const pool = getPool();
  // Keyless free provider has no catalog model — report its own id.
  const modelId = demo ? "demo" : model ? model.id : providerId;
  const messageId = args.persist ? args.persist.messageId : uuidv4();

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (event: ChatStreamEvent): void => {
    try {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // client is gone — the abort handler cleans up
    }
  };

  const aborter = new AbortController();
  let finished = false;
  const onClose = (): void => {
    if (!finished) aborter.abort();
  };
  req.raw.on("close", onClose);
  raw.on("close", onClose);
  const heartbeat = setInterval(() => {
    try {
      raw.write(": ping\n\n");
    } catch {
      // ignore — stream is ending
    }
  }, HEARTBEAT_MS);

  sendEvent({
    type: "start",
    threadId: args.streamThreadId,
    provider: providerId,
    model: modelId,
    demo,
    messageId,
  });
  for (const evt of args.afterStart) sendEvent(evt);

  // Step 6 pre-stream phase (connector tool loop). On halt the stream ends
  // here: no provider call, no assistant message persisted, no chat metering
  // row — the client already got its terminal event (confirmation card).
  let finalSystem = system;
  let halted = false;
  if (args.preStream) {
    const outcome = await args.preStream({ sendEvent, signal: aborter.signal, system: finalSystem });
    finalSystem = outcome.system;
    halted = outcome.halt;
  }

  let fullText = "";
  // The streaming core, parameterized so a failed free-AI attempt can fall
  // back to the demo provider mid-stream (re-announced below).
  const runOnce = async (
    p: ChatProvider,
    pId: string,
    isDemo: boolean,
    mId: string,
  ): Promise<void> => {
    if (!halted) {
      const { inputTokens, outputTokens } = await p.streamChat({
        system: finalSystem,
        messages: history,
        signal: aborter.signal,
        onToken: (text: string) => {
          fullText += text;
          sendEvent({ type: "token", text });
        },
      });

      // Completed: persist the assistant message and meter it. This is the
      // chat choke point for the circuit breaker: a successful provider call
      // resets the failure counter. Demo calls never count.
      if (pId !== "demo") recordProviderSuccess(pId);
      if (args.persist) {
        await pool.query(
          `INSERT INTO chat_messages (id, thread_id, role, content, provider, model, input_tokens, output_tokens, demo)
           VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8)`,
          [
            messageId,
            args.persist.threadId,
            fullText,
            pId,
            mId,
            inputTokens,
            outputTokens,
            isDemo,
          ],
        );
      }
      const costUsd = isDemo || !model ? 0 : chatReplyCost(model, inputTokens, outputTokens);
      const userId = args.persist ? args.persist.userId : (req.auth as { userId: string }).userId;
      // Temp chat carries no content: usage_events has no content column, so
      // the row is safe — details just marks it as temporary.
      const details = args.persist ? args.persist.details : JSON.stringify({ temporary: true });
      await pool.query(
        "INSERT INTO usage_events (id, user_id, feature, provider, units, cost_usd, details) VALUES ($1, $2, 'chat', $3, $4, $5, $6::jsonb)",
        [uuidv4(), userId, pId, inputTokens + outputTokens, costUsd, details],
      );
      if (args.persist) {
        await pool.query("UPDATE chat_threads SET updated_at = now() WHERE id = $1", [
          args.persist.threadId,
        ]);
      }
      sendEvent({ type: "done", inputTokens, outputTokens });
    }
  };
  try {
    await runOnce(provider, providerId, demo, modelId);
  } catch (err) {
    // The free AI service failed: one honest fallback to the demo provider
    // (nothing leaves the server), re-announced so the client labels it demo.
    if (!demo && providerId === "free" && (err as Error)?.name === "FreeUnavailable") {
      fullText = "";
      sendEvent({
        type: "start",
        threadId: args.streamThreadId,
        provider: "demo",
        model: "demo",
        demo: true,
        messageId,
      });
      for (const evt of args.afterStart) sendEvent(evt);
      await runOnce(makeDemoProvider(), "demo", true, "demo");
      return;
    }
    const aborted = aborter.signal.aborted || (err as Error)?.name === "AbortError";
    if (aborted) {
      // Client disconnected mid-stream: discard the partial reply — no
      // message row, no metering row. Client aborts are not provider
      // failures, so the circuit breaker ignores them.
    } else {
      // Non-abort failure at the provider: feed the circuit breaker.
      if (providerId !== "demo") recordProviderFailure(providerId, err);
      const status = (err as { statusCode?: unknown }).statusCode;
      if (status === 401 || status === 403) {
        sendEvent({
          type: "error",
          code: "PROVIDER_AUTH_ERROR",
          message: "The AI provider rejected the request. Please try again later.",
        });
      } else if (status === 429) {
        sendEvent({
          type: "error",
          code: "PROVIDER_RATE_LIMITED",
          message: "The AI provider is busy right now. Please try again in a moment.",
        });
      } else {
        sendEvent({
          type: "error",
          code: "PROVIDER_ERROR",
          message: "The assistant couldn't finish that reply. Please try again.",
        });
      }
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    req.raw.off("close", onClose);
    raw.off("close", onClose);
    try {
      raw.end();
    } catch {
      // already closed
    }
  }
}

/** Oldest-first history assembly with newest-first char budgeting. */
function assembleHistory(
  rows: Array<{ role: string; content: string }>,
  charLimit: number,
): ChatMessageInput[] {
  const history: ChatMessageInput[] = [];
  let historyChars = 0;
  // Newest first: keep the most recent messages; drop the oldest when the
  // char budget is exceeded.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const len = row.content.length;
    if (historyChars + len > charLimit) break;
    historyChars += len;
    history.unshift({ role: row.role as "user" | "assistant", content: row.content });
  }
  return history;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // ---------- thread CRUD ----------

  app.post("/threads", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim().slice(0, 80)
        : DEFAULT_TITLE;
    if (title.length > 80) return sendError(reply, 400, "VALIDATION_ERROR", "Title must be 1–80 characters.");
    const id = uuidv4();
    let projectId: string | null = null;
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== "string" || !UUID_RE.test(body.projectId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown project.");
      }
      const own = await getPool().query("SELECT 1 FROM projects WHERE id = $1 AND user_id = $2", [
        body.projectId,
        auth.userId,
      ]);
      if (!own.rowCount) return sendError(reply, 404, "NOT_FOUND", "Project not found.");
      projectId = body.projectId;
    }
    // Chat polish: optional gem the thread chats with (own or built-in).
    let gemId: string | null = null;
    if (body.gemId !== undefined && body.gemId !== null) {
      if (typeof body.gemId !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "That Gem isn't available.");
      }
      const gem = await getVisibleGem(auth.userId, body.gemId);
      if (!gem) return sendError(reply, 400, "VALIDATION_ERROR", "That Gem isn't available.");
      gemId = gem.id;
    }
    const r = await getPool().query<DbThread>(
      `INSERT INTO chat_threads (id, user_id, title, project_id, gem_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${THREAD_COLUMNS}`,
      [id, auth.userId, title, projectId, gemId],
    );
    return reply.code(201).send({ data: { thread: toChatThread(r.rows[0]) } });
  });

  app.get("/threads", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const r = await getPool().query<DbThread>(
      `SELECT ${THREAD_COLUMNS} FROM chat_threads WHERE user_id = $1 ORDER BY updated_at DESC`,
      [auth.userId],
    );
    return reply.send({ data: { threads: r.rows.map(toChatThread) } });
  });

  app.get("/threads/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const thread = await getThread(auth.userId, (req.params as { id: string }).id);
    if (!thread) return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
    return reply.send({ data: { thread: toChatThread(thread) } });
  });

  app.patch("/threads/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const thread = await getThread(auth.userId, (req.params as { id: string }).id);
    if (!thread) return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
    const body = bodyOf(req);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title.length < 1 || title.length > 80) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Title must be 1–80 characters.");
      }
      sets.push(`title = $${sets.length + 1}`);
      values.push(title);
    }
    if (body.lockdown !== undefined) {
      if (typeof body.lockdown !== "boolean") {
        return sendError(reply, 400, "VALIDATION_ERROR", "Lockdown must be true or false.");
      }
      sets.push(`lockdown = $${sets.length + 1}`);
      values.push(body.lockdown);
    }
    // Chat polish: attach/detach a gem, or toggle Teach-me mode. A gem must
    // be visible (own or built-in); null clears the thread's gem.
    if (body.gemId !== undefined) {
      if (body.gemId === null) {
        sets.push(`gem_id = $${sets.length + 1}`);
        values.push(null);
      } else if (typeof body.gemId === "string") {
        const gem = await getVisibleGem(auth.userId, body.gemId);
        if (!gem) {
          return sendError(reply, 400, "VALIDATION_ERROR", "That Gem isn't available.");
        }
        sets.push(`gem_id = $${sets.length + 1}`);
        values.push(gem.id);
      } else {
        return sendError(reply, 400, "VALIDATION_ERROR", "That Gem isn't available.");
      }
    }
    if (body.tutorMode !== undefined) {
      if (typeof body.tutorMode !== "boolean") {
        return sendError(reply, 400, "VALIDATION_ERROR", "Teach-me mode must be true or false.");
      }
      sets.push(`tutor_mode = $${sets.length + 1}`);
      values.push(body.tutorMode);
    }
    if (sets.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Nothing to update.");
    }
    values.push(thread.id);
    const r = await getPool().query<DbThread>(
      `UPDATE chat_threads SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING ${THREAD_COLUMNS}`,
      values,
    );
    return reply.send({ data: { thread: toChatThread(r.rows[0]) } });
  });

  app.delete("/threads/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const thread = await getThread(auth.userId, (req.params as { id: string }).id);
    if (!thread) return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
    await getPool().query("DELETE FROM chat_threads WHERE id = $1", [thread.id]);
    return reply.send({ data: { deleted: true } });
  });

  // ---------- messages ----------

  app.get("/threads/:id/messages", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const thread = await getThread(auth.userId, (req.params as { id: string }).id);
    if (!thread) return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
    const r = await getPool().query<DbMessage>(
      `SELECT id, thread_id, role, content, provider, model, input_tokens, output_tokens, demo, created_at
       FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC, id ASC`,
      [thread.id],
    );
    return reply.send({ data: { messages: r.rows.map(toChatMessage) } });
  });

  app.delete("/messages/:id", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const messageId = (req.params as { id: string }).id;
    const r = await getPool().query<{ id: string }>(
      `DELETE FROM chat_messages
       WHERE id = $1 AND thread_id IN (SELECT id FROM chat_threads WHERE user_id = $2)
       RETURNING id`,
      [messageId, auth.userId],
    );
    if (!r.rowCount) return sendError(reply, 404, "NOT_FOUND", "Message not found.");
    return reply.send({ data: { deleted: true } });
  });

  // ---------- temporary (stateless) chat ----------

  app.post("/temporary/messages", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);

    // Gate 1: validation. No files in temp chat — there is nowhere to store
    // or extract them, and nothing is persisted at all.
    if (body.fileIds !== undefined) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Files can't be attached in temporary chat.");
    }
    const rawMessages = body.messages;
    if (
      !Array.isArray(rawMessages) ||
      rawMessages.length === 0 ||
      rawMessages.length > TEMP_MESSAGE_LIMIT ||
      rawMessages.some(
        (m) =>
          typeof m !== "object" ||
          m === null ||
          (m.role !== "user" && m.role !== "assistant") ||
          typeof m.content !== "string" ||
          m.content.length < 1 ||
          m.content.length > 8000,
      )
    ) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Messages must be 1–40 user/assistant messages of 1–8000 characters.");
    }
    const rawTaskType = body.taskType === undefined ? "chat" : body.taskType;
    if (typeof rawTaskType !== "string" || !TASK_TYPES.includes(rawTaskType as TaskType)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Unknown task type.");
    }
    const taskType = rawTaskType as TaskType;
    const manualModelId = body.model === undefined ? undefined : body.model;
    if (manualModelId !== undefined) {
      if (typeof manualModelId !== "string" || !findChatModel(manualModelId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown model.");
      }
    }
    // Chat polish: Teach-me mode is available stateless too. Non-boolean → 400.
    let tutor = false;
    if (body.tutor !== undefined) {
      if (typeof body.tutor !== "boolean") {
        return sendError(reply, 400, "VALIDATION_ERROR", "Teach-me mode must be true or false.");
      }
      tutor = body.tutor;
    }

    const country = await getUserCountry(auth.userId);
    if (!country) return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const language = await getUserLanguage(auth.userId);

    // Demo check first: demo requests skip the daily limit (decision #79 —
    // the keyless trial stays frictionless).
    const demoMode = !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;
    if (!demoMode) {
      const limit = await checkLimit(auth.userId, "chat", 1);
      if (!limit.ok) return sendLimitExceeded(reply, "chat");
    }

    let provider: ChatProvider;
    let model: ModelInfo | null = null;
    let demo = false;
    if (demoMode) {
      // Keyless: free AI (real answers) with consent, else the demo provider.
      const keyless = await resolveKeylessProvider(auth.userId);
      if (keyless.needsConsent) {
        return sendError(
          reply,
          403,
          "CONSENT_REQUIRED",
          "To get answers from Free AI, please allow Genze to share your chat messages with them first.",
        );
      }
      demo = keyless.demo;
      provider = keyless.provider;
    } else {
      // Gate 3: routing (fail closed → 503).
      const route = routeChat({ country, taskType, manualModelId });
      if (!route) {
        return sendError(
          reply,
          503,
          "NO_PROVIDER_AVAILABLE",
          "No chat provider is available for your region right now. Please try again later.",
        );
      }
      // Gate 4: consent (same plain message as the normal path).
      if (!(await hasLiveConsent(auth.userId, route.provider))) {
        const name = CONSENT_COPY[route.provider as ConsentProviderId]?.name ?? route.provider;
        return sendError(
          reply,
          403,
          "CONSENT_REQUIRED",
          `To get answers from ${name}, please allow Genze to share your chat messages with them first.`,
        );
      }
      model = route.model;
      provider = makeChatProvider(route.provider as "anthropic" | "openai", model.id);
    }

    // Stateless: history is exactly the provided messages (newest-first char
    // cap, same as threads), base system prompt only, nothing persisted — no
    // thread row, no message rows. The metering row carries no content.
    // Teach-me mode applies its overlay to the base prompt only (no memory,
    // skills, project, or gem — stateless).
    let tempSystem = SYSTEM_PROMPT;
    if (tutor) tempSystem = `${tutorBlock(true)}\n\n${tempSystem}`;

    const provided = (rawMessages as Array<{ role: "user" | "assistant"; content: string }>).map(
      (m) => ({ role: m.role, content: m.content }),
    );
    const history = assembleHistory(provided, HISTORY_CHAR_LIMIT);

    return runChatStream({
      req,
      reply,
      provider,
      providerId: provider.id,
      model,
      demo,
      system: applyLanguageInstruction(tempSystem, { demo, language }),
      history,
      streamThreadId: "temporary",
      persist: null,
      afterStart: [],
    });
  });

  // ---------- streaming reply (SSE) ----------

  app.post("/threads/:id/messages", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const threadId = (req.params as { id: string }).id;

    // Gate 1: auth (preHandler) → ownership → validation.
    const thread = await getThread(auth.userId, threadId);
    if (!thread) return sendError(reply, 404, "NOT_FOUND", "Chat not found.");

    const body = bodyOf(req);
    const content = typeof body.content === "string" ? body.content : "";
    if (content.length < 1 || content.length > 8000) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Message must be 1–8000 characters.");
    }
    const rawTaskType = body.taskType === undefined ? "chat" : body.taskType;
    if (typeof rawTaskType !== "string" || !TASK_TYPES.includes(rawTaskType as TaskType)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Unknown task type.");
    }
    const taskType = rawTaskType as TaskType;
    const manualModelId = body.model === undefined ? undefined : body.model;
    if (manualModelId !== undefined) {
      if (typeof manualModelId !== "string" || !findChatModel(manualModelId)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Unknown model.");
      }
    }

    // Attached files (1..N): must be the user's own ready files.
    let fileIds: string[] = [];
    if (body.fileIds !== undefined) {
      if (
        !Array.isArray(body.fileIds) ||
        body.fileIds.length === 0 ||
        body.fileIds.length > MAX_ATTACHMENTS ||
        body.fileIds.some((f) => typeof f !== "string" || !UUID_RE.test(f))
      ) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Attached files are not valid.");
      }
      fileIds = [...new Set(body.fileIds as string[])];
    }

    // Readiness check BEFORE any gates that persist: no orphan user message
    // on a 400.
    if (fileIds.length > 0) {
      const ready = await getPool().query<{ id: string }>(
        "SELECT id FROM files WHERE user_id = $1 AND id = ANY($2) AND status = 'ready'",
        [auth.userId, fileIds],
      );
      if ((ready.rowCount ?? 0) !== fileIds.length) {
        return sendError(reply, 400, "VALIDATION_ERROR", "Some attached files are not available.");
      }
    }

    // Step 6: connector tool loop inputs. Validated here (before anything
    // persists); ignored for temp chat (separate handler), demo mode and
    // lockdown threads (gated below via chatAugmentations()).
    const useConnectors = parseUseConnectors(body.useConnectors);
    if (!useConnectors.ok) return sendError(reply, 400, "VALIDATION_ERROR", useConnectors.message);
    const confirmedActions = parseConfirmedActions(body.confirmedActions);
    if (!confirmedActions.ok) {
      return sendError(reply, 400, "VALIDATION_ERROR", confirmedActions.message);
    }

    const country = await getUserCountry(auth.userId);
    if (!country) return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const language = await getUserLanguage(auth.userId);

    // Demo check first: demo requests skip the daily limit (decision #79 —
    // the keyless trial stays frictionless).
    const demoMode = !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;
    if (!demoMode) {
      // Gate 2b: daily limit, checked BEFORE the user message is persisted.
      const limit = await checkLimit(auth.userId, "chat", 1);
      if (!limit.ok) return sendLimitExceeded(reply, "chat");
    }

    // Chat polish: the thread's gem (visibility was verified at thread
    // creation; a deleted gem leaves gem_id NULL via SET NULL). Needed for
    // routing (model preference) and for the system-prompt gem block.
    const threadGem: DbGem | null = thread.gem_id
      ? await getVisibleGem(auth.userId, thread.gem_id)
      : null;

    let provider: ChatProvider;
    let model: ModelInfo | null = null;
    let demo = false;
    if (demoMode) {
      // Keyless: free AI (real answers) with consent, else the demo provider.
      const keyless = await resolveKeylessProvider(auth.userId);
      if (keyless.needsConsent) {
        return sendError(
          reply,
          403,
          "CONSENT_REQUIRED",
          "To get answers from Free AI, please allow Genze to share your chat messages with them first.",
        );
      }
      demo = keyless.demo;
      provider = keyless.provider;
    } else {
      // Chat polish: the gem's model preference, when a valid chat-catalog
      // id, becomes the routing preference — still subject to the
      // region/consent/kill-switch gates. An explicit per-request `model`
      // takes precedence over the gem.
      const gemModelPreference =
        threadGem &&
        threadGem.model_preference &&
        findChatModel(threadGem.model_preference)
          ? threadGem.model_preference
          : null;
      const requestedManual = manualModelId ?? gemModelPreference ?? undefined;
      // Gate 3: routing (fail closed → 503). A gem preference that fails the
      // gates falls back to normal routing — never a 400.
      let route = routeChat({ country, taskType, manualModelId: requestedManual });
      if (!route && manualModelId === undefined && gemModelPreference) {
        route = routeChat({ country, taskType });
      }
      if (!route) {
        return sendError(
          reply,
          503,
          "NO_PROVIDER_AVAILABLE",
          "No chat provider is available for your region right now. Please try again later.",
        );
      }
      // Gate 4: consent.
      if (!(await hasLiveConsent(auth.userId, route.provider))) {
        const name = CONSENT_COPY[route.provider as ConsentProviderId]?.name ?? route.provider;
        return sendError(
          reply,
          403,
          "CONSENT_REQUIRED",
          `To get answers from ${name}, please allow Genze to share your chat messages with them first.`,
        );
      }
      model = route.model;
      provider = makeChatProvider(route.provider as "anthropic" | "openai", model.id);
    }

    // Lockdown enforcement seam: augmentation call sites consult
    // chatAugmentations() before firing. The memory read below is the first
    // live consumer (Step 4); web/research/agent channels check the same
    // seam as they land. Attached files and project instructions are the
    // user's own content and keep working in lockdown.
    void chatAugmentations(thread);

    // Persist the user message first.
    //
    // Turn-continuation guard (Step 6): after a connector-write confirmation
    // card, the client re-posts the SAME message content with confirmedActions.
    // The user message from the first POST is already stored — persisting
    // again would duplicate it. So when confirmedActions is non-empty AND the
    // thread's latest message is that same user message, we continue the
    // existing turn instead of inserting a duplicate row (no file re-linking,
    // no title rewrite either — the turn already has them).
    const pool = getPool();
    let skipUserPersist = false;
    if (confirmedActions.ids.length > 0) {
      const last = await pool.query<{ role: string; content: string }>(
        `SELECT role, content FROM chat_messages
         WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [thread.id],
      );
      const row = last.rows[0];
      skipUserPersist = !!row && row.role === "user" && row.content === content;
    }
    const before = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM chat_messages WHERE thread_id = $1",
      [thread.id],
    );
    const isFirstMessage = Number(before.rows[0].n) === 0;
    if (!skipUserPersist) {
      const userMessageId = uuidv4();
      await pool.query(
        "INSERT INTO chat_messages (id, thread_id, role, content, demo) VALUES ($1, $2, 'user', $3, false)",
        [userMessageId, thread.id, content],
      );
      if (fileIds.length > 0) {
        for (const fid of fileIds) {
          await pool.query(
            "INSERT INTO message_files (message_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [userMessageId, fid],
          );
        }
      }
      if (isFirstMessage && thread.title === DEFAULT_TITLE) {
        const autoTitle = content.trim().slice(0, 40);
        if (autoTitle.length > 0) {
          await pool.query("UPDATE chat_threads SET title = $1 WHERE id = $2", [autoTitle, thread.id]);
        }
      }
    }

    // Compaction runs BEFORE history assembly, with the same provider that
    // is answering (consent already verified). Failure-safe: {ran:false}.
    const compacted = await maybeCompactThread({
      userId: auth.userId,
      threadId: thread.id,
      provider,
      providerId: provider.id,
      model,
      demo,
    });
    // Re-read the summary: compaction may have just stored one.
    let compactionSummary: string | null = thread.compaction_summary;
    let compactedThrough: string | null = thread.compacted_through_message_id;
    if (compacted.ran) {
      const fresh = await pool.query<{ compaction_summary: string | null; compacted_through_message_id: string | null }>(
        "SELECT compaction_summary, compacted_through_message_id FROM chat_threads WHERE id = $1",
        [thread.id],
      );
      compactionSummary = fresh.rows[0].compaction_summary;
      compactedThrough = fresh.rows[0].compacted_through_message_id;
    }

    // Thread history: last 40 messages, capped at ~120k chars (oldest
    // dropped). Messages at/below compacted_through_message_id are excluded —
    // their content lives in the summary now.
    const hist = await pool.query<{ id: string; role: string; content: string }>(
      `SELECT id, role, content FROM (
         SELECT id, role, content, created_at FROM chat_messages
         WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
       ) t ORDER BY created_at ASC, id ASC`,
      [thread.id, HISTORY_MESSAGE_LIMIT],
    );
    let histRows = hist.rows;
    if (compactedThrough) {
      const cut = histRows.findIndex((r) => r.id === compactedThrough);
      if (cut >= 0) histRows = histRows.slice(cut + 1);
    }
    const history = assembleHistory(histRows, HISTORY_CHAR_LIMIT);

    // Project instructions + gem + skills + tutor + memory as system
    // context. Contract order (chat polish): project instructions, then the
    // gem block, then attached skills, then the Teach-me overlay, then
    // long-term memory — then the base prompt (which may carry the
    // compaction summary). The gem block, skills and the tutor overlay are
    // the user's own configuration like project instructions, so they apply
    // in lockdown too; the memory seam still gates memory.
    let system = SYSTEM_PROMPT;
    if (compactionSummary) {
      system = compactionSystemPrefix(compactionSummary) + system;
    }
    let projectInstructions = "";
    if (thread.project_id) {
      const pr = await pool.query<{ instructions: string }>(
        "SELECT instructions FROM projects WHERE id = $1 AND user_id = $2",
        [thread.project_id, auth.userId],
      );
      projectInstructions = pr.rowCount ? pr.rows[0].instructions.trim() : "";
    }
    const gemBlock = threadGem ? buildGemBlock(threadGem) : "";
    // Attached skills: the thread's + the project's + the gem's, deduped by id.
    const skillsBlock = await buildSkillsBlock(
      auth.userId,
      thread.id,
      thread.project_id,
      threadGem?.id ?? null,
    );
    const tutorOverlay = tutorBlock(thread.tutor_mode);
    // Long-term memory (Step 4): up to 20 newest memories. The seam returns
    // memory:false in lockdown, and the temporary-chat path never reaches this
    // code — memory is read on threaded chat only. No automatic writes in v1.
    let memoryBlock = "";
    if (chatAugmentations(thread).memory) {
      const mem = await pool.query<{ content: string }>(
        "SELECT content FROM user_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
        [auth.userId],
      );
      if ((mem.rowCount ?? 0) > 0) {
        const lines = mem.rows.map((r) => `- ${r.content}`).join("\n");
        memoryBlock = `[What I remember about you:\n${lines}]`;
      }
    }
    const prefix = assembleSystemPrefix({
      projectInstructions,
      gem: gemBlock,
      skills: skillsBlock,
      tutor: tutorOverlay,
      memory: memoryBlock,
    });
    if (prefix.length > 0) system = `${prefix}\n\n${system}`;
    const fileCtx = await buildFileContext(auth.userId, {
      explicitFileIds: fileIds,
      projectId: thread.project_id,
      gemId: threadGem?.id ?? null,
    });
    if (fileCtx.text.length > 0) {
      system +=
        "\n\nThe user attached these files for this conversation. " +
        "Answer using their contents when relevant, and name the file you are quoting.\n" +
        fileCtx.text;
    }
    if (fileCtx.images.length > 0 && history.length > 0) {
      // Vision applies to the latest user message only.
      history[history.length - 1].images = fileCtx.images;
    }

    // Preferred-language instruction (Step 4 multilingual v1): prepended to
    // the fully assembled system prompt (base + compaction summary + project
    // instructions + memory + file context); skipped for demo chat.
    system = applyLanguageInstruction(system, { demo, language });

    // Metering details: file assembly stats + lockdown flag. The fileContext
    // key shape is kept for Step 3 compatibility.
    const details = JSON.stringify({ fileContext: fileCtx.stats, lockdown: thread.lockdown });
    const messageId = uuidv4();

    // Step 6: bounded connector tool loop. Ignored for demo mode and lockdown
    // threads — connector tools are an agent-class augmentation, gated by the
    // chatAugmentations() seam. Temp chat never reaches this code.
    const connectorLoopOn =
      !demo &&
      chatAugmentations(thread).agent &&
      (useConnectors.ids.length > 0 || confirmedActions.ids.length > 0);

    return runChatStream({
      req,
      reply,
      provider,
      providerId: provider.id,
      model,
      demo,
      system,
      history,
      streamThreadId: thread.id,
      persist: { threadId: thread.id, userId: auth.userId, messageId, details },
      afterStart: compacted.ran ? [{ type: "compacted" }] : [],
      preStream: connectorLoopOn
        ? async ({ sendEvent, signal, system: sys }) => {
            const outcome = await runConnectorToolLoop({
              userId: auth.userId,
              connectorIds: useConnectors.ids,
              confirmedActionIds: confirmedActions.ids,
              provider,
              providerId: provider.id,
              system: sys,
              history,
              signal,
              sendEvent,
            });
            if (outcome.fatalError) {
              sendEvent({
                type: "error",
                code: outcome.fatalError.code,
                message: outcome.fatalError.message,
              });
            }
            return {
              halt: outcome.halt,
              system: outcome.extraSystem ? `${sys}\n\n${outcome.extraSystem}` : sys,
            };
          }
        : undefined,
    });
  });

  // ---------- consent ----------

  app.get("/consent", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const country = (await getUserCountry(auth.userId)) ?? "";
    const statuses: ConsentProviderStatus[] = await Promise.all(
      CONSENT_PROVIDERS.map(async (id) => {
        const copy = CONSENT_COPY[id];
        return {
          id,
          name: copy.name,
          whatSees: copy.whatSees,
          required: isChatRequired(id, country),
          granted: await hasLiveConsent(auth.userId, id),
        };
      }),
    );
    return reply.send({ data: { providers: statuses } });
  });

  app.post("/consent", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = bodyOf(req);
    const providerIds = body.providerIds;
    if (!Array.isArray(providerIds) || providerIds.length === 0) {
      return sendError(reply, 400, "VALIDATION_ERROR", "providerIds must be a non-empty array.");
    }
    const country = (await getUserCountry(auth.userId)) ?? "";
    for (const id of providerIds) {
      if (typeof id !== "string" || !isChatRequired(id as ConsentProviderId, country)) {
        return sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          `Consent cannot be granted for "${String(id)}".`,
        );
      }
    }
    const granted: string[] = [];
    let newlyGranted = false;
    for (const id of providerIds as string[]) {
      const existing = await getPool().query(
        "SELECT 1 FROM consent_records WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL",
        [auth.userId, id],
      );
      if (!existing.rowCount) newlyGranted = true;
      await getPool().query(
        `INSERT INTO consent_records (user_id, provider, granted_at, revoked_at)
         VALUES ($1, $2, now(), NULL)
         ON CONFLICT (user_id, provider) DO UPDATE SET granted_at = now(), revoked_at = NULL`,
        [auth.userId, id],
      );
      granted.push(id);
    }
    // 201 when something new was granted, 200 when everything was already granted.
    return reply.code(newlyGranted ? 201 : 200).send({ data: { granted } });
  });

  app.delete("/consent/:provider", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const provider = (req.params as { provider: string }).provider;
    if (!(CONSENT_PROVIDERS as readonly string[]).includes(provider)) {
      return sendError(reply, 404, "NOT_FOUND", "Unknown provider.");
    }
    await getPool().query(
      "UPDATE consent_records SET revoked_at = now() WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL",
      [auth.userId, provider],
    );
    return reply.send({ data: { revoked: true } });
  });
}
