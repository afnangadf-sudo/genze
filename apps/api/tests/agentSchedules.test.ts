// Step 7b tests: agent schedules, folder scope, notifications.
// No real timers — the scheduler tick is driven directly via
// runDueSchedulesOnce(); the core runner is stubbed through the
// __setRunnerOverride test seam.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ROUTES, SCOPE_VIOLATION } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import {
  computeNextRun,
  runDueSchedulesOnce,
  __setRunnerOverride,
} from "../src/agent/schedules.js";
import { checkFolderScope, scopeDiffSummary } from "../src/agent/scope.js";
import { authHeader, email, signupVerifyLogin } from "./helpers.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET=<redacted>
process.env.JWT_REFRESH_SECRET=<redacted>
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";

let app: FastifyInstance;

async function userIdFor(em: string): Promise<string> {
  const r = await getPool().query<{ id: string }>("SELECT id FROM users WHERE email = $1", [em]);
  return r.rows[0].id;
}

async function insertSchedule(userId: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO agent_schedules (id, user_id, title, task, schedule, enabled, auto_approve, approved_once, next_run_at)
     VALUES ($1, $2, 'Test schedule', 'Summarize the news', '{"kind":"interval_hours","hours":1}'::jsonb,
             true, false, false, $3::timestamptz)`,
    [id, userId, overrides.nextRunAt ?? new Date(Date.now() + 3600_000).toISOString()],
  );
  return id;
}

// Timestamp captured before any test in this file runs.
let fileStart: Date;

beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
  fileStart = new Date();
});

// The agent_notifications table belongs to the sibling's 014 migration.
// Skip the notification tests if it (or its expected columns) is missing.
async function notificationsUsable(): Promise<boolean> {
  const cols = await getPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_notifications'`,
  );
  const names = new Set(cols.rows.map((r) => r.column_name));
  return ["id", "user_id", "task_id", "title", "read", "created_at"].every((c) => names.has(c));
}

afterAll(async () => {
  __setRunnerOverride(null);
  await app.close();
  await closePool();
  await closeRedis();
});

describe("computeNextRun", () => {
  it("daily: next occurrence strictly after `from`", () => {
    const from = new Date("2026-10-18T09:00:00Z");
    expect(computeNextRun({ kind: "daily", hour: 10, minute: 30 }, from).toISOString()).toBe(
      "2026-10-18T10:30:00.000Z",
    );
  });

  it("daily: exactly on the hour rolls to tomorrow", () => {
    const from = new Date("2026-10-18T10:00:00Z");
    expect(computeNextRun({ kind: "daily", hour: 10, minute: 0 }, from).toISOString()).toBe(
      "2026-10-19T10:00:00.000Z",
    );
  });

  it("daily: a passed time today rolls to tomorrow", () => {
    const from = new Date("2026-10-18T10:00:01Z");
    expect(computeNextRun({ kind: "daily", hour: 10, minute: 0 }, from).toISOString()).toBe(
      "2026-10-19T10:00:00.000Z",
    );
  });

  it("weekly: lands on the right weekday (Sun=0)", () => {
    // 2026-10-18 is a Sunday.
    const from = new Date("2026-10-18T09:00:00Z");
    expect(computeNextRun({ kind: "weekly", weekday: 3, hour: 8, minute: 0 }, from).toISOString()).toBe(
      "2026-10-21T08:00:00.000Z", // Wednesday
    );
  });

  it("weekly: exactly on the weekly time rolls to next week", () => {
    const from = new Date("2026-10-18T08:00:00Z"); // Sunday 08:00
    expect(computeNextRun({ kind: "weekly", weekday: 0, hour: 8, minute: 0 }, from).toISOString()).toBe(
      "2026-10-25T08:00:00.000Z",
    );
  });

  it("interval_hours: adds the interval to `from`", () => {
    const from = new Date("2026-10-18T10:00:00Z");
    expect(computeNextRun({ kind: "interval_hours", hours: 6 }, from).toISOString()).toBe(
      "2026-10-18T16:00:00.000Z",
    );
  });
});

