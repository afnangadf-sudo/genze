// Quick wins tests: temporary (stateless) chat, lockdown mode, thread
// compaction. Drive the app with fastify.inject — no network; provider HTTP
// calls are stubbed by replacing globalThis.fetch.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { testEmailOutbox } from "../src/email.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { chatAugmentations } from "../src/chat/lockdown.js";
import { chatReplyCost, findChatModel } from "../src/providers/models.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-2";
process.env.REDIS_URL = ""; // health must report redis:false, not hang
process.env.APP_URL = "http://localhost:3000";
// Provider keys intentionally unset by default -> demo mode is exercised.

const MANAGED = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "PROVIDER_DISABLED",
  "FREE_AI_ENABLED",
  "ANTHROPIC_CHAT_MODEL",
  "ANTHROPIC_REASONING_MODEL",
  "OPENAI_CHAT_MODEL",
  "OPENAI_REASONING_MODEL",
  "COMPACTION_TRIGGER_CHARS",
  "COMPACTION_KEEP_MESSAGES",
  "COMPACTION_SUMMARY_MAX_CHARS",
];

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedFetch = globalThis.fetch;
  process.env.FREE_AI_ENABLED = "false"; // restore zero-keys -> demo world
});

afterEach(() => {
  for (const k of MANAGED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch!;
});

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await closeRedis();
});

const email = (tag: string) => `qw-${tag}-${randomUUID().slice(0, 8)}@example.com`;
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function lastTokenFor(to: string): string {
  const found = [...testEmailOutbox].reverse().find((e) => e.to === to);
  expect(found).toBeDefined();
  const m = found!.text.match(/token=([0-9a-f]+)/);
  expect(m).toBeTruthy();
  return m![1];
}

async function signupVerifyLogin(em: string, password: string, country: string) {
  let res = await app.inject({
    method: "POST",
    url: API_ROUTES.signup,
    payload: { email: em, password, country },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().data.user.id as string;
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.verifyEmail,
    payload: { token: lastTokenFor(em) },
  });
  expect(res.statusCode).toBe(200);
  res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password } });
  expect(res.statusCode).toBe(200);
  const tokens = res.json().data.tokens as { accessToken: string; refreshToken: string };
  return { tokens, userId };
}

/** Parse the `data: <json>` frames out of an SSE payload. */
function sseEvents(payload: string): Array<Record<string, unknown>> {
  return payload
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice("data:".length).trim()) as Record<string, unknown>);
}

async function grantConsent(headers: Record<string, string>, providerId: string) {
  const res = await app.inject({
    method: "POST",
    url: API_ROUTES.chatConsent,
    headers,
    payload: { providerIds: [providerId] },
  });
  expect([200, 201]).toContain(res.statusCode);
}

const ANTHROPIC_SSE =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-haiku-5.5","usage":{"input_tokens":10,"output_tokens":0}}}\n' +
  "\n" +
  "event: content_block_start\n" +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n' +
  "\n" +
  "event: content_block_delta\n" +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n' +
  "\n" +
  "event: content_block_delta\n" +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n' +
  "\n" +
  "event: message_delta\n" +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n' +
  "\n" +
  "event: message_stop\n" +
  'data: {"type":"message_stop"}\n' +
  "\n";

const SUMMARY_TEXT = "THIS IS THE COMPACTION SUMMARY";
const SUMMARY_SSE =
  "event: message_start\n" +
  'data: {"type":"message_start","message":{"id":"msg_s","usage":{"input_tokens":40,"output_tokens":0}}}\n' +
  "\n" +
  "event: content_block_delta\n" +
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${SUMMARY_TEXT}"}}\n` +
  "\n" +
  "event: message_delta\n" +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n' +
  "\n" +
  "event: message_stop\n" +
  'data: {"type":"message_stop"}\n' +
  "\n";

interface CapturedRequest {
  system?: string;
  messages: Array<{ role: string; content: string }>;
}

