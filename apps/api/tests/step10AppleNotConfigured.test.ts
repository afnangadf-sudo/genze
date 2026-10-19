// Step 10 — Sign in with Apple fail-closed check.
//
// Runs in its own worker WITHOUT APPLE_CLIENT_ID set: the verifier is
// never consulted (no network), and POST /auth/apple must fail closed
// with 503 APPLE_NOT_CONFIGURED.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";
// APPLE_CLIENT_ID intentionally unset -> fail-closed 503 path.

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await closeRedis();
});

describe("POST /auth/apple without APPLE_CLIENT_ID", () => {
  it("fails closed with 503 APPLE_NOT_CONFIGURED", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.authApple,
      payload: { identityToken: "anything" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("APPLE_NOT_CONFIGURED");
  });

  it("still validates the body first (400 before the 503)", async () => {
    const res = await app.inject({ method: "POST", url: API_ROUTES.authApple, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