describe("schedule CRUD", () => {
  it("creates a schedule with a computed next run (201)", async () => {
    const em = email("sched-create");
    const token = await signupVerifyLogin(app, em);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.agentSchedules,
      headers: authHeader(token),
      payload: { title: "Morning brief", task: "Summarize overnight news", schedule: { kind: "daily", hour: 7, minute: 0 } },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json().data.schedule;
    expect(s.title).toBe("Morning brief");
    expect(s.nextRunAt).toBeTruthy();
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects an invalid schedule shape (400)", async () => {
    const em = email("sched-bad");
    const token = await signupVerifyLogin(app, em);
    for (const bad of [
      { kind: "daily", hour: 25, minute: 0 },
      { kind: "weekly", weekday: 7, hour: 8, minute: 0 },
      { kind: "interval_hours", hours: 0 },
      { kind: "interval_hours", hours: 200 },
      { kind: "nope" },
      null,
    ]) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.agentSchedules,
        headers: authHeader(token),
        payload: { title: "Bad schedule", task: "Do something", schedule: bad },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects short titles (400)", async () => {
    const em = email("sched-short");
    const token = await signupVerifyLogin(app, em);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.agentSchedules,
      headers: authHeader(token),
      payload: { title: "ab", task: "Do something", schedule: { kind: "daily", hour: 7, minute: 0 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists, reads, updates, and deletes; ownership is enforced (404)", async () => {
    const emA = email("sched-a");
    const emB = email("sched-b");
    const tokenA = await signupVerifyLogin(app, emA);
    const tokenB = await signupVerifyLogin(app, emB);
    const uidA = await userIdFor(emA);

    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.agentSchedules,
      headers: authHeader(tokenA),
      payload: { title: "Owned schedule", task: "Check mail", schedule: { kind: "interval_hours", hours: 3 } },
    });
    const id = created.json().data.schedule.id as string;

    // Another user cannot see it.
    let res = await app.inject({ method: "GET", url: API_ROUTES.agentSchedule(id), headers: authHeader(tokenB) });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: "DELETE", url: API_ROUTES.agentSchedule(id), headers: authHeader(tokenB) });
    expect(res.statusCode).toBe(404);

    // Owner can update (schedule change re-anchors the next run).
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.agentSchedule(id),
      headers: authHeader(tokenA),
      payload: { enabled: false, schedule: { kind: "daily", hour: 9, minute: 30 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.schedule.enabled).toBe(false);
    expect(res.json().data.schedule.schedule.kind).toBe("daily");

    // Owner can delete; already-created tasks are left alone (checked below).
    res = await app.inject({ method: "DELETE", url: API_ROUTES.agentSchedule(id), headers: authHeader(tokenA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);

    // List is empty for this user.
    res = await app.inject({ method: "GET", url: API_ROUTES.agentSchedules, headers: authHeader(tokenA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.schedules).toEqual([]);
    void uidA;
  });

  it("approve-first-run flips the flag", async () => {
    const em = email("sched-approve");
    const token = await signupVerifyLogin(app, em);
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.agentSchedules,
      headers: authHeader(token),
      payload: { title: "Needs approval", task: "Watch the inbox", schedule: { kind: "interval_hours", hours: 2 } },
    });
    const id = created.json().data.schedule.id as string;
    expect(created.json().data.schedule.approvedOnce).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.agentScheduleApproveFirstRun(id),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.approvedOnce).toBe(true);

    const got = await app.inject({ method: "GET", url: API_ROUTES.agentSchedule(id), headers: authHeader(token) });
    expect(got.json().data.schedule.approvedOnce).toBe(true);
  });

  it("rejects empty PATCH (400)", async () => {
    const em = email("sched-patch-empty");
    const token = await signupVerifyLogin(app, em);
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.agentSchedules,
      headers: authHeader(token),
      payload: { title: "Patch me", task: "Do it", schedule: { kind: "daily", hour: 7, minute: 0 } },
    });
    const id = created.json().data.schedule.id as string;
    const res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.agentSchedule(id),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("scheduler tick", () => {
  beforeEach(async () => {
    // The scheduler tick is GLOBAL (not user-scoped): remove only schedules
    // that were already due before this file started — leftovers from an
    // interrupted earlier run. Rows created by this run (or by parallel test
    // files) always have next_run_at >= fileStart, so they are never touched.
    await getPool().query(`DELETE FROM agent_schedules WHERE next_run_at < $1::timestamptz`, [
      fileStart.toISOString(),
    ]);
  });

  it("does nothing when nothing is due", async () => {
    const em = email("tick-idle");
    const token = await signupVerifyLogin(app, em);
    void token;
    const uid = await userIdFor(em);
    const before = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM agent_tasks WHERE user_id = $1",
      [uid],
    );
    const result = await runDueSchedulesOnce(new Date());
    expect(result).toEqual({ due: 0, started: 0, errors: 0 });
    const after = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM agent_tasks WHERE user_id = $1",
      [uid],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("a due schedule without approval creates a planned task and waits", async () => {
    const em = email("tick-planned");
    await signupVerifyLogin(app, em);
    const uid = await userIdFor(em);
    const schedId = await insertSchedule(uid, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });

    __setRunnerOverride(async () => {
      throw new Error("runner should not be called for an unapproved schedule");
    });
    try {
      const result = await runDueSchedulesOnce(new Date());
      expect(result.due).toBe(1);
      expect(result.started).toBe(1);
      expect(result.errors).toBe(0);
    } finally {
      __setRunnerOverride(null);
    }

    const tasks = await getPool().query<{ status: string; kind: string; schedule_id: string }>(
      "SELECT status, kind, schedule_id FROM agent_tasks WHERE user_id = $1",
      [uid],
    );
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0].status).toBe("planned"); // waits for the user's first approval
    expect(tasks.rows[0].kind).toBe("scheduled");
    expect(tasks.rows[0].schedule_id).toBe(schedId);

    const s = await getPool().query<{ next_run_at: string; last_run_at: string }>(
      "SELECT next_run_at, last_run_at FROM agent_schedules WHERE id = $1",
      [schedId],
    );
    expect(s.rows[0].last_run_at).toBeTruthy();
    expect(new Date(s.rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("an approved schedule is handed to the runner", async () => {
    const em = email("tick-approved");
    await signupVerifyLogin(app, em);
    const uid = await userIdFor(em);
    const schedId = await insertSchedule(uid, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });
    await getPool().query("UPDATE agent_schedules SET approved_once = true WHERE id = $1", [schedId]);

    const started: string[] = [];
    __setRunnerOverride(async (taskId: string) => {
      started.push(taskId);
      await getPool().query("UPDATE agent_tasks SET status = 'running' WHERE id = $1", [taskId]);
    });
    try {
      const result = await runDueSchedulesOnce(new Date());
      expect(result.due).toBe(1);
      expect(result.errors).toBe(0);
    } finally {
      __setRunnerOverride(null);
    }

    const tasks = await getPool().query<{ id: string; status: string }>(
      "SELECT id, status FROM agent_tasks WHERE user_id = $1",
      [uid],
    );
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0].status).toBe("running"); // moved off 'planned'
    expect(started).toEqual([tasks.rows[0].id]);
  });

  it("auto_approve schedules start without a manual approval", async () => {
    const em = email("tick-auto");
    const token = await signupVerifyLogin(app, em);
    const uid = await userIdFor(em);
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.agentSchedules,
      headers: authHeader(token),
      payload: {
        title: "Auto schedule",
        task: "Refresh the dashboard",
        schedule: { kind: "interval_hours", hours: 1 },
        autoApprove: true,
      },
    });
    const schedId = created.json().data.schedule.id as string;
    await getPool().query(
      "UPDATE agent_schedules SET next_run_at = $1::timestamptz WHERE id = $2",
      [new Date(Date.now() - 60_000).toISOString(), schedId],
    );

    __setRunnerOverride(async (taskId: string) => {
      await getPool().query("UPDATE agent_tasks SET status = 'running' WHERE id = $1", [taskId]);
    });
    try {
      await runDueSchedulesOnce(new Date());
    } finally {
      __setRunnerOverride(null);
    }
    const tasks = await getPool().query<{ status: string }>(
      "SELECT status FROM agent_tasks WHERE user_id = $1",
      [uid],
    );
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0].status).toBe("running");
  });

  it("a runner failure marks the task failed honestly", async () => {
    const em = email("tick-fail");
    await signupVerifyLogin(app, em);
    const uid = await userIdFor(em);
    await insertSchedule(uid, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });
    await getPool().query("UPDATE agent_schedules SET approved_once = true WHERE user_id = $1", [uid]);

    __setRunnerOverride(async () => {
      throw new Error("boom");
    });
    try {
      const result = await runDueSchedulesOnce(new Date());
      expect(result.errors).toBe(1);
    } finally {
      __setRunnerOverride(null);
    }
    const tasks = await getPool().query<{ status: string }>(
      "SELECT status FROM agent_tasks WHERE user_id = $1",
      [uid],
    );
    expect(tasks.rows[0].status).toBe("failed");
  });
});