/** Stub fetch; captures Anthropic request bodies so tests can assert on them. */
function stubAnthropicFetch(captured: CapturedRequest[], summaryStatus = 200) {
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest;
    captured.push(body);
    const isSummary =
      typeof body.system === "string" && body.system.includes("Summarize the earlier part");
    if (isSummary && summaryStatus !== 200) {
      return new Response("boom", { status: summaryStatus });
    }
    return new Response(isSummary ? SUMMARY_SSE : ANTHROPIC_SSE, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

describe("temporary chat (stateless)", () => {
  it("streams replies without persisting any thread or message rows", async () => {
    const { tokens, userId } = await signupVerifyLogin(email("temp"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const before = await getPool().query("SELECT count(*) AS n FROM usage_events WHERE user_id = $1", [
      userId,
    ]);

    for (let turn = 0; turn < 3; turn++) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.chatTempMessages,
        headers: h,
        payload: {
          messages: [
            { role: "user", content: `turn ${turn} question` },
            { role: "assistant", content: `turn ${turn} answer` },
            { role: "user", content: `turn ${turn} follow-up` },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      const events = sseEvents(res.body);
      const start = events[0];
      expect(start.type).toBe("start");
      expect(start.provider).toBe("demo");
      expect(start.demo).toBe(true);
      expect(start.threadId).toBe("temporary");
      const done = events[events.length - 1];
      expect(done.type).toBe("done");
      const text = events
        .filter((e) => e.type === "token")
        .map((e) => String(e.text))
        .join("");
      expect(text).toContain("demo answer");
    }

    // Nothing persisted: no threads, no messages for this user.
    const threads = await getPool().query("SELECT count(*) AS n FROM chat_threads WHERE user_id = $1", [
      userId,
    ]);
    expect(Number(threads.rows[0].n)).toBe(0);
    const messages = await getPool().query(
      "SELECT count(*) AS n FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE user_id = $1)",
      [userId],
    );
    expect(Number(messages.rows[0].n)).toBe(0);

    // ...but each reply was metered (feature 'chat'), details mark it temporary.
    const r = await getPool().query(
      "SELECT feature, provider, details FROM usage_events WHERE user_id = $1 AND feature = 'chat' ORDER BY created_at",
      [userId],
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.provider).toBe("demo");
      expect(row.details.temporary).toBe(true);
    }
    expect(Number(before.rows[0].n) + 3).toBe(r.rows.length + Number(before.rows[0].n));

    // Thread list is empty — temp chat leaves no trace there.
    const list = await app.inject({ method: "GET", url: API_ROUTES.chatThreads, headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.threads).toHaveLength(0);
  });

  it("validates the temp payload", async () => {
    const { tokens } = await signupVerifyLogin(email("tempval"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const bad = [
      { messages: [] }, // empty
      { messages: Array.from({ length: 41 }, (_, i) => ({ role: "user", content: `m${i}` })) }, // too many
      { messages: [{ role: "user", content: "hi" }], fileIds: [randomUUID()] }, // files
      { messages: [{ role: "system", content: "hi" }] }, // bad role
      { messages: [{ role: "user", content: "" }] }, // empty content
      { messages: [{ role: "user", content: "x".repeat(8001) }] }, // too long
      { messages: [{ role: "user", content: "hi" }], taskType: "nope" },
      { messages: [{ role: "user", content: "hi" }], model: "not-a-model" },
    ];
    for (const payload of bad) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.chatTempMessages,
        headers: h,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    // fileIds get their own plain message
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: { messages: [{ role: "user", content: "hi" }], fileIds: [randomUUID()] },
    });
    expect(res.json().error.message).toBe("Files can't be attached in temporary chat.");
    // unauthenticated -> 401
    const res2 = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res2.statusCode).toBe(401);
  });

  it("applies the consent gate in temp chat with a real provider", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const captured: CapturedRequest[] = [];
    stubAnthropicFetch(captured);
    const { tokens } = await signupVerifyLogin(email("tempconsent"), "password123", "PK");
    const h = authHeader(tokens.accessToken);

    // no consent yet -> 403
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CONSENT_REQUIRED");
    expect(captured).toHaveLength(0); // nothing was sent to the provider

    await grantConsent(h, "anthropic");
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events[0].provider).toBe("anthropic");
    expect(events[0].demo).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0].messages).toHaveLength(1);
    expect(captured[0].messages[0].content).toBe("hello");
  });
});

