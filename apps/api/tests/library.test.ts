// Step 3 library tests: unified search across projects/chats/files,
// recent-items listing, and delete-by-type with cascades.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { API_ROUTES, type LibraryGroup } from "@genze/shared";
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
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "genze-lib-test-"));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

let app: FastifyInstance;

beforeAll(async () => {
  process.env.FREE_AI_ENABLED = "false"; // restore zero-keys -> demo world
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await closeRedis();
  rmSync(process.env.STORAGE_DIR as string, { recursive: true, force: true });
});

function groupsOf(res: { json(): { data: { groups: LibraryGroup[] } } }): Record<string, LibraryGroup> {
  const out: Record<string, LibraryGroup> = {};
  for (const g of res.json().data.groups) out[g.type] = g;
  return out;
}

/** Seed one project, one chat thread with a message, and one file. */
async function seed(token: string) {
  let res = await app.inject({
    method: "POST",
    url: API_ROUTES.projects,
    headers: authHeader(token),
    payload: { title: "Quicksilver notes", instructions: "fox facts and quick summaries" },
  });
  const projectId = res.json().data.project.id as string;

  res = await app.inject({
    method: "POST",
    url: API_ROUTES.chatThreads,
    headers: authHeader(token),
    payload: { title: "fox chat" },
  });
  const threadId = res.json().data.thread.id as string;
  // Demo mode: no provider keys -> streams a canned reply, no consent needed.
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.chatMessages(threadId),
    headers: authHeader(token),
    payload: { content: "tell me a quick story about a fox" },
  });
  expect(res.statusCode).toBe(200);

  const up = await uploadFile(app, token, "hello.pdf", "application/pdf", await fixture("hello.pdf"));
  const fileId = up.json().data.file.id as string;
  return { projectId, threadId, fileId };
}

describe("library search", () => {
  it("finds content across projects, chats and files", async () => {
    const token = await signupVerifyLogin(app, email("search"));
    const { projectId, threadId, fileId } = await seed(token);

    const res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.library}?q=${encodeURIComponent("quick")}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const g = groupsOf(res);

    // All eight groups exist; later-step groups are empty stubs.
    expect(Object.keys(g).sort()).toEqual([
      "agent-task",
      "audio",
      "chat",
      "file",
      "image",
      "project",
      "report",
      "video",
    ]);
    expect(g["report"].items).toHaveLength(0);
    expect(g["video"].items).toHaveLength(0);
    expect(g["agent-task"].items).toHaveLength(0);
    expect(g["image"].items).toHaveLength(0);
    expect(g["audio"].items).toHaveLength(0);

    expect(g["project"].items.map((i) => i.id)).toContain(projectId);
    expect(g["chat"].items.map((i) => i.id)).toContain(threadId);
    expect(g["file"].items.map((i) => i.id)).toContain(fileId);
  });

  it("matches inside extracted file text via full-text search", async () => {
    const token = await signupVerifyLogin(app, email("fts"));
    const { fileId } = await seed(token);
    const res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.library}?q=${encodeURIComponent("brown fox")}`,
      headers: authHeader(token),
    });
    const g = groupsOf(res);
    expect(g["file"].items.map((i) => i.id)).toContain(fileId);
  });

  it("lists recent items per group when no query is given", async () => {
    const token = await signupVerifyLogin(app, email("recent"));
    const { projectId, threadId, fileId } = await seed(token);
    const res = await app.inject({ method: "GET", url: API_ROUTES.library, headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    const g = groupsOf(res);
    expect(g["project"].items.map((i) => i.id)).toContain(projectId);
    expect(g["chat"].items.map((i) => i.id)).toContain(threadId);
    expect(g["file"].items.map((i) => i.id)).toContain(fileId);
    for (const group of Object.values(g)) {
      expect(group.items.length).toBeLessThanOrEqual(5);
    }
  });

  it("does not leak other users' items", async () => {
    const tokenA = await signupVerifyLogin(app, email("leak-a"));
    const tokenB = await signupVerifyLogin(app, email("leak-b"));
    await seed(tokenA);
    const res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.library}?q=${encodeURIComponent("quick")}`,
      headers: authHeader(tokenB),
    });
    const g = groupsOf(res);
    expect(g["project"].items).toHaveLength(0);
    expect(g["chat"].items).toHaveLength(0);
    expect(g["file"].items).toHaveLength(0);
  });
});

describe("library delete", () => {
  it("deletes a file with its stored object", async () => {
    const token = await signupVerifyLogin(app, email("ldel-f"));
    const { fileId } = await seed(token);
    const res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.libraryItem("file", fileId),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const left = await getPool().query("SELECT count(*) AS n FROM files WHERE id = $1", [fileId]);
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it("deletes a chat with its messages", async () => {
    const token = await signupVerifyLogin(app, email("ldel-c"));
    const { threadId } = await seed(token);
    const res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.libraryItem("chat", threadId),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const msgs = await getPool().query("SELECT count(*) AS n FROM chat_messages WHERE thread_id = $1", [
      threadId,
    ]);
    expect(Number(msgs.rows[0].n)).toBe(0);
  });

  it("deletes a project with its files", async () => {
    const token = await signupVerifyLogin(app, email("ldel-p"));
    const { projectId } = await seed(token);
    const res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.libraryItem("project", projectId),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const left = await getPool().query("SELECT count(*) AS n FROM projects WHERE id = $1", [projectId]);
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it("404s for unknown types and foreign items", async () => {
    const token = await signupVerifyLogin(app, email("ldel-x"));
    let res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.libraryItem("video", "00000000-0000-0000-0000-000000000000"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.libraryItem("file", "00000000-0000-0000-0000-000000000000"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});
