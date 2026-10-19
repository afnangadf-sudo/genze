// Step 10 — backend store-readiness tests:
// Sign in with Apple (pure verifier unit tests with a local RSA keypair —
// never hitting Apple; route tests with the verifier stubbed), the
// AI-notice record on PATCH /account/me, the moderation toolkit, and the
// origin-less (native app) CORS behavior.
//
// JWT secrets are deliberately unset here: config auto-generates dev
// secrets (same as other test files' pattern), avoiding the file-write
// pipeline's secret-redaction trap (#36, #79).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { getPool, closePool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { signupVerifyLogin } from "./helpers.js";
import { appleHooks } from "../src/apple/service.js";
import { AppleTokenError, verifyAppleIdentityToken } from "../src/apple/verify.js";
import { fetchAppleJwks, resetJwksCacheForTests, type AppleJwk } from "../src/apple/jwks.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";
// A Services ID (client id) — reverse-DNS string, not a secret.
process.env.APPLE_CLIENT_ID = "com.genze.app";

let app: FastifyInstance;

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });
const email = (tag: string) => `s10-${tag}-${randomUUID().slice(0, 8)}@example.com`;

// ---------------------------------------------------------------------------
// Local RSA keypair for the pure-verifier unit tests (no Apple contact).
// ---------------------------------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_KID = "test-kid-1";
const CLIENT_ID = "com.genze.app";
const testJwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: TEST_KID } as AppleJwk;
const TEST_JWKS: AppleJwk[] = [testJwk];

const b64urlJson = (obj: object) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

function mintAppleToken(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
  key: crypto.KeyObject = privateKey,
): string {
  const header = { alg: "RS256", kid: TEST_KID, typ: "JWT", ...headerOverrides };
  const payload = {
    iss: "https://appleid.apple.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000) - 60,
    sub: "apple-sub-test-1",
    email: "user@privaterelay.appleid.com",
    email_verified: true,
    ...payloadOverrides,
  };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(input, "utf8"), key);
  return `${input}.${sig.toString("base64url")}`;
}

const verifyOpts = (extra: { nonce?: string } = {}) => ({
  clientId: CLIENT_ID,
  jwks: TEST_JWKS,
  ...extra,
});

