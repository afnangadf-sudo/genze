// Skills Step 6 tests: skill CRUD, built-in read-only guard (403),
// project/thread attach + detach, and the skills system-prompt block order
// (after project instructions, before memory). Drive the app with
// fastify.inject — no network; provider HTTP calls are stubbed by replacing
// globalThis.fetch.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { testEmailOutbox } from "../src/email.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-1";
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

const email = (tag: string) => `skills-${tag}-${randomUUID().slice(0, 8)}@example.com`;
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function lastTokenFor(to: string): string {
  const found = [...testEmailOutbox].reverse().find((e) => e.to === to);
  expect(found).toBeDefined();
  const m = found!.text.match(/token=([0-9a-f]+)/);
  expect(m).toBeTruthy();
  return m![1];
}

async function signupVerifyLogin(em: string, country = "PK") {
  let res = await app.inject({
    method: "POST",
    url: API_ROUTES.signup,
    payload: { email: em, password: "password123", country },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().data.user.id as string;
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.verifyEmail,
    payload: { token: lastTokenFor(em) },
  });
  expect(res.statusCode).toBe(200);
  res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "password123" } });
  expect(res.statusCode).toBe(200);
  const tokens = res.json().data.tokens as { accessToken: string; refreshToken: string };
  return { tokens, userId };
}

const ANTHROPIC_SSE =
  "event: message_start\n" +
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-haiku-5.5","usage":{"input_tokens":10,"output_tokens":0}}}\n' +
  "\n" +
  "event: content_block_start\n" +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n' +
  "\n" +
  "event: content_block_delta\n" +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"noted"}}\n' +
  "\n" +
  "event: message_delta\n" +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n' +
  "\n" +
  "event: message_stop\n" +
  'data: {"type":"message_stop"}\n' +
  "\n";

describe("skill CRUD", () => {
  it("creates, reads, lists (built-ins first), updates and deletes skills", async () => {
    const { tokens } = await signupVerifyLogin(email("crud"));
    const h = authHeader(tokens.accessToken);

    // built-ins are seeded
    let res = await app.inject({ method: "GET", url: API_ROUTES.skills, headers: h });
    expect(res.statusCode).toBe(200);
    const seeded = res.json().data.skills as Array<{ name: string; builtin: boolean }>;
    expect(seeded.map((s) => s.name)).toEqual(["Brand voice", "Meeting notes", "Spreadsheet cleanup"]);
    expect(seeded.every((s) => s.builtin)).toBe(true);

    // create
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: h,
      payload: {
        name: "Code review",
        description: "Review diffs like a senior.",
        instructions: "Be blunt. List issues by severity.",
        scripts: ["checklist"],
      },
    });
    expect(res.statusCode).toBe(201);
    const skill = res.json().data.skill;
    expect(skill.builtin).toBe(false);
    expect(skill.scripts).toEqual(["checklist"]);

    // list: built-ins first, then own
    res = await app.inject({ method: "GET", url: API_ROUTES.skills, headers: h });
    const skills = res.json().data.skills as Array<{ name: string; builtin: boolean }>;
    expect(skills.slice(0, 3).every((s) => s.builtin)).toBe(true);
    expect(skills[3].name).toBe("Code review");

    // get
    res = await app.inject({ method: "GET", url: API_ROUTES.skill(skill.id), headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.skill.name).toBe("Code review");

    // patch own
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.skill(skill.id),
      headers: h,
      payload: { description: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.skill.description).toBe("Updated");

    // validation
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: h,
      payload: { name: "", instructions: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // delete own
    res = await app.inject({ method: "DELETE", url: API_ROUTES.skill(skill.id), headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);
    res = await app.inject({ method: "GET", url: API_ROUTES.skill(skill.id), headers: h });
    expect(res.statusCode).toBe(404);
  });

  it("built-ins are read-only: PATCH/DELETE -> 403 FORBIDDEN", async () => {
    const { tokens } = await signupVerifyLogin(email("builtin"));
    const h = authHeader(tokens.accessToken);
    const res0 = await app.inject({ method: "GET", url: API_ROUTES.skills, headers: h });
    const builtin = (res0.json().data.skills as Array<{ id: string }>)[0];

    let res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.skill(builtin.id),
      headers: h,
      payload: { name: "Hacked" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");

    res = await app.inject({ method: "DELETE", url: API_ROUTES.skill(builtin.id), headers: h });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");

    // built-in unchanged
    res = await app.inject({ method: "GET", url: API_ROUTES.skill(builtin.id), headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.skill.name).toBe("Brand voice");
  });

  it("skills are private: another user cannot see, attach or edit them", async () => {
    const a = await signupVerifyLogin(email("priva"));
    const b = await signupVerifyLogin(email("privb"));
    const ha = authHeader(a.tokens.accessToken);
    const hb = authHeader(b.tokens.accessToken);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: ha,
      payload: { name: "Secret sauce", instructions: "Shh." },
    });
    const skillId = res.json().data.skill.id as string;

    res = await app.inject({ method: "GET", url: API_ROUTES.skill(skillId), headers: hb });
    expect(res.statusCode).toBe(404);
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.skill(skillId),
      headers: hb,
      payload: { name: "Stolen" },
    });
    expect(res.statusCode).toBe(404);

    // b's list has only built-ins
    res = await app.inject({ method: "GET", url: API_ROUTES.skills, headers: hb });
    expect((res.json().data.skills as unknown[]).length).toBe(3);
  });
});

