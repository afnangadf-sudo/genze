// Step 3 project tests: CRUD, validation, file attachment to projects,
// delete cascade (file rows + storage objects gone, thread project link nulled).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { getStorage } from "../src/storage/index.js";
import { authHeader, email, fixture, signupVerifyLogin, uploadFile } from "./helpers.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL=<redacted>
process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-2";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "genze-proj-test-"));

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

async function createProject(token: string, title: string, instructions = "") {
  return app.inject({
    method: "POST",
    url: API_ROUTES.projects,
    headers: authHeader(token),
    payload: { title, instructions },
  });
}

describe("project CRUD", () => {
  it("creates, reads, renames and edits instructions", async () => {
    const token = await signupVerifyLogin(app, email("crud"));
    let res = await createProject(token, "My research", "Answer briefly.");
    expect(res.statusCode).toBe(201);
    const created = res.json().data.project;
    expect(created.title).toBe("My research");
    expect(created.instructions).toBe("Answer briefly.");
    expect(created.fileCount).toBe(0);

    res = await app.inject({
      method: "GET",
      url: API_ROUTES.project(created.id),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.project(created.id),
      headers: authHeader(token),
      payload: { title: "Renamed", instructions: "Answer in detail." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.project.title).toBe("Renamed");
    expect(res.json().data.project.instructions).toBe("Answer in detail.");

    res = await app.inject({ method: "GET", url: API_ROUTES.projects, headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.projects).toHaveLength(1);
  });

  it("validates title and instructions", async () => {
    const token = await signupVerifyLogin(app, email("valid"));
    let res = await createProject(token, "   ");
    expect(res.statusCode).toBe(400);
    res = await createProject(token, "ok", "x".repeat(4001));
    expect(res.statusCode).toBe(400);

    res = await createProject(token, "fine");
    const id = res.json().data.project.id as string;
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.project(id),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.project(id),
      headers: authHeader(token),
      payload: { title: "x".repeat(81) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps projects private per user", async () => {
    const tokenA = await signupVerifyLogin(app, email("pa"));
    const tokenB = await signupVerifyLogin(app, email("pb"));
    const res = await createProject(tokenA, "secret");
    const id = res.json().data.project.id as string;
    const got = await app.inject({
      method: "GET",
      url: API_ROUTES.project(id),
      headers: authHeader(tokenB),
    });
    expect(got.statusCode).toBe(404);
  });
});

describe("project files + delete cascade", () => {
  it("attaches files to a project and counts them", async () => {
    const token = await signupVerifyLogin(app, email("pfiles"));
    const res = await createProject(token, "With files");
    const projectId = res.json().data.project.id as string;

    const up = await uploadFile(
      app,
      token,
      "hello.pdf",
      "application/pdf",
      await fixture("hello.pdf"),
      { projectId },
    );
    expect(up.statusCode).toBe(201);
    expect(up.json().data.file.projectId).toBe(projectId);

    const got = await app.inject({
      method: "GET",
      url: API_ROUTES.project(projectId),
      headers: authHeader(token),
    });
    expect(got.json().data.project.fileCount).toBe(1);

    const listed = await app.inject({
      method: "GET",
      url: `${API_ROUTES.files}?projectId=${projectId}`,
      headers: authHeader(token),
    });
    expect(listed.json().data.files).toHaveLength(1);
  });

  it("deleting a project removes its file rows and stored objects, and unlinks threads", async () => {
    const token = await signupVerifyLogin(app, email("pdel"));
    const res = await createProject(token, "Doomed");
    const projectId = res.json().data.project.id as string;
    const up = await uploadFile(
      app,
      token,
      "hello.pdf",
      "application/pdf",
      await fixture("hello.pdf"),
      { projectId },
    );
    const fileId = up.json().data.file.id as string;

    // Thread in the project.
    const th = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(token),
      payload: { projectId },
    });
    expect(th.statusCode).toBe(201);
    const threadId = th.json().data.thread.id as string;
    expect(th.json().data.thread.projectId).toBe(projectId);

    // Remember the storage key, then delete the project.
    const keyRow = await getPool().query<{ storage_key: string }>(
      "SELECT storage_key FROM files WHERE id = $1",
      [fileId],
    );
    const storageKey = keyRow.rows[0].storage_key;

    const del = await app.inject({
      method: "DELETE",
      url: API_ROUTES.project(projectId),
      headers: authHeader(token),
    });
    expect(del.statusCode).toBe(200);

    // File row gone…
    const filesLeft = await getPool().query("SELECT count(*) AS n FROM files WHERE id = $1", [fileId]);
    expect(Number(filesLeft.rows[0].n)).toBe(0);
    // …stored object gone…
    await expect(getStorage().get(storageKey)).rejects.toThrow();
    // …thread survives but loses the project link.
    const thAfter = await app.inject({
      method: "GET",
      url: API_ROUTES.chatThread(threadId),
      headers: authHeader(token),
    });
    expect(thAfter.statusCode).toBe(200);
    expect(thAfter.json().data.thread.projectId).toBeNull();
  });

  it("rejects threads for unknown or foreign projects", async () => {
    const tokenA = await signupVerifyLogin(app, email("tp-a"));
    const tokenB = await signupVerifyLogin(app, email("tp-b"));
    const res = await createProject(tokenA, "mine");
    const projectId = res.json().data.project.id as string;

    let th = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(tokenB),
      payload: { projectId },
    });
    expect(th.statusCode).toBe(404);

    th = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: authHeader(tokenA),
      payload: { projectId: "not-a-uuid" },
    });
    expect(th.statusCode).toBe(400);
  });
});