describe("lockdown mode", () => {
  it("toggles lockdown on threads; non-boolean is rejected", async () => {
    const { tokens } = await signupVerifyLogin(email("lock"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const res0 = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: h, payload: {} });
    const threadId = res0.json().data.thread.id as string;
    expect(res0.json().data.thread.lockdown).toBe(false);

    let res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.thread.lockdown).toBe(true);

    res = await app.inject({ method: "GET", url: API_ROUTES.chatThread(threadId), headers: h });
    expect(res.json().data.thread.lockdown).toBe(true);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.thread.lockdown).toBe(false);

    // non-boolean lockdown -> 400
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // empty patch -> 400
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    // title + lockdown together
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { title: "Locked chat", lockdown: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.thread.title).toBe("Locked chat");
    expect(res.json().data.thread.lockdown).toBe(true);
  });

  it("chatAugmentations blocks everything in lockdown, allows all otherwise", () => {
    const locked = chatAugmentations({ lockdown: true });
    expect(locked).toEqual({ web: false, agent: false, memory: false });
    const open = chatAugmentations({ lockdown: false });
    expect(open).toEqual({ web: true, agent: true, memory: true });
  });

  it("metering details record lockdown:true on a lockdown thread reply", async () => {
    const { tokens, userId } = await signupVerifyLogin(email("lockmet"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const res0 = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: h, payload: {} });
    const threadId = res0.json().data.thread.id as string;
    await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: true },
    });

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "locked question" },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events[events.length - 1].type).toBe("done");

    const r = await getPool().query(
      "SELECT details FROM usage_events WHERE user_id = $1 AND feature = 'chat' ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    expect(r.rows[0].details.lockdown).toBe(true);
    expect(r.rows[0].details.fileContext).toBeDefined();
  });
});