describe("skill attachments", () => {
  it("attaches/detaches skills to projects and threads", async () => {
    const { tokens } = await signupVerifyLogin(email("attach"));
    const h = authHeader(tokens.accessToken);

    // project + thread fixtures
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      headers: h,
      payload: { title: "P1" },
    });
    expect(res.statusCode).toBe(201);
    const projectId = res.json().data.project.id as string;
    res = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: h, payload: {} });
    const threadId = res.json().data.thread.id as string;

    // own skill
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: h,
      payload: { name: "S1", instructions: "Do the thing." },
    });
    const skillId = res.json().data.skill.id as string;

    // attach to project (built-in + own)
    const builtins = (await app.inject({ method: "GET", url: API_ROUTES.skills, headers: h })).json()
      .data.skills as Array<{ id: string }>;
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projectSkills(projectId),
      headers: h,
      payload: { skillId: builtins[0].id },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projectSkills(projectId),
      headers: h,
      payload: { skillId },
    });
    expect(res.statusCode).toBe(200);
    // idempotent re-attach
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projectSkills(projectId),
      headers: h,
      payload: { skillId },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: "GET", url: API_ROUTES.projectSkills(projectId), headers: h });
    expect(res.statusCode).toBe(200);
    expect((res.json().data.skills as Array<{ id: string }>).map((s) => s.id).sort()).toEqual(
      [builtins[0].id, skillId].sort(),
    );

    // detach
    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.projectSkill(projectId, skillId),
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.projectSkills(projectId), headers: h });
    expect((res.json().data.skills as unknown[]).length).toBe(1);

    // thread attach/detach
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.threadSkills(threadId),
      headers: h,
      payload: { skillId },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.threadSkills(threadId), headers: h });
    expect((res.json().data.skills as Array<{ id: string }>).map((s) => s.id)).toEqual([skillId]);
    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.threadSkill(threadId, skillId),
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.threadSkills(threadId), headers: h });
    expect((res.json().data.skills as unknown[]).length).toBe(0);

    // unknown skill -> 404; unknown project/thread -> 404
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projectSkills(projectId),
      headers: h,
      payload: { skillId: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projectSkills(randomUUID()),
      headers: h,
      payload: { skillId },
    });
    expect(res.statusCode).toBe(404);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.threadSkills(randomUUID()),
      headers: h,
      payload: { skillId },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("skills in chat system prompt", () => {
  it("appends attached skills after project instructions and before memory", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const captured: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(init?.body as string) as { system?: string };
      captured.push(body.system ?? "");
      return new Response(ANTHROPIC_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const { tokens, userId } = await signupVerifyLogin(email("sysprompt"));
    const h = authHeader(tokens.accessToken);

    // consent for the routed provider
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatConsent,
      headers: h,
      payload: { providerIds: ["anthropic"] },
    });
    expect([200, 201]).toContain(res.statusCode);

    // project with instructions
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      headers: h,
      payload: { title: "Proj", instructions: "PROJECT-INSTRUCTIONS-MARKER" },
    });
    const projectId = res.json().data.project.id as string;

    // thread on the project
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { projectId },
    });
    const threadId = res.json().data.thread.id as string;

    // attach a project skill and a thread skill (own skill + built-in)
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: h,
      payload: { name: "Zebra skill", instructions: "ZEBRA-INSTRUCTIONS-MARKER" },
    });
    const ownSkillId = res.json().data.skill.id as string;
    const builtins = (await app.inject({ method: "GET", url: API_ROUTES.skills, headers: h })).json()
      .data.skills as Array<{ id: string; name: string }>;
    const brandVoice = builtins.find((s) => s.name === "Brand voice")!;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projectSkills(projectId),
      headers: h,
      payload: { skillId: ownSkillId },
    });
    expect(res.statusCode).toBe(200);
    // attach the same skill to the thread too — it must appear only once
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.threadSkills(threadId),
      headers: h,
      payload: { skillId: ownSkillId },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.threadSkills(threadId),
      headers: h,
      payload: { skillId: brandVoice.id },
    });
    expect(res.statusCode).toBe(200);

    // a long-term memory, so the memory block is present
    await getPool().query("INSERT INTO user_memories (id, user_id, content) VALUES (gen_random_uuid(), $1, $2)", [
      userId,
      "MEMORY-CONTENT-MARKER",
    ]);

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    const system = captured[captured.length - 1];

    const projectIdx = system.indexOf("PROJECT-INSTRUCTIONS-MARKER");
    const skillsIdx = system.indexOf("[Skills in use:");
    const memoryIdx = system.indexOf("[What I remember about you:");
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    // contract order: project instructions, then skills, then memory
    expect(projectIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(memoryIdx);
    // deduped: the zebra skill attached twice appears once
    expect(system).toContain("ZEBRA-INSTRUCTIONS-MARKER");
    expect(system.match(/ZEBRA-INSTRUCTIONS-MARKER/g)!.length).toBe(1);
    expect(system).toContain("- Brand voice:");
  });

  it("no skills block when nothing is attached", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const captured: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(init?.body as string) as { system?: string };
      captured.push(body.system ?? "");
      return new Response(ANTHROPIC_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const { tokens } = await signupVerifyLogin(email("noskills"));
    const h = authHeader(tokens.accessToken);
    await app.inject({
      method: "POST",
      url: API_ROUTES.chatConsent,
      headers: h,
      payload: { providerIds: ["anthropic"] },
    });
    const res0 = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: h, payload: {} });
    const threadId = res0.json().data.thread.id as string;
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured[captured.length - 1]).not.toContain("[Skills in use:");
  });
});
