// Step 3 file tests: upload + extraction for all 5 types, unsupported type,
// oversized rejection, signed download links (valid/expired/tampered),
// delete. Drive the app with fastify.inject — no network.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { authHeader, email, fixture, signupVerifyLogin, uploadFile } from "./helpers.js";

// Env must be set before buildApp() (config/storage read lazily).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL=<redacted>
process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-2";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "genze-files-test-"));
// Provider keys unset -> audio transcription marks "not_configured".
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

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

describe("file upload + extraction", () => {
  it("extracts text from a PDF", async () => {
    const token = await signupVerifyLogin(app, email("pdf"));
    const up = await uploadFile(app, token, "hello.pdf", "application/pdf", await fixture("hello.pdf"));
    expect(up.statusCode).toBe(201);
    const file = up.json().data.file;
    expect(file.status).toBe("ready");
    expect(file.mimeType).toBe("application/pdf");
    expect(file.hasText).toBe(true);

    const got = await app.inject({ method: "GET", url: API_ROUTES.file(file.id), headers: authHeader(token) });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.file.extractedText).toContain("quick brown fox");
  });

  it("extracts text from a DOCX", async () => {
    const token = await signupVerifyLogin(app, email("docx"));
    const up = await uploadFile(
      app,
      token,
      "hello.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      await fixture("hello.docx"),
    );
    expect(up.statusCode).toBe(201);
    const got = await app.inject({
      method: "GET",
      url: API_ROUTES.file(up.json().data.file.id),
      headers: authHeader(token),
    });
    expect(got.json().data.file.extractedText).toContain("five dozen liquor jugs");
  });

  it("extracts markdown tables from XLSX and CSV", async () => {
    const token = await signupVerifyLogin(app, email("xlsx"));
    let up = await uploadFile(
      app,
      token,
      "hello.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      await fixture("hello.xlsx"),
    );
    expect(up.statusCode).toBe(201);
    let got = await app.inject({
      method: "GET",
      url: API_ROUTES.file(up.json().data.file.id),
      headers: authHeader(token),
    });
    const xlsxText = got.json().data.file.extractedText as string;
    expect(xlsxText).toContain("## Sheet: Planets");
    expect(xlsxText).toContain("Genze XLSX fixture");

    up = await uploadFile(app, token, "hello.csv", "text/csv", await fixture("hello.csv"));
    expect(up.statusCode).toBe(201);
    got = await app.inject({
      method: "GET",
      url: API_ROUTES.file(up.json().data.file.id),
      headers: authHeader(token),
    });
    expect(got.json().data.file.extractedText as string).toContain("Genze CSV fixture");
  });

  it("stores image metadata and dimensions (no text)", async () => {
    const token = await signupVerifyLogin(app, email("png"));
    const up = await uploadFile(app, token, "hello.png", "image/png", await fixture("hello.png"));
    expect(up.statusCode).toBe(201);
    const file = up.json().data.file;
    expect(file.status).toBe("ready");
    expect(file.imageWidth).toBe(320);
    expect(file.imageHeight).toBe(180);
    expect(file.hasText).toBe(false);
  });

  it("marks audio transcript not_configured when no OpenAI key", async () => {
    const token = await signupVerifyLogin(app, email("mp3"));
    const up = await uploadFile(app, token, "hello.mp3", "audio/mpeg", await fixture("hello.mp3"));
    expect(up.statusCode).toBe(201);
    const file = up.json().data.file;
    expect(file.status).toBe("ready");
    expect(file.transcriptStatus).toBe("not_configured");
    expect(file.hasText).toBe(false);
  });

  it("rejects unsupported file types", async () => {
    const token = await signupVerifyLogin(app, email("txt"));
    const up = await uploadFile(app, token, "notes.txt", "text/plain", Buffer.from("hello"));
    expect(up.statusCode).toBe(400);
    expect(up.json().error.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("rejects oversized files (MAX_FILE_MB honored at request time)", async () => {
    const token = await signupVerifyLogin(app, email("big"));
    process.env.MAX_FILE_MB = "1";
    try {
      const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
      const up = await uploadFile(app, token, "big.pdf", "application/pdf", big);
      expect(up.statusCode).toBe(413);
      expect(up.json().error.code).toBe("FILE_TOO_LARGE");
    } finally {
      delete process.env.MAX_FILE_MB;
    }
  });

  it("lists only the uploader's files", async () => {
    const tokenA = await signupVerifyLogin(app, email("a"));
    const tokenB = await signupVerifyLogin(app, email("b"));
    await uploadFile(app, tokenA, "hello.pdf", "application/pdf", await fixture("hello.pdf"));
    const res = await app.inject({ method: "GET", url: API_ROUTES.files, headers: authHeader(tokenB) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.files).toHaveLength(0);
  });
});

describe("signed download links", () => {
  it("serves the original bytes, then rejects expired and tampered links", async () => {
    const token = await signupVerifyLogin(app, email("dl"));
    const up = await uploadFile(app, token, "hello.png", "image/png", await fixture("hello.png"));
    const fileId = up.json().data.file.id as string;

    const linkRes = await app.inject({
      method: "GET",
      url: API_ROUTES.fileLink(fileId),
      headers: authHeader(token),
    });
    expect(linkRes.statusCode).toBe(200);
    const url = linkRes.json().data.url as string;
    expect(url).toContain(`/api/v1/files/${fileId}/download`);

    // Valid link, no auth header needed.
    const dl = await app.inject({ method: "GET", url });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("image/png");
    expect(Number(dl.headers["content-length"])).toBe((await fixture("hello.png")).length);

    // Byte-exact check with a text fixture (inject stringifies binary bodies).
    const upCsv = await uploadFile(app, token, "hello.csv", "text/csv", await fixture("hello.csv"));
    const csvId = upCsv.json().data.file.id as string;
    const csvLink = await app.inject({
      method: "GET",
      url: API_ROUTES.fileLink(csvId),
      headers: authHeader(token),
    });
    const csvDl = await app.inject({ method: "GET", url: csvLink.json().data.url as string });
    expect(csvDl.statusCode).toBe(200);
    expect(csvDl.body).toBe((await fixture("hello.csv")).toString("utf8"));

    // Expired link: same HMAC construction, past expiry.
    const secret = process.env.JWT_ACCESS_SECRET as string;
    const past = Math.floor(Date.now() / 1000) - 60;
    const sig = createHmac("sha256", secret).update(`${fileId}:${past}`, "utf8").digest("hex");
    const expired = await app.inject({
      method: "GET",
      url: `/api/v1/files/${fileId}/download?expires=${past}&sig=${sig}`,
    });
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error.code).toBe("LINK_EXPIRED");

    // Tampered signature (flip the first hex digit deterministically).
    const u = new URL(url, "http://localhost");
    const origSig = u.searchParams.get("sig")!;
    const tamperedSig = (origSig[0] === "0" ? "1" : "0") + origSig.slice(1);
    const tampered = await app.inject({
      method: "GET",
      url: `/api/v1/files/${fileId}/download?expires=${u.searchParams.get("expires")}&sig=${tamperedSig}`,
    });
    expect(tampered.statusCode).toBe(403);
    expect(tampered.json().error.code).toBe("LINK_INVALID");
  });
});

describe("file delete", () => {
  it("removes the row and the stored object", async () => {
    const token = await signupVerifyLogin(app, email("del"));
    const up = await uploadFile(app, token, "hello.pdf", "application/pdf", await fixture("hello.pdf"));
    const fileId = up.json().data.file.id as string;

    const del = await app.inject({
      method: "DELETE",
      url: API_ROUTES.file(fileId),
      headers: authHeader(token),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(true);

    const got = await app.inject({ method: "GET", url: API_ROUTES.file(fileId), headers: authHeader(token) });
    expect(got.statusCode).toBe(404);
    const link = await app.inject({
      method: "GET",
      url: API_ROUTES.fileLink(fileId),
      headers: authHeader(token),
    });
    expect(link.statusCode).toBe(404);
  });

  it("cannot delete another user's file", async () => {
    const tokenA = await signupVerifyLogin(app, email("del-a"));
    const tokenB = await signupVerifyLogin(app, email("del-b"));
    const up = await uploadFile(app, tokenA, "hello.pdf", "application/pdf", await fixture("hello.pdf"));
    const del = await app.inject({
      method: "DELETE",
      url: API_ROUTES.file(up.json().data.file.id),
      headers: authHeader(tokenB),
    });
    expect(del.statusCode).toBe(404);
  });
});