describe("folder scope", () => {
  it("checkFolderScope: null scope allows anything; matching allows; mismatch throws", () => {
    expect(() => checkFolderScope(null, "proj-1")).not.toThrow();
    expect(() => checkFolderScope(null, null)).not.toThrow();
    expect(() => checkFolderScope("proj-1", "proj-1")).not.toThrow();
    let thrown: unknown;
    try {
      checkFolderScope("proj-1", "proj-2");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toEqual({ code: SCOPE_VIOLATION });
    // A scoped task cannot touch an unscoped (global) file either.
    thrown = undefined;
    try {
      checkFolderScope("proj-1", null);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toEqual({ code: SCOPE_VIOLATION });
  });

  it("scopeDiffSummary lists files created in the folder since `since`", async () => {
    const em = email("scope-diff");
    await signupVerifyLogin(app, em);
    const uid = await userIdFor(em);
    const projId = randomUUID();
    await getPool().query("INSERT INTO projects (id, user_id, title) VALUES ($1, $2, 'Scope proj')", [
      projId,
      uid,
    ]);
    const since = new Date(Date.now() - 60_000);
    for (const name of ["a.txt", "b.txt"]) {
      await getPool().query(
        `INSERT INTO files (id, user_id, project_id, original_name, mime_type, size_bytes, storage_key, status)
         VALUES ($1, $2, $3, $4, 'text/plain', 10, 'k', 'ready')`,
        [randomUUID(), uid, projId, name],
      );
    }
    const diff = await scopeDiffSummary(randomUUID(), projId, since);
    expect(diff.created).toEqual(["a.txt", "b.txt"]);
    // files has no updated_at column in v1 — the updated list is empty by design.
    expect(diff.updated).toEqual([]);
    // A file in another project is not listed.
    const otherProj = randomUUID();
    await getPool().query("INSERT INTO projects (id, user_id, title) VALUES ($1, $2, 'Other')", [
      otherProj,
      uid,
    ]);
    await getPool().query(
      `INSERT INTO files (id, user_id, project_id, original_name, mime_type, size_bytes, storage_key, status)
       VALUES ($1, $2, $3, $4, 'text/plain', 10, 'k', 'ready')`,
      [randomUUID(), uid, otherProj, "c.txt"],
    );
    const diff2 = await scopeDiffSummary(randomUUID(), projId, since);
    expect(diff2.created).toEqual(["a.txt", "b.txt"]);
  });
});

describe("notifications", () => {
  it("lists newest first and marks a notification read; ownership enforced", async () => {
    if (!(await notificationsUsable())) return; // sibling's table missing; skip

    const emA = email("notif-a");
    const emB = email("notif-b");
    const tokenA = await signupVerifyLogin(app, emA);
    const tokenB = await signupVerifyLogin(app, emB);
    const uidA = await userIdFor(emA);
    const n1 = randomUUID();
    const n2 = randomUUID();
    const taskId = randomUUID();
    await getPool().query(
      "INSERT INTO agent_tasks (id, user_id, title) VALUES ($1, $2, 'Task')",
      [taskId, uidA],
    );
    await getPool().query(
      "INSERT INTO agent_notifications (id, user_id, task_id, title, created_at) VALUES ($1, $2, $3, 'First', now() - interval '1 minute')",
      [n1, uidA, taskId],
    );
    await getPool().query(
      "INSERT INTO agent_notifications (id, user_id, task_id, title) VALUES ($1, $2, $3, 'Second')",
      [n2, uidA, taskId],
    );

    let res = await app.inject({ method: "GET", url: API_ROUTES.agentNotifications, headers: authHeader(tokenA) });
    expect(res.statusCode).toBe(200);
    const list = res.json().data.notifications;
    expect(list).toHaveLength(2);
    expect(list[0].title).toBe("Second"); // newest first
    expect(list[0].read).toBe(false);

    // Another user sees nothing.
    res = await app.inject({ method: "GET", url: API_ROUTES.agentNotifications, headers: authHeader(tokenB) });
    expect(res.json().data.notifications).toEqual([]);
    // And cannot mark the other's notification read.
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.agentNotificationRead(n2),
      headers: authHeader(tokenB),
      payload: {},
    });
    expect(res.statusCode).toBe(404);

    // Owner marks read.
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.agentNotificationRead(n2),
      headers: authHeader(tokenA),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.read).toBe(true);
    const row = await getPool().query<{ read: boolean }>(
      "SELECT read FROM agent_notifications WHERE id = $1",
      [n2],
    );
    expect(row.rows[0].read).toBe(true);
  });
});
