// Chat polish tests: Gems (CRUD, ownership, built-ins, sharing, skill/file
// attach) + Guided Learning (tutor mode) + system-prefix ordering.
// Demo mode is exercised (provider keys unset), like quickwins.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { testEmailOutbox } from "../src/email.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { uploadFile } from "./helpers.js";
import { assembleSystemPrefix } from "../src/chat/systemPrompt.js";
import { buildGemBlock, type DbGem } from "../src/gems/service.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-2";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";
// Provider keys intentionally unset -> demo mode.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.FREE_AI_ENABLED = "false"; // restore zero-keys -> demo world
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await closeRedis();
});

const email = (tag: string) => `gem-${tag}-${randomUUID().slice(0, 8)}@example.com`;
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

function lastTokenFor(to: string): string {
  const found = [...testEmailOutbox].reverse().find((e) => e.to === to);
  expect(found).toBeDefined();
  const m = found!.text.match(/token=([0-9a-f]+)/);
  expect(m).toBeTruthy();
  return m![1];
}

async function signupVerifyLogin(em: string) {
  let res = await app.inject({
    method: "POST",
    url: API_ROUTES.signup,
    payload: { email: em, password: "password123", country: "PK" },
  });
  expect(res.statusCode).toBe(201);
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.verifyEmail,
    payload: { token: lastTokenFor(em) },
  });
  expect(res.statusCode).toBe(200);
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.login,
    payload: { email: em, password: "password123" },
  });
  expect(res.statusCode).toBe(200);
  const tokens = res.json().data.tokens as { accessToken: string };
  return { token: tokens.accessToken };
}

function sseEvents(payload: string): Array<Record<string, unknown>> {
  return payload
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice("data:".length).trim()) as Record<string, unknown>);
}

function sseText(res: { body: string }): string {
  return sseEvents(res.body)
    .filter((e) => e.type === "token")
    .map((e) => String(e.text))
    .join("");
}

const GEM_BODY = {
  name: "Test Gem",
  description: "A gem for tests",
  instructions: "Always answer in haiku.",
  starterPrompts: ["Write a haiku about rain"],
};

async function createGem(token: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: API_ROUTES.gems,
    headers: authHeader(token),
    payload: { ...GEM_BODY, ...body },
  });
}

// ---------- Gem CRUD + ownership ----------

