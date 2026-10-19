// Step 8 tests: browser-based connections.
//
// Guided login round-trips, encrypted profiles, session health, read-only
// guarantees, audit trail, disconnect. No real browser: NODE_ENV=test gives
// the MockDriver (scripted pages); a shared instance is injected so tests
// can simulate the human login step.
//
// NOTE: the auth rate limit is per app instance (10 signups / 15 min), so
// this file creates 7 users once in beforeAll and reuses them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import {
  MockDriver,
  MOCK_BANK_URL,
  MOCK_BANK_LOGIN_URL,
} from "../src/agent/browser.js";
import {
  setBrowserDriverFactoryForTest,
  detectSessionState,
  validateSiteUrl,
  sweepStaleBrowserLogins,
  openSiteSessionForTask,
  beginLogin,
  ReadOnlyBrowserDriver,
  type BrowserSite,
} from "../src/browserSites/manager.js";
import { encryptProfile, decryptProfile } from "../src/browserSites/vault.js";
import { encryptToken } from "../src/connectors/tokens.js";
import { signupVerifyLogin, authHeader, email } from "./helpers.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret-that-is-long-enough-1234";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret-that-is-long-enough-5678";
process.env.REDIS_URL = ""; // health must report redis:false, not hang
process.env.APP_URL = "http://localhost:3000";
// Deterministic 64-hex key, computed at runtime so the file holds no
// secret-looking literal (decision #79).
process.env.TOKEN_ENCRYPTION_KEY = crypto
  .createHash("sha256")
  .update("genze-test-token-encryption-key")
  .digest("hex");

let app: FastifyInstance;
/** Shared mock driver: tests simulate the human login by visiting the
 *  scripted mock login URL on this same instance. */
const sharedDriver = new MockDriver();

const users: Record<string, { token: string; email: string; id: string }> = {};

async function makeUser(tag: string): Promise<void> {
  const em = email(`bsite-${tag}`);
  const token = await signupVerifyLogin(app, em);
  const r = await getPool().query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [em]);
  users[tag] = { token, email: em, id: r.rows[0].id };
}

