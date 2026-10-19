// Abuse protection: owner bans, instant kick-out, unban, owner-only gating.
// Runs against a real Postgres (see tests/setup.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { signupVerifyLogin, authHeader, email } from "./helpers.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-please-change-me-1234";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-please-change-me-12";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await closeRedis();
});

async function userIdFor(em: string): Promise<string> {
  const r = await getPool().query("SELECT id FROM users WHERE email = $1", [em]);
  return r.rows[0].id as string;
}

/** Sign up a fresh user and flag them as owner directly. */
async function makeOwner(em: string): Promise<string> {
  const token = await signupVerifyLogin(app, em);
  await getPool().query("UPDATE users SET is_owner = true WHERE email = $1", [em]);
  return token;
}

describe("abuse protection", () => {
  it("owner can ban a user: their token stops working immediately", async () => {
    const ownerToken = await makeOwner(email("owner"));
    const victimEmail = email("victim");
    const victimToken = await signupVerifyLogin(app, victimEmail);
    const victimId = await userIdFor(victimEmail);

    // victim works before the ban
    let res = await app.inject({
      method: "GET",
      url: API_ROUTES.me,
      headers: authHeader(victimToken),
    });
    expect(res.statusCode).toBe(200);

    // owner bans
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.adminUserBan(victimId),
      headers: authHeader(ownerToken),
      payload: { reason: "tampering with the app" },
    });
    expect(res.statusCode).toBe(200);

    // victim's existing token is now rejected (sessions revoked = instant kick-out)
    res = await app.inject({
      method: "GET",
      url: API_ROUTES.me,
      headers: authHeader(victimToken),
    });
    expect(res.statusCode).toBe(401);

    // and they cannot log back in while banned
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.login,
      payload: { email: victimEmail, password: "password123" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("non-owner cannot ban; owner cannot ban the owner account", async () => {
    const ownerEm = email("owner2");
    const ownerToken = await makeOwner(ownerEm);
    const ownerId = await userIdFor(ownerEm);
    const userToken = await signupVerifyLogin(app, email("regular"));

    // non-owner gets 403
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.adminUserBan("00000000-0000-0000-0000-000000000000"),
      headers: authHeader(userToken),
      payload: {},
    });
    expect(res.statusCode).toBe(403);

    // owner cannot ban the owner account
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.adminUserBan(ownerId),
      headers: authHeader(ownerToken),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("owner can unban: the user can log in again", async () => {
    const ownerToken = await makeOwner(email("owner3"));
    const em = email("tempban");
    await signupVerifyLogin(app, em);
    const uid = await userIdFor(em);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.adminUserBan(uid),
      headers: authHeader(ownerToken),
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.adminUserUnban(uid),
      headers: authHeader(ownerToken),
    });
    expect(res.statusCode).toBe(200);

    // fresh login works after unban
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.login,
      payload: { email: em, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("owner can list users and review abuse events", async () => {
    const ownerToken = await makeOwner(email("owner4"));
    const em = email("listed");
    await signupVerifyLogin(app, em);

    let res = await app.inject({
      method: "GET",
      url: API_ROUTES.adminUsers,
      headers: authHeader(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const users = res.json().data.users as { email: string }[];
    expect(users.some((u) => u.email === em)).toBe(true);

    res = await app.inject({
      method: "GET",
      url: API_ROUTES.adminAbuseEvents,
      headers: authHeader(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data.events)).toBe(true);
  });
});