describe("gems CRUD", () => {
  it("creates, reads, updates and deletes an owned gem", async () => {
    const { token } = await signupVerifyLogin(email("crud"));
    const h = authHeader(token);

    const created = await createGem(token);
    expect(created.statusCode).toBe(201);
    const gem = created.json().data.gem;
    expect(gem.name).toBe("Test Gem");
    expect(gem.instructions).toBe("Always answer in haiku.");
    expect(gem.starterPrompts).toEqual(["Write a haiku about rain"]);
    expect(gem.builtin).toBe(false);
    expect(gem.copiedFrom).toBeNull();
    expect(gem.shareUrl).toBeNull();
    // modelPreference is a hidden routing hint: never exposed in any response.
    expect(gem.modelPreference).toBeNull();

    const listed = await app.inject({ method: "GET", url: API_ROUTES.gems, headers: h });
    expect(listed.statusCode).toBe(200);
    const gems = listed.json().data.gems as Array<{ id: string; builtin: boolean }>;
    expect(gems.some((g) => g.id === gem.id)).toBe(true);

    const got = await app.inject({ method: "GET", url: API_ROUTES.gem(gem.id), headers: h });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.gem.name).toBe("Test Gem");

    const patched = await app.inject({
      method: "PATCH",
      url: API_ROUTES.gem(gem.id),
      headers: h,
      payload: { description: "Updated description" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.gem.description).toBe("Updated description");

    const deleted = await app.inject({ method: "DELETE", url: API_ROUTES.gem(gem.id), headers: h });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deleted).toBe(true);
    const gone = await app.inject({ method: "GET", url: API_ROUTES.gem(gem.id), headers: h });
    expect(gone.statusCode).toBe(404);
  });

  it("rejects invalid gem input with plain messages", async () => {
    const { token } = await signupVerifyLogin(email("crudval"));
    const bad: Array<Record<string, unknown>> = [
      { name: "", instructions: "x" },
      { name: "x".repeat(81), instructions: "x" },
      { name: "ok", instructions: "" },
      { name: "ok", instructions: "x".repeat(8001) },
      { name: "ok", instructions: "x", description: "d".repeat(501) },
      { name: "ok", instructions: "x", starterPrompts: ["a", "b", "c", "d", "e"] },
      { name: "ok", instructions: "x", starterPrompts: [""] },
      { name: "ok", instructions: "x", starterPrompts: ["y".repeat(201)] },
      { name: "ok", instructions: "x", modelPreference: "not-a-model" },
      { name: "ok", instructions: "x", modelPreference: 42 },
    ];
    for (const payload of bad) {
      const res = await createGem(token, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    // A valid catalog model id is accepted — and still never exposed back.
    const ok = await createGem(token, { modelPreference: "claude-haiku-5.5" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.gem.modelPreference).toBeNull();
  });

  it("keeps gems private between users (ownership)", async () => {
    const a = await signupVerifyLogin(email("own-a"));
    const b = await signupVerifyLogin(email("own-b"));
    const created = await createGem(a.token);
    const gem = created.json().data.gem;

    const cross = await app.inject({
      method: "GET",
      url: API_ROUTES.gem(gem.id),
      headers: authHeader(b.token),
    });
    expect(cross.statusCode).toBe(404);

    const crossPatch = await app.inject({
      method: "PATCH",
      url: API_ROUTES.gem(gem.id),
      headers: authHeader(b.token),
      payload: { name: "Hijacked" },
    });
    expect(crossPatch.statusCode).toBe(404);

    const crossDelete = await app.inject({
      method: "DELETE",
      url: API_ROUTES.gem(gem.id),
      headers: authHeader(b.token),
    });
    expect(crossDelete.statusCode).toBe(404);

    // The owner's gem is untouched.
    const still = await app.inject({
      method: "GET",
      url: API_ROUTES.gem(gem.id),
      headers: authHeader(a.token),
    });
    expect(still.json().data.gem.name).toBe("Test Gem");
  });
});

// ---------- Built-in gems ----------

describe("built-in gems", () => {
  it("lists the three seeded built-ins as read-only", async () => {
    const { token } = await signupVerifyLogin(email("builtin"));
    const h = authHeader(token);
    const listed = await app.inject({ method: "GET", url: API_ROUTES.gems, headers: h });
    expect(listed.statusCode).toBe(200);
    const gems = listed.json().data.gems as Array<{ id: string; name: string; builtin: boolean }>;
    const builtins = gems.filter((g) => g.builtin);
    expect(builtins).toHaveLength(3);
    // Built-ins sort first.
    expect(gems[0].builtin).toBe(true);
    expect(gems[1].builtin).toBe(true);
    expect(gems[2].builtin).toBe(true);
    expect(builtins.map((g) => g.name).sort()).toEqual(
      ["Code Reviewer", "Email Drafter", "Study Buddy"],
    );
    const studyBuddy = builtins.find((g) => g.name === "Study Buddy")!;
    expect(studyBuddy.id).toBe("b1b2c3d4-0000-4000-8000-000000000001");

    // PATCH / DELETE → 403.
    const patch = await app.inject({
      method: "PATCH",
      url: API_ROUTES.gem(studyBuddy.id),
      headers: h,
      payload: { name: "Changed" },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.code).toBe("FORBIDDEN");

    const del = await app.inject({ method: "DELETE", url: API_ROUTES.gem(studyBuddy.id), headers: h });
    expect(del.statusCode).toBe(403);

    // Attach → 403.
    const skill = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: h,
      payload: { name: "S", instructions: "Do things." },
    });
    const skillId = skill.json().data.skill.id as string;
    const attach = await app.inject({
      method: "POST",
      url: API_ROUTES.gemSkills(studyBuddy.id),
      headers: h,
      payload: { skillId },
    });
    expect(attach.statusCode).toBe(403);

    const up = await uploadFile(app, token, "note.csv", "text/csv", Buffer.from("a,b\n1,2\n"));
    expect(up.statusCode).toBe(201);
    const fileId = up.json().data.file.id as string;
    const attachFile = await app.inject({
      method: "POST",
      url: API_ROUTES.gemFiles(studyBuddy.id),
      headers: h,
      payload: { fileId },
    });
    expect(attachFile.statusCode).toBe(403);

    // Share on a built-in → 400 with a plain message.
    const share = await app.inject({
      method: "POST",
      url: API_ROUTES.gemShare(studyBuddy.id),
      headers: h,
    });
    expect(share.statusCode).toBe(400);
    expect(share.json().error.message).toBe("Built-in Gems are already available to everyone.");
  });
});

// ---------- Sharing ----------

describe("gem sharing", () => {
  it("shares, clones, and revokes with independent copies", async () => {
    const a = await signupVerifyLogin(email("share-a"));
    const b = await signupVerifyLogin(email("share-b"));
    const ha = authHeader(a.token);
    const hb = authHeader(b.token);

    const created = await createGem(a.token, {
      name: "Shared Gem",
      instructions: "Original instructions.",
    });
    const gem = created.json().data.gem;

    // Share → shareUrl; idempotent (second call returns the same link).
    const share1 = await app.inject({ method: "POST", url: API_ROUTES.gemShare(gem.id), headers: ha });
    expect(share1.statusCode).toBe(200);
    const shareUrl = share1.json().data.shareUrl as string;
    expect(shareUrl).toContain("/gems/shared/");
    const token = shareUrl.split("/gems/shared/")[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const share2 = await app.inject({ method: "POST", url: API_ROUTES.gemShare(gem.id), headers: ha });
    expect(share2.json().data.shareUrl).toBe(shareUrl);

    // Second user clones via the link.
    const clone = await app.inject({
      method: "POST",
      url: API_ROUTES.gemSharedClone(token),
      headers: hb,
    });
    expect(clone.statusCode).toBe(201);
    const copy = clone.json().data.gem;
    expect(copy.id).not.toBe(gem.id);
    expect(copy.name).toBe("Shared Gem");
    expect(copy.instructions).toBe("Original instructions.");
    expect(copy.copiedFrom).toBe("Shared Gem");
    expect(copy.builtin).toBe(false);
    expect(copy.modelPreference).toBeNull();

    // Attach a skill+file to the original — the clone must NOT carry them.
    const skill = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: ha,
      payload: { name: "Orig skill", instructions: "Orig instructions." },
    });
    const skillId = skill.json().data.skill.id as string;
    await app.inject({
      method: "POST",
      url: API_ROUTES.gemSkills(gem.id),
      headers: ha,
      payload: { skillId },
    });
    const up = await uploadFile(app, a.token, "orig.csv", "text/csv", Buffer.from("x,y\n3,4\n"));
    const fileId = up.json().data.file.id as string;
    await app.inject({
      method: "POST",
      url: API_ROUTES.gemFiles(gem.id),
      headers: ha,
      payload: { fileId },
    });
    const copySkills = await app.inject({
      method: "GET",
      url: API_ROUTES.gemSkills(copy.id),
      headers: hb,
    });
    expect(copySkills.json().data.skills).toHaveLength(0);
    const copyFiles = await app.inject({ method: "GET", url: API_ROUTES.gemFiles(copy.id), headers: hb });
    expect(copyFiles.json().data.files).toHaveLength(0);

    // Editing the original leaves the copy unchanged.
    await app.inject({
      method: "PATCH",
      url: API_ROUTES.gem(gem.id),
      headers: ha,
      payload: { name: "Renamed Original", instructions: "Changed." },
    });
    const copyAfter = await app.inject({ method: "GET", url: API_ROUTES.gem(copy.id), headers: hb });
    expect(copyAfter.json().data.gem.name).toBe("Shared Gem");
    expect(copyAfter.json().data.gem.instructions).toBe("Original instructions.");

    // Revoke → the old link 404s with a plain message; the copy still works.
    const revoke = await app.inject({ method: "DELETE", url: API_ROUTES.gemShare(gem.id), headers: ha });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data.revoked).toBe(true);
    const dead = await app.inject({
      method: "POST",
      url: API_ROUTES.gemSharedClone(token),
      headers: hb,
    });
    expect(dead.statusCode).toBe(404);
    expect(dead.json().error.message).toBe("This share link doesn't work anymore.");
    const copyStill = await app.inject({ method: "GET", url: API_ROUTES.gem(copy.id), headers: hb });
    expect(copyStill.statusCode).toBe(200);
  });

  it("refuses to clone your own gem via its link, and 404s unknown tokens", async () => {
    const { token } = await signupVerifyLogin(email("share-self"));
    const h = authHeader(token);
    const created = await createGem(token);
    const gem = created.json().data.gem;
    const share = await app.inject({ method: "POST", url: API_ROUTES.gemShare(gem.id), headers: h });
    const shareToken = (share.json().data.shareUrl as string).split("/gems/shared/")[1];

    const self = await app.inject({
      method: "POST",
      url: API_ROUTES.gemSharedClone(shareToken),
      headers: h,
    });
    expect(self.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "POST",
      url: API_ROUTES.gemSharedClone("0".repeat(64)),
      headers: h,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe("This share link doesn't work anymore.");
  });

  it("does not let another user share or revoke your gem", async () => {
    const a = await signupVerifyLogin(email("share-x-a"));
    const b = await signupVerifyLogin(email("share-x-b"));
    const created = await createGem(a.token);
    const gem = created.json().data.gem;
    const crossShare = await app.inject({
      method: "POST",
      url: API_ROUTES.gemShare(gem.id),
      headers: authHeader(b.token),
    });
    expect(crossShare.statusCode).toBe(404);
    const crossRevoke = await app.inject({
      method: "DELETE",
      url: API_ROUTES.gemShare(gem.id),
      headers: authHeader(b.token),
    });
    expect(crossRevoke.statusCode).toBe(404);
  });
});

// ---------- Skill + file attach ----------

describe("gem skill/file attach", () => {
  it("attaches and detaches skills and files; validates ownership", async () => {
    const a = await signupVerifyLogin(email("att-a"));
    const b = await signupVerifyLogin(email("att-b"));
    const ha = authHeader(a.token);
    const hb = authHeader(b.token);

    const created = await createGem(a.token);
    const gem = created.json().data.gem;

    // Skill attach / list / detach.
    const skill = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: ha,
      payload: { name: "Gem skill", instructions: "Follow these steps." },
    });
    const skillId = skill.json().data.skill.id as string;
    const attached = await app.inject({
      method: "POST",
      url: API_ROUTES.gemSkills(gem.id),
      headers: ha,
      payload: { skillId },
    });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().data.attached).toBe(true);
    const listed = await app.inject({ method: "GET", url: API_ROUTES.gemSkills(gem.id), headers: ha });
    expect(listed.json().data.skills.map((s: { id: string }) => s.id)).toEqual([skillId]);
    const detached = await app.inject({
      method: "DELETE",
      url: API_ROUTES.gemSkill(gem.id, skillId),
      headers: ha,
    });
    expect(detached.statusCode).toBe(200);
    const afterDetach = await app.inject({
      method: "GET",
      url: API_ROUTES.gemSkills(gem.id),
      headers: ha,
    });
    expect(afterDetach.json().data.skills).toHaveLength(0);

    // Other user's skill → 400.
    const otherSkill = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: hb,
      payload: { name: "B skill", instructions: "B instructions." },
    });
    const otherSkillId = otherSkill.json().data.skill.id as string;
    const crossSkill = await app.inject({
      method: "POST",
      url: API_ROUTES.gemSkills(gem.id),
      headers: ha,
      payload: { skillId: otherSkillId },
    });
    expect(crossSkill.statusCode).toBe(400);

    // File attach / list / detach (metadata only).
    const up = await uploadFile(app, a.token, "data.csv", "text/csv", Buffer.from("h1,h2\nv1,v2\n"));
    expect(up.statusCode).toBe(201);
    const fileId = up.json().data.file.id as string;
    const fAttached = await app.inject({
      method: "POST",
      url: API_ROUTES.gemFiles(gem.id),
      headers: ha,
      payload: { fileId },
    });
    expect(fAttached.statusCode).toBe(200);
    const fListed = await app.inject({ method: "GET", url: API_ROUTES.gemFiles(gem.id), headers: ha });
    const files = fListed.json().data.files as Array<{ id: string; extractedText?: string }>;
    expect(files.map((f) => f.id)).toEqual([fileId]);
    expect(files[0].extractedText).toBeUndefined(); // metadata only
    const fDetached = await app.inject({
      method: "DELETE",
      url: API_ROUTES.gemFile(gem.id, fileId),
      headers: ha,
    });
    expect(fDetached.statusCode).toBe(200);
    const fAfter = await app.inject({ method: "GET", url: API_ROUTES.gemFiles(gem.id), headers: ha });
    expect(fAfter.json().data.files).toHaveLength(0);

    // Other user's file → 400.
    const upB = await uploadFile(app, b.token, "b.csv", "text/csv", Buffer.from("q\n1\n"));
    const bFileId = upB.json().data.file.id as string;
    const crossFile = await app.inject({
      method: "POST",
      url: API_ROUTES.gemFiles(gem.id),
      headers: ha,
      payload: { fileId: bFileId },
    });
    expect(crossFile.statusCode).toBe(400);
  });

  it("validates skillIds/fileIds on gem create", async () => {
    const a = await signupVerifyLogin(email("att-c-a"));
    const b = await signupVerifyLogin(email("att-c-b"));
    const hb = authHeader(b.token);

    const otherSkill = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: hb,
      payload: { name: "Other", instructions: "Other instructions." },
    });
    const badSkill = await createGem(a.token, {
      skillIds: [otherSkill.json().data.skill.id],
    });
    expect(badSkill.statusCode).toBe(400);

    const upB = await uploadFile(app, b.token, "c.csv", "text/csv", Buffer.from("z\n9\n"));
    const badFile = await createGem(a.token, { fileIds: [upB.json().data.file.id] });
    expect(badFile.statusCode).toBe(400);

    // Own ones are accepted at create time.
    const { token: ta } = a;
    const skill = await app.inject({
      method: "POST",
      url: API_ROUTES.skills,
      headers: authHeader(ta),
      payload: { name: "Mine", instructions: "Mine instructions." },
    });
    const up = await uploadFile(app, ta, "mine.csv", "text/csv", Buffer.from("m\n5\n"));
    const ok = await createGem(ta, {
      skillIds: [skill.json().data.skill.id],
      fileIds: [up.json().data.file.id],
    });
    expect(ok.statusCode).toBe(201);
    const gem = ok.json().data.gem;
    const skills = await app.inject({
      method: "GET",
      url: API_ROUTES.gemSkills(gem.id),
      headers: authHeader(ta),
    });
    expect(skills.json().data.skills).toHaveLength(1);
    const files = await app.inject({
      method: "GET",
      url: API_ROUTES.gemFiles(gem.id),
      headers: authHeader(ta),
    });
    expect(files.json().data.files).toHaveLength(1);
  });
});