async function addSite(tag: string, name: string, url: string): Promise<BrowserSite> {
  const res = await app.inject({
    method: "POST",
    url: API_ROUTES.browserSites,
    headers: authHeader(users[tag].token),
    payload: { name, url },
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.site as BrowserSite;
}

/** Full guided login on the mock bank: begin -> "user logs in" -> complete. */
async function loginSite(tag: string, siteId: string): Promise<{ status: string; detection: string }> {
  const token = users[tag].token;
  const begin = await app.inject({
    method: "POST",
    url: API_ROUTES.browserSiteLogin(siteId),
    headers: authHeader(token),
  });
  expect(begin.statusCode).toBe(200);
  const { loginSessionId } = begin.json().data as { loginSessionId: string };
  // The human login step, simulated on the shared mock driver.
  await sharedDriver.goto("mock-session", MOCK_BANK_LOGIN_URL);
  sharedDriver.actions = [];
  const done = await app.inject({
    method: "POST",
    url: API_ROUTES.browserSiteLoginComplete(siteId),
    headers: authHeader(token),
    payload: { loginSessionId },
  });
  expect(done.statusCode).toBe(200);
  return done.json().data as { status: string; detection: string };
}

async function makeRunningTask(tag: string): Promise<string> {
  const taskId = randomUUID();
  await getPool().query(
    `INSERT INTO agent_tasks (id, user_id, title, status) VALUES ($1, $2, 't', 'running')`,
    [taskId, users[tag].id],
  );
  return taskId;
}

beforeAll(async () => {
  setBrowserDriverFactoryForTest(() => sharedDriver);
  app = await buildApp();
  await app.ready();
  for (const tag of ["a", "b", "c", "f", "i", "j", "k"]) await makeUser(tag);
}, 120000);

afterAll(async () => {
  setBrowserDriverFactoryForTest(null);
  await app.close();
  closePool();
  closeRedis();
});

describe("browser-site CRUD + validation", () => {
  it("adds a site and lists it", async () => {
    const site = await addSite("a", "Mock Bank", MOCK_BANK_URL);
    expect(site.status).toBe("never");

    const list = await app.inject({
      method: "GET",
      url: API_ROUTES.browserSites,
      headers: authHeader(users.a.token),
    });
    expect(list.statusCode).toBe(200);
    const sites = list.json().data.sites as BrowserSite[];
    expect(sites.some((s) => s.id === site.id)).toBe(true);
    // Never secrets in the payload.
    expect(JSON.stringify(sites)).not.toContain("profile_blob");
  });

  it("rejects bad input and duplicates", async () => {
    for (const payload of [
      { name: "", url: "https://example.com/x" },
      { name: "x".repeat(81), url: "https://example.com/x" },
      { name: "Bank", url: "not-a-url" },
      { name: "Bank", url: "http://insecure.example.com" },
      { name: "Bank" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.browserSites,
        headers: authHeader(users.a.token),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    const dup = await app.inject({
      method: "POST",
      url: API_ROUTES.browserSites,
      headers: authHeader(users.a.token),
      payload: { name: "Mock Bank again", url: MOCK_BANK_URL },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("404s for another user's site", async () => {
    const site = await addSite("b", "Mock Bank", MOCK_BANK_URL);
    const res = await app.inject({
      method: "GET",
      url: API_ROUTES.browserSite(site.id),
      headers: authHeader(users.a.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses health checks before any login", async () => {
    const site = await addSite("a", "Example", "https://example.com/app");
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.browserSiteCheck(site.id),
      headers: authHeader(users.a.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("BROWSER_NOT_LOGGED_IN");
  });
});

describe("guided login round trip (mock browser)", () => {
  it("logs in, saves an encrypted profile, and verifies it", async () => {
    const site = await addSite("c", "Mock Bank", MOCK_BANK_URL);
    const data = await loginSite("c", site.id);
    expect(data).toMatchObject({ status: "active", detection: "logged_in" });
    // Read-only by construction: the capture + verify path never acts.
    expect(sharedDriver.actions).toEqual([]);

    const got = await app.inject({
      method: "GET",
      url: API_ROUTES.browserSite(site.id),
      headers: authHeader(users.c.token),
    });
    expect((got.json().data.site as BrowserSite).status).toBe("active");
  });

  it("stores the profile encrypted — no plaintext cookies in the DB", async () => {
    const r = await getPool().query<{ profile_blob: string | null }>(
      `SELECT profile_blob FROM browser_sites WHERE user_id = $1 AND url = $2`,
      [users.c.id, MOCK_BANK_URL],
    );
    const blob = r.rows[0].profile_blob;
    expect(blob).toBeTruthy();
    // Hex iv:ct:tag — the words "session"/"valid" can never appear in hex,
    // and the raw jar JSON certainly isn't there.
    expect(blob as string).not.toContain("session");
    expect(blob as string).not.toContain("valid");
    expect(blob as string).not.toContain("{");
    // …but it decrypts back to the captured profile.
    expect(decryptProfile(blob as string)).toContain("session");
  });

  it("health check passes on a live session", async () => {
    const list = await app.inject({
      method: "GET",
      url: API_ROUTES.browserSites,
      headers: authHeader(users.c.token),
    });
    const site = (list.json().data.sites as BrowserSite[]).find((s) => s.url === MOCK_BANK_URL);
    expect(site).toBeDefined();
    sharedDriver.actions = [];

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.browserSiteCheck(site!.id),
      headers: authHeader(users.c.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "active", detection: "logged_in" });
    expect(sharedDriver.actions).toEqual([]);
  });
});

describe("expiry + disconnect", () => {
  it("detects an expired session and prompts re-login", async () => {
    const site = await addSite("f", "Mock Bank", MOCK_BANK_URL);
    await loginSite("f", site.id);

    // Simulate the cookie dying: overwrite the stored profile with an
    // empty jar (as if the site logged the user out).
    const dead = encryptProfile(JSON.stringify({ v: 1, jar: {} }));
    await getPool().query(`UPDATE browser_sites SET profile_blob = $1 WHERE id = $2`, [dead, site.id]);

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.browserSiteCheck(site.id),
      headers: authHeader(users.f.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "expired", detection: "logged_out" });

    const got = await app.inject({
      method: "GET",
      url: API_ROUTES.browserSite(site.id),
      headers: authHeader(users.f.token),
    });
    expect((got.json().data.site as BrowserSite).status).toBe("expired");

    // The audit trail records the expiry under browser:<siteId>.
    const audit = await app.inject({
      method: "GET",
      url: API_ROUTES.connectorAudit,
      headers: authHeader(users.f.token),
    });
    const entries = audit.json().data.entries as { connectorId: string; action: string }[];
    const mine = entries.filter((e) => e.connectorId === `browser:${site.id}`);
    expect(mine.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "site_added",
        "login_started",
        "login_completed",
        "health_checked",
        "session_expired",
      ]),
    );
  });

  it("disconnect destroys the saved login", async () => {
    const list = await app.inject({
      method: "GET",
      url: API_ROUTES.browserSites,
      headers: authHeader(users.f.token),
    });
    const site = (list.json().data.sites as BrowserSite[]).find((s) => s.url === MOCK_BANK_URL);
    expect(site).toBeDefined();

    const del = await app.inject({
      method: "DELETE",
      url: API_ROUTES.browserSite(site!.id),
      headers: authHeader(users.f.token),
    });
    expect(del.statusCode).toBe(200);

    const r = await getPool().query<{ profile_blob: string | null; status: string }>(
      `SELECT profile_blob, status FROM browser_sites WHERE id = $1`,
      [site!.id],
    );
    expect(r.rows[0].profile_blob).toBeNull();
    expect(r.rows[0].status).toBe("never");

    const audit = await app.inject({
      method: "GET",
      url: API_ROUTES.connectorAudit,
      headers: authHeader(users.f.token),
    });
    const entries = audit.json().data.entries as { connectorId: string; action: string }[];
    expect(
      entries.some((e) => e.connectorId === `browser:${site!.id}` && e.action === "disconnected"),
    ).toBe(true);
  });
});

describe("agent task sessions", () => {
  it("opens a logged-in session for a running task and audits it", async () => {
    const taskId = await makeRunningTask("i");
    const site = await addSite("i", "Mock Bank", MOCK_BANK_URL);
    await loginSite("i", site.id);

    const session = await openSiteSessionForTask(users.i.id, site.id, taskId);
    const snap = await session.driver.snapshot(session.sessionId);
    expect(snap.url).toBe(MOCK_BANK_URL);
    expect(snap.title).toContain("accounts");
    await session.close();

    const audit = await app.inject({
      method: "GET",
      url: API_ROUTES.connectorAudit,
      headers: authHeader(users.i.token),
    });
    const entries = audit.json().data.entries as { connectorId: string; action: string }[];
    expect(
      entries.some((e) => e.connectorId === `browser:${site.id}` && e.action === "site_used"),
    ).toBe(true);
  });

  it("refuses a task that isn't runnable or isn't yours", async () => {
    const taskId = await makeRunningTask("j");
    const site = await addSite("j", "Mock Bank", MOCK_BANK_URL);
    await loginSite("j", site.id);

    await getPool().query(`UPDATE agent_tasks SET status = 'done' WHERE id = $1`, [taskId]);
    await expect(openSiteSessionForTask(users.j.id, site.id, taskId)).rejects.toMatchObject({
      code: "TASK_NOT_RUNNING",
    });
    await expect(openSiteSessionForTask(users.j.id, site.id, randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses when the login expired (plain re-login prompt)", async () => {
    const taskId = await makeRunningTask("k");
    const site = await addSite("k", "Mock Bank", MOCK_BANK_URL);
    await loginSite("k", site.id);
    const dead = encryptProfile(JSON.stringify({ v: 1, jar: {} }));
    await getPool().query(
      `UPDATE browser_sites SET profile_blob = $1, status = 'expired', last_checked_at = now() WHERE id = $2`,
      [dead, site.id],
    );
    await expect(openSiteSessionForTask(users.k.id, site.id, taskId)).rejects.toMatchObject({
      code: "BROWSER_SESSION_EXPIRED",
    });
  });
});

describe("read-only guarantees + detection + vault + sweep", () => {
  it("the read-only wrapper never acts", async () => {
    const ro = new ReadOnlyBrowserDriver(sharedDriver);
    await expect(ro.act("mock-session", "{}")).rejects.toMatchObject({
      code: "BROWSER_WRITE_NOT_ALLOWED",
    });
    // …but reads delegate fine.
    await ro.goto("mock-session", MOCK_BANK_LOGIN_URL);
    const snap = await ro.snapshot("mock-session");
    expect(snap.title).toContain("accounts");
  });

  it("detects session state honestly", () => {
    const loggedIn = {
      url: MOCK_BANK_URL,
      title: "Mock Bank — accounts",
      text: "Welcome back!",
      a11yTree: "button: Log out",
    };
    const loggedOut = {
      url: MOCK_BANK_URL,
      title: "Mock Bank — sign in",
      text: "Please log in.",
      a11yTree: "button: Log in",
    };
    const ambiguous = { url: MOCK_BANK_URL, title: "Mock Bank", text: "Welcome", a11yTree: "" };
    const both = {
      url: MOCK_BANK_URL,
      title: "x",
      text: "Log in to log out",
      a11yTree: "button: Log in\nbutton: Log out",
    };
    expect(detectSessionState(loggedIn)).toBe("logged_in");
    expect(detectSessionState(loggedOut)).toBe("logged_out");
    expect(detectSessionState(ambiguous)).toBe("unknown");
    expect(detectSessionState(both)).toBe("unknown");
  });

  it("the vault round-trips and enforces the purpose label", () => {
    const blob = encryptProfile('{"cookies":[]}');
    expect(decryptProfile(blob)).toBe('{"cookies":[]}');
    // A token-ciphertext without the purpose label is refused.
    expect(() => decryptProfile(encryptToken("not-a-profile"))).toThrow();
    // Tampering is refused.
    expect(() => decryptProfile(blob.slice(0, -4) + "ffff")).toThrow();
  });

  it("validates site URLs", () => {
    expect(validateSiteUrl("https://example.com/app")).toBe("https://example.com/app");
    expect(() => validateSiteUrl("http://example.com")).toThrow();
    expect(() => validateSiteUrl("notaurl")).toThrow();
  });

  it("sweeps expired login sessions", async () => {
    // users.a already owns a Mock Bank site from the CRUD tests.
    const list = await app.inject({
      method: "GET",
      url: API_ROUTES.browserSites,
      headers: authHeader(users.a.token),
    });
    const site = (list.json().data.sites as BrowserSite[]).find((s) => s.url === MOCK_BANK_URL);
    expect(site).toBeDefined();
    const started = await beginLogin(users.a.id, site!.id);
    await getPool().query(
      `UPDATE browser_login_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [started.loginSessionId],
    );
    expect(await sweepStaleBrowserLogins()).toBe(1);
    const r = await getPool().query(`SELECT id FROM browser_login_sessions WHERE id = $1`, [
      started.loginSessionId,
    ]);
    expect(r.rows).toHaveLength(0);
  });
});
