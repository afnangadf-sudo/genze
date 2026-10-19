// Step 3 chat integration tests: project instructions + file context reach
// the provider, multi-file context honors the token budget (metering logs the
// stats), attached images are sent as provider vision blocks, and message
// attachments are recorded. Provider HTTP is stubbed; no network.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { authHeader, email, fixture, signupVerifyLogin, uploadFile } from "./helpers.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL=<redacted>
process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-2";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "genze-chatfiles-test-"));

const MANAGED = ["FREE_AI_ENABLED", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FILE_CONTEXT_CHARS"];
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
  rmSync(process.env.STORAGE_DIR as string, { recursive: true, force: true });
});

const ANTHROPIC_SSE =
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ahoy! "}}\n\n' +
  'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n';

const OPENAI_SSE =
  'data: {"choices":[{"delta":{"content":"Ahoy! "}}]}\n\n' +
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
  "data: [DONE]\n\n";

let capturedBody: Record<string, unknown> | null = null;

function stubFetch(sse: string) {
  capturedBody = null;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    try {
      capturedBody = JSON.parse(String((init as { body?: string }).body));
    } catch {
      capturedBody = null;
    }
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

async function grantConsent(token: string, provider: string) {
  const res = await app.inject({
    method: "POST",
    url: API_ROUTES.chatConsent,
    headers: authHeader(token),
    payload: { providerIds: [provider] },
  });
  expect([200, 201]).toContain(res.statusCode);
}

async function sendMessage(token: string, threadId: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: API_ROUTES.chatMessages(threadId),
    headers: authHeader(token),
    payload,
  });
  expect(res.statusCode).toBe(200);
  return res;
}

describe("project instructions + file context", () => {
  it("injects project instructions and project file text into the provider request", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubFetch(ANTHROPIC_SSE);
    const token = await signupVerifyLogin(app, email("pinj"));

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      headers: authHeader(token),
      payload: { title: "Pirates", instructions: "Always start replies with the word Ahoy." },
    });
    const projectId = res.json().data.project.id as string;

    const up = await uploadFile(app, token, "hello.pdf", "application/pdf", await fixture("hello.pdf"), {
      projectId,
    });
    expect(up.statusCode).toBe(201);

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(token),
      payload: { projectId },
    });
    expect(res.json().data.thread.projectId).toBe(projectId);
    const threadId = res.json().data.thread.id as string;

    await grantConsent(token, "anthropic");
    await sendMessage(token, threadId, { content: "summarize the file" });

    expect(capturedBody).not.toBeNull();
    const system = capturedBody!.system as string;
    expect(system).toContain("Always start replies with the word Ahoy.");
    expect(system).toContain("[File: hello.pdf]");
    expect(system).toContain("quick brown fox");
  });

  it("threads without a project get no instructions and no file context", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubFetch(ANTHROPIC_SSE);
    const token = await signupVerifyLogin(app, email("noctx"));

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(token),
      payload: {},
    });
    const threadId = res.json().data.thread.id as string;
    await grantConsent(token, "anthropic");
    await sendMessage(token, threadId, { content: "hello" });

    const system = capturedBody!.system as string;
    expect(system).not.toContain("[File:");
  });
});

describe("multi-file attachments + token budget", () => {
  it("attaches several files, drops the largest first over budget, and logs metering details", async () => {
    // Demo mode (no keys): the stream completes locally and writes metering.
    process.env.FILE_CONTEXT_CHARS = "100";
    const token = await signupVerifyLogin(app, email("budget"));

    const up1 = await uploadFile(app, token, "hello.pdf", "application/pdf", await fixture("hello.pdf"));
    const up2 = await uploadFile(app, token, "hello.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await fixture("hello.docx"));
    const id1 = up1.json().data.file.id as string;
    const id2 = up2.json().data.file.id as string;

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(token),
      payload: {},
    });
    const threadId = res.json().data.thread.id as string;

    await sendMessage(token, threadId, { content: "compare the files", fileIds: [id1, id2] });

    // Both attachments recorded on the user message.
    const links = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM message_files mf
       JOIN chat_messages m ON m.id = mf.message_id
       WHERE m.thread_id = $1 AND m.role = 'user'`,
      [threadId],
    );
    expect(Number(links.rows[0].n)).toBe(2);

    // Metering details log the assembly stats.
    const userRow = await getPool().query<{ id: string }>(
      "SELECT id FROM users WHERE id = (SELECT user_id FROM chat_threads WHERE id = $1)",
      [threadId],
    );
    const userId = userRow.rows[0].id;
    const met = await getPool().query<{ details: { fileContext: { attached: number; included: number; dropped: number; chars: number } } }>(
      "SELECT details FROM usage_events WHERE user_id = $1 AND feature = 'chat' ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    expect(met.rowCount).toBe(1);
    const stats = met.rows[0].details.fileContext;
    expect(stats.attached).toBe(2);
    expect(stats.included).toBe(1);
    expect(stats.dropped).toBe(1);
    expect(stats.chars).toBeLessThanOrEqual(100);
  });

  it("rejects invalid or foreign file attachments", async () => {
    const token = await signupVerifyLogin(app, email("badfiles"));
    const other = await signupVerifyLogin(app, email("badfiles-other"));
    const up = await uploadFile(app, other, "hello.pdf", "application/pdf", await fixture("hello.pdf"));
    const foreignId = up.json().data.file.id as string;

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(token),
      payload: {},
    });
    const threadId = res.json().data.thread.id as string;

    for (const bad of [
      { fileIds: ["not-a-uuid"] },
      { fileIds: [foreignId] },
      { fileIds: new Array(11).fill(foreignId) },
      { fileIds: "nope" },
    ]) {
      res = await app.inject({
        method: "POST",
        url: API_ROUTES.chatMessages(threadId),
        headers: authHeader(token),
        payload: { content: "hi", ...bad },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("image vision input", () => {
  it("sends an attached image as an Anthropic image block", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubFetch(ANTHROPIC_SSE);
    const token = await signupVerifyLogin(app, email("vision-a"));

    const up = await uploadFile(app, token, "hello.png", "image/png", await fixture("hello.png"));
    const fileId = up.json().data.file.id as string;

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(token),
      payload: {},
    });
    const threadId = res.json().data.thread.id as string;
    await grantConsent(token, "anthropic");
    await sendMessage(token, threadId, { content: "what is in this picture?", fileIds: [fileId] });

    const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
    const last = messages[messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as Array<{ type: string; source?: { type: string; media_type: string; data: string } }>;
    expect(parts[0].type).toBe("text");
    const img = parts.find((p) => p.type === "image");
    expect(img).toBeDefined();
    expect(img!.source!.type).toBe("base64");
    expect(img!.source!.media_type).toBe("image/png");
    expect(img!.source!.data.length).toBeGreaterThan(100);
  });

  it("sends an attached image as an OpenAI image_url part", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    stubFetch(OPENAI_SSE);
    const token = await signupVerifyLogin(app, email("vision-o"));

    const up = await uploadFile(app, token, "hello.png", "image/png", await fixture("hello.png"));
    const fileId = up.json().data.file.id as string;

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(token),
      payload: {},
    });
    const threadId = res.json().data.thread.id as string;
    await grantConsent(token, "openai");
    await sendMessage(token, threadId, { content: "what is in this picture?", fileIds: [fileId] });

    const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
    const last = messages[messages.length - 1];
    const parts = last.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    const img = parts.find((p) => p.type === "image_url");
    expect(img).toBeDefined();
    expect(img!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
  });
});