// ---------- Unit: prefix order + gem block ----------

describe("assembleSystemPrefix", () => {
  it("orders blocks project → gem → skills → tutor → memory and skips empties", () => {
    const out = assembleSystemPrefix({
      projectInstructions: "PROJECT",
      gem: "GEM",
      skills: "SKILLS",
      tutor: "TUTOR",
      memory: "MEMORY",
    });
    expect(out).toBe("PROJECT\n\nGEM\n\nSKILLS\n\nTUTOR\n\nMEMORY");
    expect(out.indexOf("PROJECT")).toBeLessThan(out.indexOf("GEM"));
    expect(out.indexOf("GEM")).toBeLessThan(out.indexOf("SKILLS"));
    expect(out.indexOf("SKILLS")).toBeLessThan(out.indexOf("TUTOR"));
    expect(out.indexOf("TUTOR")).toBeLessThan(out.indexOf("MEMORY"));

    const sparse = assembleSystemPrefix({ gem: "GEM", memory: "MEMORY" });
    expect(sparse).toBe("GEM\n\nMEMORY");

    expect(assembleSystemPrefix({})).toBe("");
    expect(assembleSystemPrefix({ projectInstructions: "", skills: "" })).toBe("");
  });

  it("carries the gem block through to the final prompt", () => {
    const fake = {
      name: "Haiku Helper",
      instructions: "Always answer in haiku.",
    } as DbGem;
    const block = buildGemBlock(fake);
    expect(block).toBe('[Assistant "Haiku Helper":\nAlways answer in haiku.]');
    const out = assembleSystemPrefix({ projectInstructions: "PROJ", gem: block, skills: "SK" });
    expect(out).toContain("Always answer in haiku.");
    // Empty instructions → no block at all.
    expect(buildGemBlock({ name: "X", instructions: "   " } as DbGem)).toBe("");
  });
});