describe("thread compaction", () => {
  /** Insert N alternating user/assistant messages directly (long bodies). */
  async function seedLongThread(threadId: string, n: number) {
    const base = Date.now() - n * 1000;
    for (let i = 0; i < n; i++) {
      await getPool().query(
        "INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)",
        [
          randomUUID(),
          threadId,
          i % 2 === 0 ? "user" : "assistant",
          `seed message ${i} about ancient history. ${"x".repeat(420)}`,
          new Date(base + i * 1000),
        ],
      );
    }
  }

  it("summarizes old messages, meters, emits compacted, trims history, prefixes system", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.COMPACTION_TRIGGER_CHARS = "2000";
    process.env.COMPACTION_KEEP_MESSAGES = "3";
    const captured: CapturedRequest[] = [];
    stubAnthropicFetch(captured);

    const { tokens, userId } = await signupVerifyLogin(email("compact"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    const res0 = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: h, payload: {} });
    const threadId = res0.json().data.thread.id as string;
    await seedLongThread(threadId, 8);

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "new question about the vikings" },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events[0].type).toBe("start");
    expect(events[1]).toEqual({ type: "compacted" });
    expect(events[events.length - 1].type).toBe("done");

    // summary + cutoff stored on the thread
    const thr = await getPool().query(
      "SELECT compaction_summary, compacted_through_message_id FROM chat_threads WHERE id = $1",
      [threadId],
    );
    expect(thr.rows[0].compaction_summary).toBe(SUMMARY_TEXT);
    expect(thr.rows[0].compacted_through_message_id).toBeTruthy();

    // compaction metered (feature='compaction'), chat metered too
    const met = await getPool().query(
      "SELECT feature, provider, units, cost_usd FROM usage_events WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    const compaction = met.rows.find((r) => r.feature === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction.provider).toBe("anthropic");
    expect(Number(compaction.units)).toBe(65); // 40 in + 25 out
    const model = findChatModel("claude-haiku-5.5")!;
    expect(Number(compaction.cost_usd)).toBeCloseTo(chatReplyCost(model, 40, 25), 12);
    expect(met.rows.filter((r) => r.feature === "chat")).toHaveLength(1);

    // the summarizer request: same provider, system carries the marker,
    // input formatted as User:/Assistant: lines, prior summary absent (first run)
    const summaryReq = captured.find((b) =>
      (b.system ?? "").includes("Summarize the earlier part"),
    )!;
    expect(summaryReq).toBeDefined();
    expect(summaryReq.messages).toHaveLength(1);
    expect(summaryReq.messages[0].content).toContain("User: seed message 0");
    expect(summaryReq.messages[0].content).toContain("Assistant: seed message 1");

    // the reply request: ends with the newest user message (recency
    // preserved), system contains the summary text
    const replyReq = captured.find((b) => !(b.system ?? "").includes("Summarize the earlier part"))!;
    expect(replyReq).toBeDefined();
    const last = replyReq.messages[replyReq.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("new question about the vikings");
    expect(replyReq.system).toContain(SUMMARY_TEXT);
    // compacted messages excluded: only the newest 3 survive
    expect(replyReq.messages).toHaveLength(3);

    // messages are NOT deleted by compaction — still all readable
    const msgs = await app.inject({
      method: "GET",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
    });
    expect(msgs.json().data.messages).toHaveLength(10); // 8 seed + user + assistant

    // thread reads report compacted:true
    const got = await app.inject({ method: "GET", url: API_ROUTES.chatThread(threadId), headers: h });
    expect(got.json().data.thread.compacted).toBe(true);
    const list = await app.inject({ method: "GET", url: API_ROUTES.chatThreads, headers: h });
    expect(list.json().data.threads[0].compacted).toBe(true);
  });

  it("is failure-safe: a broken summarizer never breaks the reply", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.COMPACTION_TRIGGER_CHARS = "2000";
    process.env.COMPACTION_KEEP_MESSAGES = "3";
    const captured: CapturedRequest[] = [];
    stubAnthropicFetch(captured, 500); // summary call fails

    const { tokens, userId } = await signupVerifyLogin(email("compactfail"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    const res0 = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: h, payload: {} });
    const threadId = res0.json().data.thread.id as string;
    await seedLongThread(threadId, 8);

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "hello again" },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events[0].type).toBe("start");
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    expect(events[events.length - 1].type).toBe("done");
    const text = events
      .filter((e) => e.type === "token")
      .map((e) => String(e.text))
      .join("");
    expect(text).toBe("Hello there");

    // nothing stored, nothing metered for compaction
    const thr = await getPool().query(
      "SELECT compaction_summary, compacted_through_message_id FROM chat_threads WHERE id = $1",
      [threadId],
    );
    expect(thr.rows[0].compaction_summary).toBeNull();
    expect(thr.rows[0].compacted_through_message_id).toBeNull();
    const met = await getPool().query(
      "SELECT count(*) AS n FROM usage_events WHERE user_id = $1 AND feature = 'compaction'",
      [userId],
    );
    expect(Number(met.rows[0].n)).toBe(0);
  });

  it("does nothing when the thread is short", async () => {
    process.env.COMPACTION_TRIGGER_CHARS = "2000";
    process.env.COMPACTION_KEEP_MESSAGES = "3";
    const { tokens, userId } = await signupVerifyLogin(email("compactshort"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const res0 = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: h, payload: {} });
    const threadId = res0.json().data.thread.id as string;

    // demo mode: 2 short turns, far below the trigger
    for (const q of ["hi", "hello"]) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.chatMessages(threadId),
        headers: h,
        payload: { content: q },
      });
      expect(res.statusCode).toBe(200);
      const events = sseEvents(res.body);
      expect(events.some((e) => e.type === "compacted")).toBe(false);
    }
    const thr = await getPool().query("SELECT compaction_summary FROM chat_threads WHERE id = $1", [
      threadId,
    ]);
    expect(thr.rows[0].compaction_summary).toBeNull();
    const met = await getPool().query(
      "SELECT count(*) AS n FROM usage_events WHERE user_id = $1 AND feature = 'compaction'",
      [userId],
    );
    expect(Number(met.rows[0].n)).toBe(0);
  });
});
