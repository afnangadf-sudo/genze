// Full auth lifecycle against a real Postgres (see tests/setup.ts).
// Drive the app with fastify.inject — no network needed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { testEmailOutbox } from "../src/email.js";
import { authenticator } from "../src/totp.js";
import { closePool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-2";
process.env.REDIS_URL = ""; // health must report redis:false, not hang
process.env.APP_URL = "http://localhost:3000";
// Google OAuth intentionally unconfigured -> 503 path is tested.

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await closeRedis();
});

const email = (tag: string) => `test-${tag}-${randomUUID().slice(0, 8)}@example.com`;

/** Pull the token out of the last test-outbox email sent to `to`. */
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
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.verifyEmail,
    payload: { token: lastTokenFor(em) },
  });
  expect(res.statusCode).toBe(200);
  res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password } });
  expect(res.statusCode).toBe(200);
  return res.json().data.tokens as { accessToken: string; refreshToken: string };
}

describe("auth lifecycle", () => {
  it("signup -> verify -> login -> refresh rotation -> devices -> logout-all -> delete", async () => {
    const em = email("life");

    // --- signup validation ---
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.signup,
      payload: { email: em, password: "password123", country: "pk" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data.user;
    expect(created.email).toBe(em);
    expect(created.country).toBe("PK"); // uppercased
    expect(created.emailVerified).toBe(false);

    for (const bad of [
      { email: "not-an-email", password: "password123", country: "US" },
      { email: email("x"), password: "short", country: "US" },
      { email: email("x"), password: "password123", country: "USA" },
    ]) {
      res = await app.inject({ method: "POST", url: API_ROUTES.signup, payload: bad });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.signup,
      payload: { email: em, password: "password123", country: "US" },
    });
    expect(res.statusCode).toBe(400); // duplicate

    // --- verify ---
    const token = lastTokenFor(em);
    res = await app.inject({ method: "POST", url: API_ROUTES.verifyEmail, payload: { token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.emailVerified).toBe(true);
    res = await app.inject({ method: "POST", url: API_ROUTES.verifyEmail, payload: { token } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("TOKEN_INVALID"); // single-use
    res = await app.inject({ method: "POST", url: API_ROUTES.verifyEmail, payload: { token: "nope" } });
    expect(res.json().error.code).toBe("TOKEN_INVALID");

    // --- unverified login -> 403 ---
    const em2 = email("unverified");
    await app.inject({
      method: "POST",
      url: API_ROUTES.signup,
      payload: { email: em2, password: "password123", country: "US" },
    });
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em2, password: "password123" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("EMAIL_NOT_VERIFIED");

    // --- wrong password -> 401 ---
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "wrongpass1" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.login,
      payload: { email: "nobody@example.com", password: "wrongpass1" },
    });
    expect(res.statusCode).toBe(401);

    // --- login ok ---
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "password123" } });
    expect(res.statusCode).toBe(200);
    let { accessToken, refreshToken } = res.json().data.tokens;
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    // --- me ---
    res = await app.inject({ method: "GET", url: API_ROUTES.me, headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.email).toBe(em);

    // --- devices: one row, flagged current ---
    res = await app.inject({
      method: "GET",
      url: API_ROUTES.devices,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const devices = res.json().data.devices;
    expect(devices).toHaveLength(1);
    expect(devices[0].current).toBe(true);
    expect(devices[0].deviceName).toBeTruthy();

    // --- refresh rotation: new pair, old refresh dead ---
    res = await app.inject({ method: "POST", url: API_ROUTES.refresh, payload: { refreshToken } });
    expect(res.statusCode).toBe(200);
    const rotated = res.json().data.tokens;
    expect(rotated.refreshToken).not.toBe(refreshToken);
    expect(rotated.accessToken).not.toBe(accessToken);
    res = await app.inject({ method: "POST", url: API_ROUTES.refresh, payload: { refreshToken } });
    expect(res.statusCode).toBe(401); // old refresh rejected
    accessToken = rotated.accessToken;
    refreshToken = rotated.refreshToken;

    // --- logout (no body): revokes the current session via sid ---
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.logout,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.me, headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.statusCode).toBe(401); // access token died with its session

    // --- login again, then logout-all kills everything ---
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "password123" } });
    expect(res.statusCode).toBe(200);
    const a3 = res.json().data.tokens.accessToken as string;
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.logoutAll,
      headers: { authorization: `Bearer ${a3}` },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({
      method: "GET",
      url: API_ROUTES.devices,
      headers: { authorization: `Bearer ${a3}` },
    });
    expect(res.statusCode).toBe(401);

    // --- forgot-password: always 200, no enumeration ---
    res = await app.inject({ method: "POST", url: API_ROUTES.forgotPassword, payload: { email: em } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "POST", url: API_ROUTES.forgotPassword, payload: { email: "nobody@example.com" } });
    expect(res.statusCode).toBe(200);

    // --- reset-password ---
    const resetToken = lastTokenFor(em);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.resetPassword,
      payload: { token: "bogus", newPassword: "newpassword123" },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.resetPassword,
      payload: { token: resetToken, newPassword: "newpassword123" },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "password123" } });
    expect(res.statusCode).toBe(401); // old password dead
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "newpassword123" } });
    expect(res.statusCode).toBe(200);
    const delAccess = res.json().data.tokens.accessToken as string;

    // --- export: JSON attachment ---
    res = await app.inject({
      method: "GET",
      url: API_ROUTES.export,
      headers: { authorization: `Bearer ${delAccess}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const exp = res.json();
    expect(exp.user.email).toBe(em);
    expect(Array.isArray(exp.devices)).toBe(true);
    expect(Array.isArray(exp.consentRecords)).toBe(true);
    expect(Array.isArray(exp.usageSummary)).toBe(true);
    expect(exp.exportedAt).toBeTruthy();

    // --- delete: wrong password -> 401, then correct -> 200 ---
    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.deleteAccount,
      headers: { authorization: `Bearer ${delAccess}` },
      payload: { password: "wrongpass1" },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.deleteAccount,
      headers: { authorization: `Bearer ${delAccess}` },
      payload: { password: "newpassword123" },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "newpassword123" } });
    expect(res.statusCode).toBe(401); // user is gone
  });

  it("2fa: setup -> enable -> login 202 -> verify code -> disable", async () => {
    const em = email("2fa");
    const tokens = await signupVerifyLogin(em, "password123", "GB");
    const auth = { authorization: `Bearer ${tokens.accessToken}` };

    let res = await app.inject({ method: "POST", url: API_ROUTES.twoFaSetup, headers: auth });
    expect(res.statusCode).toBe(200);
    const { secret, otpauthUrl } = res.json().data;
    expect(secret).toBeTruthy();
    expect(otpauthUrl).toContain("otpauth://");

    res = await app.inject({ method: "POST", url: API_ROUTES.twoFaEnable, headers: auth, payload: { code: "000000" } });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.twoFaEnable,
      headers: auth,
      payload: { code: authenticator.generate(secret) },
    });
    expect(res.statusCode).toBe(200);

    // login now requires the second factor
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "password123" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.twoFactorRequired).toBe(true);
    const pendingToken = res.json().data.pendingToken as string;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.login2fa,
      payload: { pendingToken, code: "000000" },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.login2fa,
      payload: { pendingToken, code: authenticator.generate(secret) },
    });
    expect(res.statusCode).toBe(200);
    const a2 = res.json().data.tokens.accessToken as string;

    // pending token is single-use
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.login2fa,
      payload: { pendingToken, code: authenticator.generate(secret) },
    });
    expect(res.statusCode).toBe(400);

    // disable 2fa again
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.twoFaDisable,
      headers: { authorization: `Bearer ${a2}` },
      payload: { code: authenticator.generate(secret) },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "password123" } });
    expect(res.statusCode).toBe(200);
  });

  it("health reports db/redis status", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.health });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.db).toBe(true);
    expect(d.ok).toBe(true);
    expect(typeof d.redis).toBe("boolean"); // true iff a Redis is reachable; env-dependent
  });

  it("providers/status exposes booleans only, never secret values", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.providersStatus });
    expect(res.statusCode).toBe(200);
    const providers = res.json().data.providers;
    expect(providers.map((p: { id: string }) => p.id).sort()).toEqual([
      "anthropic",
      "elevenlabs",
      "google",
      "kling",
      "openai",
      "steel",
    ]);
    for (const p of providers) {
      expect(typeof p.configured).toBe("boolean");
      expect(typeof p.enabled).toBe("boolean");
      expect(Array.isArray(p.capabilities)).toBe(true);
      expect(Array.isArray(p.regions)).toBe(true);
    }
  });

  it("google oauth returns 503 NOT_CONFIGURED when env is missing", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.oauthGoogle });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({ code: "NOT_CONFIGURED", message: "Google login is not configured" });
  });

  it("unknown routes return contract-shaped 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

describe("rate limiting", () => {
  it("429s signup after 10 attempts per 15 min from one IP", async () => {
    const rlApp = await buildApp({}); // rate limiter ON
    try {
      for (let i = 0; i < 10; i++) {
        const r = await rlApp.inject({
          method: "POST",
          url: API_ROUTES.signup,
          payload: { email: email(`rl${i}`), password: "password123", country: "US" },
        });
        expect(r.statusCode).toBe(201);
      }
      const r = await rlApp.inject({
        method: "POST",
        url: API_ROUTES.signup,
        payload: { email: email("rl10"), password: "password123", country: "US" },
      });
      expect(r.statusCode).toBe(429);
      expect(r.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await rlApp.close();
    }
  });
});