// ---------- Thread flow: gem + tutor ----------

describe("chat integration: gem + tutor mode", () => {
  it("creates a thread with a gem, toggles tutor mode, streams guided replies", async () => {
    const { token } = await signupVerifyLogin(email("flow"));
    const h = authHeader(token);

    const created = await createGem(token, { name: "Flow Gem", instructions: "Answer like a pirate." });
    const gem = created.json().data.gem;

    // Create with gemId.
    const threadRes = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { gemId: gem.id },
    });
    expect(threadRes.statusCode).toBe(201);
    const thread = threadRes.json().data.thread;
    expect(thread.gemId).toBe(gem.id);
    expect(thread.tutorMode).toBe(false);

    const got = await app.inject({ method: "GET", url: API_ROUTES.chatThread(thread.id), headers: h });
    expect(got.json().data.thread.gemId).toBe(gem.id);

    // Unknown gem → 400.
    const badThread = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { gemId: randomUUID() },
    });
    expect(badThread.statusCode).toBe(400);

    // Tutor on → guided demo reply (a question, never the canned answer).
    const on = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(thread.id),
      headers: h,
      payload: { tutorMode: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().data.thread.tutorMode).toBe(true);

    const guided = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(thread.id),
      headers: h,
      payload: { content: "why is the sky blue" },
    });
    expect(guided.statusCode).toBe(200);
    const guidedText = sseText(guided);
    expect(guidedText).toContain("?");
    expect(guidedText).not.toContain("This is a demo answer from Genze");
    const start = sseEvents(guided.body)[0];
    expect(start.demo).toBe(true);

    // Tutor off → canned direct answer returns.
    await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(thread.id),
      headers: h,
      payload: { tutorMode: false },
    });
    const direct = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(thread.id),
      headers: h,
      payload: { content: "why is the sky blue" },
    });
    expect(sseText(direct)).toContain("This is a demo answer from Genze");

    // Non-boolean tutorMode → 400; empty patch → 400 (rule unchanged).
    const badTutor = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(thread.id),
      headers: h,
      payload: { tutorMode: "yes" },
    });
    expect(badTutor.statusCode).toBe(400);
    const empty = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(thread.id),
      headers: h,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    // Detach the gem.
    const cleared = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(thread.id),
      headers: h,
      payload: { gemId: null },
    });
    expect(cleared.json().data.thread.gemId).toBeNull();
  });

  it("rejects another user's gem on thread create/patch", async () => {
    const a = await signupVerifyLogin(email("flow-a"));
    const b = await signupVerifyLogin(email("flow-b"));
    const created = await createGem(a.token);
    const gem = created.json().data.gem;

    const badCreate = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(b.token),
      payload: { gemId: gem.id },
    });
    expect(badCreate.statusCode).toBe(400);

    const threadRes = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(b.token),
      payload: {},
    });
    const threadId = threadRes.json().data.thread.id as string;
    const badPatch = await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: authHeader(b.token),
      payload: { gemId: gem.id },
    });
    expect(badPatch.statusCode).toBe(400);
  });

  it("applies the tutor overlay in lockdown too", async () => {
    const { token } = await signupVerifyLogin(email("flow-lock"));
    const h = authHeader(token);
    const threadRes = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: {},
    });
    const threadId = threadRes.json().data.thread.id as string;
    await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: true, tutorMode: true },
    });
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "teach me fractions" },
    });
    expect(res.statusCode).toBe(200);
    const text = sseText(res);
    expect(text).toContain("?");
    expect(text).not.toContain("This is a demo answer from Genze");
    // Metering still records the lockdown flag.
    const row = await getPool().query<{ details: { lockdown: boolean } }>(
      "SELECT details FROM usage_events WHERE feature = 'chat' ORDER BY created_at DESC LIMIT 1",
    );
    expect(row.rows[0].details.lockdown).toBe(true);
  });
});