describe("Apple identity-token verifier (unit, no network)", () => {
  it("accepts a well-formed token from Apple", () => {
    const claims = verifyAppleIdentityToken(mintAppleToken(), verifyOpts());
    expect(claims.sub).toBe("apple-sub-test-1");
    expect(claims.email).toBe("user@privaterelay.appleid.com");
  });

  it("accepts a matching nonce, rejects a mismatch", () => {
    const token = mintAppleToken({ nonce: "test-nonce-1" });
    expect(verifyAppleIdentityToken(token, verifyOpts({ nonce: "test-nonce-1" })).sub).toBe(
      "apple-sub-test-1",
    );
    expect(() => verifyAppleIdentityToken(token, verifyOpts({ nonce: "wrong" }))).toThrow(
      AppleTokenError,
    );
  });

  it("accepts aud given as an array containing the client id", () => {
    const claims = verifyAppleIdentityToken(mintAppleToken({ aud: ["other", CLIENT_ID] }), verifyOpts());
    expect(claims.sub).toBe("apple-sub-test-1");
  });

  it("rejects an unknown kid", () => {
    expect(() => verifyAppleIdentityToken(mintAppleToken({}, { kid: "nope" }), verifyOpts())).toThrow(
      AppleTokenError,
    );
  });

  it("rejects a tampered signature", () => {
    const token = mintAppleToken();
    const parts = token.split(".");
    const last = parts[2].slice(-1) === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${last}`;
    expect(() => verifyAppleIdentityToken(tampered, verifyOpts())).toThrow(AppleTokenError);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const token = mintAppleToken();
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.email = "attacker@example.com";
    const tampered = `${h}.${b64urlJson(payload)}.${s}`;
    expect(() => verifyAppleIdentityToken(tampered, verifyOpts())).toThrow(AppleTokenError);
  });

  it("rejects a token signed by a different key", () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => verifyAppleIdentityToken(mintAppleToken({}, {}, other.privateKey), verifyOpts())).toThrow(
      AppleTokenError,
    );
  });

  it("rejects a wrong issuer", () => {
    expect(() => verifyAppleIdentityToken(mintAppleToken({ iss: "https://evil.example" }), verifyOpts())).toThrow(
      AppleTokenError,
    );
  });

  it("rejects a wrong audience", () => {
    expect(() => verifyAppleIdentityToken(mintAppleToken({ aud: "com.evil.app" }), verifyOpts())).toThrow(
      AppleTokenError,
    );
  });

  it("rejects an expired token", () => {
    expect(() =>
      verifyAppleIdentityToken(mintAppleToken({ exp: Math.floor(Date.now() / 1000) - 3600 }), verifyOpts()),
    ).toThrow(AppleTokenError);
  });

  it("rejects a non-RS256 alg and malformed tokens", () => {
    expect(() => verifyAppleIdentityToken(mintAppleToken({}, { alg: "none" }), verifyOpts())).toThrow(
      AppleTokenError,
    );
    expect(() => verifyAppleIdentityToken("only.two", verifyOpts())).toThrow(AppleTokenError);
    expect(() => verifyAppleIdentityToken("not-a-token", verifyOpts())).toThrow(AppleTokenError);
  });

  it("rejects tokens missing sub or email", () => {
    expect(() => verifyAppleIdentityToken(mintAppleToken({ sub: undefined }), verifyOpts())).toThrow(
      AppleTokenError,
    );
    expect(() => verifyAppleIdentityToken(mintAppleToken({ email: undefined }), verifyOpts())).toThrow(
      AppleTokenError,
    );
  });
});

describe("Apple JWKS fetch + cache (stubbed fetch, no Apple contact)", () => {
  it("caches the key set for ~24h and refetches after reset", async () => {
    resetJwksCacheForTests();
    let calls = 0;
    const stubFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ keys: TEST_JWKS }));
    }) as typeof fetch;
    await fetchAppleJwks(stubFetch);
    await fetchAppleJwks(stubFetch);
    expect(calls).toBe(1);
    resetJwksCacheForTests();
    await fetchAppleJwks(stubFetch);
    expect(calls).toBe(2);
    resetJwksCacheForTests();
  });

  it("throws a plain error when Apple's key server is unreachable", async () => {
    resetJwksCacheForTests();
    const failing = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    await expect(fetchAppleJwks(failing)).rejects.toThrow();
    resetJwksCacheForTests();
  });
});

// ---------------------------------------------------------------------------
// Unique-per-run Apple subs: the shared genze_test DB persists across
// suite runs (#115), so fixed subs would collide with earlier rows.
const RUN = randomUUID().slice(0, 8);
const appleSub = (tag: string) => `apple-sub-${tag}-${RUN}`;

// Route tests with the verifier stubbed (no Apple contact).
// ---------------------------------------------------------------------------
const realVerify = appleHooks.verify;
const stubClaims = (sub: string, em: string) => ({
  sub,
  email: em,
  iss: "https://appleid.apple.com",
  aud: CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 600,
});

beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
  appleHooks.verify = async () => stubClaims(appleSub("route"), "apple-route-1@privaterelay.appleid.com");
});

afterAll(async () => {
  appleHooks.verify = realVerify;
  await app.close();
  await closePool();
  await closeRedis();
});

describe("POST /auth/apple (Sign in with Apple)", () => {
  it("requires an identity token", async () => {
    const res = await app.inject({ method: "POST", url: API_ROUTES.authApple, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-string nonce", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.authApple,
      payload: { identityToken: "x", nonce: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("maps a failed verification to 401 INVALID_CREDENTIALS", async () => {
    const prev = appleHooks.verify;
    appleHooks.verify = async () => {
      throw new AppleTokenError("Apple token signature does not check out.");
    };
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.authApple,
      payload: { identityToken: "bad" },
    });
    appleHooks.verify = prev;
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("creates a verified user on first sign-in and finds them on repeat", async () => {
    const em = email("applenew");
    appleHooks.verify = async () => stubClaims(appleSub("new"), em);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.authApple,
      payload: { identityToken: "tok" },
    });
    expect(res.statusCode).toBe(200);
    const first = res.json().data;
    expect(first.tokens.accessToken).toBeTruthy();
    expect(first.tokens.refreshToken).toBeTruthy();
    expect(first.user.email).toBe(em);
    expect(first.user.emailVerified).toBe(true);
    expect(first.user.aiNoticeAccepted).toBe(false);

    const row = await getPool().query("SELECT apple_sub, email_verified FROM users WHERE id = $1", [
      first.user.id,
    ]);
    expect(row.rows[0].apple_sub).toBe(appleSub("new"));
    expect(row.rows[0].email_verified).toBe(true);

    // Second sign-in with the same Apple sub -> same user, not a duplicate.
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.authApple,
      payload: { identityToken: "tok2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(first.user.id);
    const dupes = await getPool().query("SELECT id FROM users WHERE apple_sub = $1", [appleSub("new")]);
    expect(dupes.rowCount).toBe(1);
    appleHooks.verify = async () => stubClaims(appleSub("route"), "apple-route-1@privaterelay.appleid.com");
  });

  it("links onto an existing account with the same verified email", async () => {
    const em = email("applelink");
    const passwordToken = await signupVerifyLogin(app, em);
    const me = await app.inject({ method: "GET", url: API_ROUTES.me, headers: authHeader(passwordToken) });
    const passwordUserId = me.json().data.user.id;

    appleHooks.verify = async () => stubClaims(appleSub("link"), em);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.authApple,
      payload: { identityToken: "tok" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(passwordUserId);
    const row = await getPool().query("SELECT apple_sub FROM users WHERE id = $1", [passwordUserId]);
    expect(row.rows[0].apple_sub).toBe(appleSub("link"));
    appleHooks.verify = async () => stubClaims(appleSub("route"), "apple-route-1@privaterelay.appleid.com");
  });

  it("issues a working access token", async () => {
    appleHooks.verify = async () => stubClaims(appleSub("session"), email("applesess"));
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.authApple,
      payload: { identityToken: "tok" },
    });
    const accessToken = res.json().data.tokens.accessToken as string;
    const me = await app.inject({ method: "GET", url: API_ROUTES.me, headers: authHeader(accessToken) });
    expect(me.statusCode).toBe(200);
    appleHooks.verify = async () => stubClaims(appleSub("route"), "apple-route-1@privaterelay.appleid.com");
  });
});

describe("AI-notice record (PATCH /account/me)", () => {
  it("starts false, records acceptance, never clears", async () => {
    const token = await signupVerifyLogin(app, email("ainotice"));
    let me = await app.inject({ method: "GET", url: API_ROUTES.me, headers: authHeader(token) });
    expect(me.json().data.user.aiNoticeAccepted).toBe(false);

    const patched = await app.inject({
      method: "PATCH",
      url: API_ROUTES.me,
      headers: authHeader(token),
      payload: { aiNoticeAccepted: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.user.aiNoticeAccepted).toBe(true);

    const row = await getPool().query("SELECT ai_notice_accepted_at FROM users WHERE email = $1", [
      me.json().data.user.email,
    ]);
    expect(row.rows[0].ai_notice_accepted_at).not.toBeNull();

    me = await app.inject({ method: "GET", url: API_ROUTES.me, headers: authHeader(token) });
    expect(me.json().data.user.aiNoticeAccepted).toBe(true);

    // false is a no-op success: the acceptance record is append-only.
    const noop = await app.inject({
      method: "PATCH",
      url: API_ROUTES.me,
      headers: authHeader(token),
      payload: { aiNoticeAccepted: false },
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().data.user.aiNoticeAccepted).toBe(true);
  });

  it("rejects a non-boolean aiNoticeAccepted", async () => {
    const token = await signupVerifyLogin(app, email("ainoticebad"));
    const res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.me,
      headers: authHeader(token),
      payload: { aiNoticeAccepted: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("moderation toolkit", () => {
  let reporterToken: string;
  let reporterEmail: string;
  let ownerToken: string;
  let targetUserId: string;

  beforeAll(async () => {
    reporterEmail = email("reporter");
    reporterToken = await signupVerifyLogin(app, reporterEmail);
    const ownerEmail = email("modowner");
    ownerToken = await signupVerifyLogin(app, ownerEmail);
    await getPool().query("UPDATE users SET is_owner = true WHERE email = $1", [ownerEmail]);
    const targetEmail = email("modtarget");
    const targetToken = await signupVerifyLogin(app, targetEmail);
    const me = await app.inject({ method: "GET", url: API_ROUTES.me, headers: authHeader(targetToken) });
    targetUserId = me.json().data.user.id;
  });

  it("requires auth to file a report", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.moderationReport,
      payload: { contentType: "chat_message", contentId: "m1", reason: "spam" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("validates the report body", async () => {
    const bad = [
      { contentType: "post", contentId: "m1", reason: "x" },
      { contentType: "chat_message", contentId: "", reason: "x" },
      { contentType: "chat_message", contentId: "m1", reason: "" },
    ];
    for (const payload of bad) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.moderationReport,
        headers: authHeader(reporterToken),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  let reportId: string;
  it("files a report -> 201 with an open status", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.moderationReport,
      headers: authHeader(reporterToken),
      payload: {
        contentType: "gem",
        contentId: "gem-123",
        reason: "Harmful instructions",
        details: "It tells people how to do something dangerous.",
      },
    });
    expect(res.statusCode).toBe(201);
    const report = res.json().data.report;
    reportId = report.id;
    expect(report.status).toBe("open");
    expect(report.contentType).toBe("gem");
    expect(report.contentId).toBe("gem-123");
    expect(report.reason).toBe("Harmful instructions");
    expect(report.details).toContain("dangerous");
    const row = await getPool().query("SELECT reporter_id FROM moderation_reports WHERE id = $1", [reportId]);
    expect(row.rowCount).toBe(1);
  });

  it("rejects the report list for non-owners", async () => {
    const res = await app.inject({
      method: "GET",
      url: API_ROUTES.moderationReports,
      headers: authHeader(reporterToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("lets the owner list and triage reports", async () => {
    let res = await app.inject({
      method: "GET",
      url: API_ROUTES.moderationReports,
      headers: authHeader(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const reports = res.json().data.reports as { id: string }[];
    expect(reports.some((r) => r.id === reportId)).toBe(true);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.moderationReportItem(reportId),
      headers: authHeader(ownerToken),
      payload: { status: "triaged" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.report.status).toBe("triaged");

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.moderationReportItem(reportId),
      headers: authHeader(ownerToken),
      payload: { status: "bogus" },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.moderationReportItem(randomUUID()),
      headers: authHeader(ownerToken),
      payload: { status: "resolved" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth to block", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.moderationBlock,
      payload: { userId: targetUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("blocks idempotently, refuses self-block and unknown users", async () => {
    // Unknown user -> 404.
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.moderationBlock,
      headers: authHeader(reporterToken),
      payload: { userId: randomUUID() },
    });
    expect(res.statusCode).toBe(404);

    // Self-block -> 400.
    const me = await app.inject({
      method: "GET",
      url: API_ROUTES.me,
      headers: authHeader(reporterToken),
    });
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.moderationBlock,
      headers: authHeader(reporterToken),
      payload: { userId: me.json().data.user.id },
    });
    expect(res.statusCode).toBe(400);

    // Block -> 201; block again -> still 201, still one row.
    for (let i = 0; i < 2; i++) {
      res = await app.inject({
        method: "POST",
        url: API_ROUTES.moderationBlock,
        headers: authHeader(reporterToken),
        payload: { userId: targetUserId },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.blocked).toBe(true);
    }
    const rows = await getPool().query(
      "SELECT 1 FROM blocked_users WHERE blocked_user_id = $1",
      [targetUserId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("unblocks idempotently", async () => {
    let res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.moderationUnblock(targetUserId),
      headers: authHeader(reporterToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.unblocked).toBe(true);

    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.moderationUnblock(targetUserId),
      headers: authHeader(reporterToken),
    });
    expect(res.statusCode).toBe(200);

    const rows = await getPool().query("SELECT 1 FROM blocked_users WHERE blocked_user_id = $1", [
      targetUserId,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("CORS for native apps (no Origin header)", () => {
  it("serves origin-less requests without rejection", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.health });
    expect(res.statusCode).toBe(200);
  });

  it("does not reject a request carrying an unknown Origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: API_ROUTES.health,
      headers: { origin: "https://not-the-web-app.example" },
    });
    // No HTTP-level rejection: CORS only withholds the allow-origin header.
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still grants the web origin credentialed access", async () => {
    const res = await app.inject({
      method: "GET",
      url: API_ROUTES.health,
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