// ---------- Temporary chat + tutor ----------

describe("temporary chat tutor", () => {
  const payload = (extra: Record<string, unknown> = {}) => ({
    messages: [{ role: "user", content: "what is photosynthesis" }],
    ...extra,
  });

  it("streams a guided reply with tutor:true and persists nothing", async () => {
    const { token } = await signupVerifyLogin(email("temp-tutor"));
    const h = authHeader(token);

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: payload({ tutor: true }),
    });
    expect(res.statusCode).toBe(200);
    const text = sseText(res);
    expect(text).toContain("?");
    expect(text).not.toContain("This is a demo answer from Genze");
    expect(sseEvents(res.body)[0].threadId).toBe("temporary");

    // Without tutor → the canned direct answer.
    const plain = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: payload(),
    });
    expect(sseText(plain)).toContain("This is a demo answer from Genze");

    // Nothing persisted.
    const threads = await getPool().query(
      "SELECT count(*) AS n FROM chat_threads WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gem-temp-tutor-%')",
    );
    expect(Number(threads.rows[0].n)).toBe(0);
  });

  it("rejects non-boolean tutor with 400", async () => {
    const { token } = await signupVerifyLogin(email("temp-tutor-bad"));
    const h = authHeader(token);
    for (const tutor of ["yes", 1, null, {}]) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.chatTempMessages,
        headers: h,
        payload: payload({ tutor }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });
});
