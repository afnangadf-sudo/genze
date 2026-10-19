// Step 4 tests: research pipeline, write, persistent memory, exports.
// Drive the app with fastify.inject — no real network. Provider HTTP calls
// are stubbed by replacing globalThis.fetch with a dispatcher (Anthropic SSE
// by prompt type; everything else passes through to a local HTTP server so
// the real page fetcher runs end to end).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { API_ROUTES, LANGUAGE_NAMES, isValidLanguageCode, languageDisplayName } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { applyLanguageInstruction, languageInstruction } from "../src/chat/language.js";
import { testEmailOutbox } from "../src/email.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { validateCitations } from "../src/research/citations.js";
import { fetchPage, FetchError, clearRobotsCache } from "../src/research/fetch.js";
import { pickSearchProvider } from "../src/search/index.js";
import { setStubResults } from "../src/search/stub.js";
import { sweepStaleJobs } from "../src/research/runner.js";
import {
  draftToPptxBuffer,
  draftToXlsxBuffer,
  formatCitation,
  reportToDocxBuffer,
  reportToMarkdown,
  reportToPdfBuffer,
} from "../src/export/index.js";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";
import JSZip from "jszip";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-made-of-words-only-one";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-made-of-words-only-two";
process.env.REDIS_URL = ""; // health must report redis:false, not hang
process.env.APP_URL = "http://localhost:3000";
// Provider/search keys intentionally unset by default -> gates are exercised.

const MANAGED = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "PROVIDER_DISABLED",
  "FREE_AI_ENABLED",
  "SEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "SERPER_API_KEY",
  "FETCH_TIMEOUT_MS",
  "FETCH_MAX_CHARS",
  "RESEARCH_MAX_SEARCHES",
  "RESEARCH_MAX_SOURCES",
];

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof globalThis.fetch | undefined;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedFetch = globalThis.fetch;
  realFetch = savedFetch!;
  clearRobotsCache();
  process.env.FREE_AI_ENABLED = "false"; // restore zero-keys -> demo world
});

afterEach(() => {
  for (const k of MANAGED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch!;
  setStubResults([
    { title: "reset one", url: "https://example.com/reset-one", snippet: "reset" },
  ]);
});

let app: FastifyInstance;
let server: Server;
let base: string;

const email = (tag: string) => `s4-${tag}-${randomUUID().slice(0, 8)}@example.com`.toLowerCase();
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

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
  const userId = res.json().data.user.id as string;
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.verifyEmail,
    payload: { token: lastTokenFor(em) },
  });
  expect(res.statusCode).toBe(200);
  res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password } });
  expect(res.statusCode).toBe(200);
  const tokens = res.json().data.tokens as { accessToken: string; refreshToken: string };
  return { tokens, userId };
}

async function grantConsent(headers: Record<string, string>, providerId: string) {
  const res = await app.inject({
    method: "POST",
    url: API_ROUTES.chatConsent,
    headers,
    payload: { providerIds: [providerId] },
  });
  expect([200, 201]).toContain(res.statusCode);
}

/** Parse the `data: <json>` frames out of an SSE payload. */
function sseEvents(payload: string): Array<Record<string, unknown>> {
  return payload
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice("data:".length).trim()) as Record<string, unknown>);
}

/** Canned Anthropic SSE carrying `text` (input 10 / output 5 tokens). */
function sseWithText(text: string): string {
  const data = (o: unknown) => `data: ${JSON.stringify(o)}\n`;
  return (
    "event: message_start\n" +
    data({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } }) +
    "\n" +
    "event: content_block_delta\n" +
    data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    "\n" +
    "event: message_delta\n" +
    data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
    "\n" +
    "event: message_stop\n" +
    data({ type: "message_stop" }) +
    "\n"
  );
}

const REPORT_MD = [
  "## Summary",
  "A short summary with a supported claim [1].",
  "",
  "## Key findings",
  "- First finding [1].",
  "- Second finding [2].",
  "",
  "## Where sources disagree",
  "The sources agree on the basics [2].",
  "",
  "## Open questions",
  "- What remains unknown [1].",
  "",
  "## Sources",
  "[1] Page One",
  "[2] Page Two",
].join("\n");

/**
 * Stub fetch: Anthropic calls get canned SSE dispatched on the system
 * prompt; every other URL passes through to the real fetch (the local HTTP
 * server), so fetchPage runs for real. Captures request systems for
 * assertions (memory/style injection).
 */
function stubProviderFetch(capturedSystems: string[], delayMs = 150) {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.anthropic.com")) {
      await new Promise((r) => setTimeout(r, delayMs));
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
        system?: string;
      };
      const system = String(body.system ?? "");
      capturedSystems.push(system);
      let text = "Hello there";
      if (system.includes("research planner")) {
        text = JSON.stringify({ steps: ["Step one", "Step two", "Step three", "Step four"] });
      } else if (system.includes("search query generator")) {
        text = JSON.stringify(["alpha query", "beta query"]);
      } else if (system.includes("research analyst")) {
        text = REPORT_MD;
      } else if (system.includes("extracting checkable claims")) {
        text = JSON.stringify([
          "The Eiffel Tower is 330 metres tall.",
          "It was completed in 1889.",
        ]);
      } else if (system.includes("verifying a claim")) {
        text = JSON.stringify({ verdict: "supported", sources: [1] });
      } else if (system.includes("You are an editor")) {
        text = "REVISED DRAFT TEXT";
      } else if (system.includes("the brief below")) {
        text =
          "DRAFT OUTPUT. The Eiffel Tower is 330 metres tall. It was completed in 1889.\n\n" +
          "## Details\nMore draft text here.";
      }
      return new Response(sseWithText(text), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return realFetch(url as string, init);
  }) as typeof fetch;
}

function pageHtml(title: string, word: string): string {
  return (
    `<html><head><title>${title}</title></head><body><article>` +
    `<h1>${title}</h1><p>${(`${word} content. `).repeat(60)}</p>` +
    `<p>${(`More ${word} detail. `).repeat(40)}</p>` +
    `</article></body></html>`
  );
}

beforeAll(async () => {
  // Local HTTP server: deterministic pages for the real fetcher.
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /blocked\n");
      return;
    }
    if (url === "/page1" || url === "/page2") {
      const title = url === "/page1" ? "Page One" : "Page Two";
      const word = url === "/page1" ? "Alpha" : "Beta";
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(pageHtml(title, word));
      }, 150); // slow enough for progress polling to observe the fetch phase
      return;
    }
    if (url === "/blocked") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("Blocked", "Blocked"));
      return;
    }
    if (url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(pageHtml("Slow", "Slow"));
      }, 1500);
      return;
    }
    if (url === "/image.png") {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await closeRedis();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function pollJob(
  headers: Record<string, string>,
  jobId: string,
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: "GET", url: API_ROUTES.researchJob(jobId), headers });
    expect(res.statusCode).toBe(200);
    const job = res.json().data.job as Record<string, unknown>;
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for research job (status ${String(job.status)})`);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

async function pollPlan(
  headers: Record<string, string>,
  jobId: string,
  timeoutMs = 15000,
): Promise<{ steps: string[] }> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: "GET", url: API_ROUTES.researchJob(jobId), headers });
    expect(res.statusCode).toBe(200);
    const job = res.json().data.job as { plan: { steps: string[] } | null; status: string };
    if (job.plan) return job.plan;
    if (job.status === "failed") throw new Error("job failed during plan phase");
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for plan");
    await new Promise((r) => setTimeout(r, 60));
  }
}

async function pollCheck(
  headers: Record<string, string>,
  checkId: string,
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({
      method: "GET",
      url: API_ROUTES.writeFactCheck(checkId),
      headers,
    });
    expect(res.statusCode).toBe(200);
    const check = res.json().data.check as Record<string, unknown>;
    if (check.status === "done" || check.status === "failed") return check;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for fact-check (status ${String(check.status)})`);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

/* ================= citation validator ================= */

describe("citation validator", () => {
  const good = (n: number) =>
    [
      "## Summary",
      `Summary text [1].`,
      "",
      "## Key findings",
      `- Finding [2].`,
      "",
      "## Where sources disagree",
      `They disagree [${n}].`,
      "",
      "## Open questions",
      `- Open [1].`,
      "",
      "## Sources",
      ...Array.from({ length: n }, (_, i) => `[${i + 1}] Source ${i + 1}`),
    ].join("\n");

  it("accepts a valid report", () => {
    const r = validateCitations(good(2), 2);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects a citation number beyond the source count", () => {
    const r = validateCitations(good(5).replace("[5]", "[9]"), 5);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("[9]"))).toBe(true);
  });

  it("rejects citation [0]", () => {
    const r = validateCitations(good(2).replace("[1]", "[0]"), 2);
    expect(r.ok).toBe(false);
  });

  it("rejects a report with zero citations", () => {
    const r = validateCitations(
      "## Summary\nNo citations here.\n\n## Key findings\nNone.\n\n## Where sources disagree\nNone.\n\n## Open questions\nNone.\n\n## Sources\n1. Source one\n2. Source two",
      2,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("no citations"))).toBe(true);
  });

  it("rejects a report missing a required section", () => {
    const r = validateCitations(good(2).replace("## Open questions", "## Loose ends"), 2);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("## Open questions"))).toBe(true);
  });

  it("ignores markdown links when scanning citations", () => {
    const md = good(2).replace("[1] Source 1", "[Source 1](https://example.com/1)");
    const r = validateCitations(md, 2);
    expect(r.ok).toBe(true);
  });
});

/* ================= export module ================= */

describe("export module", () => {
  const title = "Test Report";
  const md = "## Summary\nReport body text here [1].\n\n## Details\n- bullet one\n- bullet two\n";
  const sources = [
    { n: 1, title: "Source One", url: "https://example.com/one" },
    { n: 2, title: "Source Two", url: "https://example.com/two" },
  ];

  it("reportToMarkdown contains title, body and the source list", () => {
    const out = reportToMarkdown(title, md, sources);
    expect(out).toContain("# Test Report");
    expect(out).toContain("Report body text here");
    expect(out).toContain("[1] Source One — https://example.com/one");
    expect(out).toContain("[2] Source Two — https://example.com/two");
  });

  it("reportToDocxBuffer opens as a zip whose document.xml holds the text", async () => {
    const buf = await reportToDocxBuffer(title, md, sources);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Test Report");
    expect(xml).toContain("Report body text here");
    expect(xml).toContain("Source One");
  });

  it("reportToPdfBuffer is a real PDF whose text extracts", async () => {
    const buf = await reportToPdfBuffer(title, md, sources);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const parser = new PDFParse({ data: buf });
    try {
      const result = (await parser.getText()) as { text?: string };
      expect(result.text).toContain("Test Report");
      expect(result.text).toContain("Report body text here");
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  });

  it("draftToXlsxBuffer is a workbook with a sections table", async () => {
    const buf = await draftToXlsxBuffer(title, md);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    expect(rows[0]).toEqual(["Section", "Content"]);
    const flat = rows.flat().join(" | ");
    expect(flat).toContain("Summary");
    expect(flat).toContain("bullet one");
  });

  it("draftToPptxBuffer is a zip whose slides hold the headings", async () => {
    const buf = await draftToPptxBuffer(title, md);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => n.startsWith("ppt/slides/slide"));
    expect(names.length).toBeGreaterThanOrEqual(2); // cover + content slides
    let all = "";
    for (const n of names) all += await zip.file(n)!.async("string");
    expect(all).toContain("Test Report");
    expect(all).toContain("Summary");
    expect(all).toContain("bullet one");
  });

  it("formatCitation matches the exact APA format", () => {
    expect(
      formatCitation("apa", {
        title: "Page One",
        url: "https://example.com/one",
        fetchedAt: "2026-10-18T12:00:00.000Z",
      }),
    ).toBe("Page One. (n.d.). Retrieved October 18, 2026, from https://example.com/one");
  });

  it("formatCitation matches the exact MLA format", () => {
    expect(
      formatCitation("mla", {
        title: "Page One",
        url: "https://example.com/one",
        fetchedAt: "2026-10-18T12:00:00.000Z",
      }),
    ).toBe('"Page One." Accessed 18 Oct. 2026. https://example.com/one');
  });
});

/* ================= page fetcher ================= */

describe("page fetcher", () => {
  it("extracts title and text from an HTML page", async () => {
    const page = await fetchPage(`${base}/page1`);
    expect(page.title).toBe("Page One");
    expect(page.title).toBe("Page One");
    expect(page.text).toContain("Alpha content.");
    expect(typeof page.fetchedAt).toBe("string");
  });

  it("respects robots.txt (disallowed URL -> robots error)", async () => {
    await expect(fetchPage(`${base}/blocked`)).rejects.toMatchObject({ code: "robots" });
  });

  it("times out on a slow page (FETCH_TIMEOUT_MS)", async () => {
    process.env.FETCH_TIMEOUT_MS = "300";
    await expect(fetchPage(`${base}/slow`)).rejects.toMatchObject({ code: "timeout" });
  });

  it("caps extracted text at FETCH_MAX_CHARS", async () => {
    process.env.FETCH_MAX_CHARS = "100";
    const page = await fetchPage(`${base}/page1`);
    expect(page.text.length).toBeLessThanOrEqual(100);
    expect(page.text.length).toBeGreaterThan(0);
  });

  it("rejects non-article content types", async () => {
    await expect(fetchPage(`${base}/image.png`)).rejects.toMatchObject({ code: "content_type" });
  });

  it("rejects invalid and non-http URLs", async () => {
    await expect(fetchPage("not-a-url")).rejects.toMatchObject({ code: "invalid_url" });
    await expect(fetchPage("ftp://example.com/x")).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("FetchError carries a typed code", async () => {
    try {
      await fetchPage(`${base}/blocked`);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as FetchError).code).toBe("robots");
    }
  });
});

/* ================= search provider selection ================= */

describe("search provider selection", () => {
  it("returns null for tavily when the key is missing", () => {
    expect(pickSearchProvider()).toBeNull();
  });

  it("returns tavily when TAVILY_API_KEY is set", () => {
    process.env.TAVILY_API_KEY = "test-tavily-key-words-only";
    const p = pickSearchProvider();
    expect(p?.id).toBe("tavily");
    expect(p?.isConfigured()).toBe(true);
  });

  it("returns the stub only in tests", () => {
    process.env.SEARCH_PROVIDER = "stub";
    expect(pickSearchProvider()?.id).toBe("stub");
    process.env.NODE_ENV = "production";
    expect(pickSearchProvider()).toBeNull();
    process.env.NODE_ENV = "test";
  });

  it("falls back to tavily for an unknown SEARCH_PROVIDER value", () => {
    process.env.SEARCH_PROVIDER = "nope";
    process.env.TAVILY_API_KEY = "test-tavily-key-words-only";
    expect(pickSearchProvider()?.id).toBe("tavily");
  });
});

/* ================= boot sweep ================= */

describe("boot sweep", () => {
  it("marks stale running jobs failed", async () => {
    const { userId } = await signupVerifyLogin(email("sweep"), "password123", "PK");
    const staleId = randomUUID();
    await getPool().query(
      `INSERT INTO research_jobs (id, user_id, topic, status) VALUES ($1, $2, 'stale topic', 'running')`,
      [staleId, userId],
    );
    const staleCheck = randomUUID();
    await getPool().query(
      `INSERT INTO fact_checks (id, user_id, draft_id, status)
       VALUES ($1, $2, $3, 'running')`,
      [staleCheck, userId, randomUUID()],
    ).catch(() => undefined); // draft FK may reject — not essential here
    const swept = await sweepStaleJobs();
    expect(swept).toBeGreaterThanOrEqual(1);
    const r = await getPool().query("SELECT status FROM research_jobs WHERE id = $1", [staleId]);
    expect(r.rows[0].status).toBe("failed");
  });
});

/* ================= research gates ================= */

describe("research gates", () => {
  it("validates the topic (400)", async () => {
    const { tokens } = await signupVerifyLogin(email("rgate"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "ab" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("503 SEARCH_NOT_CONFIGURED when no search key (never a fake report)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const { tokens } = await signupVerifyLogin(email("rgate2"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");
    // No TAVILY_API_KEY -> the search gate fires before routing/consent.
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "history of coffee" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("SEARCH_NOT_CONFIGURED");
    // And nothing was created.
    const list = await app.inject({ method: "GET", url: API_ROUTES.researchJobs, headers: h });
    expect(list.json().data.jobs).toHaveLength(0);
  });

  it("503 NO_PROVIDER_AVAILABLE when search is set but no chat provider", async () => {
    process.env.TAVILY_API_KEY = "test-tavily-key-words-only";
    const { tokens } = await signupVerifyLogin(email("rgate3"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "history of coffee" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NO_PROVIDER_AVAILABLE");
  });

  it("403 CONSENT_REQUIRED when the routed provider lacks consent", async () => {
    process.env.TAVILY_API_KEY = "test-tavily-key-words-only";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const { tokens } = await signupVerifyLogin(email("rgate4"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "history of coffee" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CONSENT_REQUIRED");
  });

  it("404 for an unowned threadId, 403 LOCKDOWN for a locked thread", async () => {
    process.env.SEARCH_PROVIDER = "stub";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const { tokens } = await signupVerifyLogin(email("rgate5"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    const missing = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "history of coffee", threadId: randomUUID() },
    });
    expect(missing.statusCode).toBe(404);

    const t = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { title: "locked chat" },
    });
    const threadId = t.json().data.thread.id as string;
    await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: true },
    });
    const locked = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "history of coffee", threadId },
    });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error.code).toBe("LOCKDOWN");
    expect(locked.json().error.message).toBe("Research can't run while this chat is in lockdown.");
  });
});

/* ================= research lifecycle ================= */

describe("research lifecycle", () => {
  it("planned -> running -> done, with ordered progress events and a cited report", async () => {
    process.env.SEARCH_PROVIDER = "stub";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const captured: string[] = [];
    stubProviderFetch(captured);
    setStubResults([
      { title: "Page One", url: `${base}/page1`, snippet: "alpha" },
      { title: "Page Two", url: `${base}/page2`, snippet: "beta" },
      { title: "Blocked page", url: `${base}/blocked`, snippet: "blocked" },
    ]);
    const { tokens, userId } = await signupVerifyLogin(email("rlife"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    // Create: status planned, plan generated in the background.
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "history of coffee" },
    });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().data.job.id as string;
    expect(res.json().data.job.status).toBe("planned");

    const plan = await pollPlan(h, jobId);
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(plan.steps.length).toBeLessThanOrEqual(6);

    // Open the SSE stream BEFORE starting, then collect progress phases via
    // fast polling of the job endpoint (deterministic ordering assertions).
    const ssePromise = app.inject({
      method: "GET",
      url: API_ROUTES.researchJobEvents(jobId),
      headers: h,
    });
    await new Promise((r) => setTimeout(r, 150));

    const seenPhases: string[] = [];
    const poller = (async () => {
      for (let i = 0; i < 400; i++) {
        const r = await app.inject({ method: "GET", url: API_ROUTES.researchJob(jobId), headers: h });
        const phase = (r.json().data.job.progress.phase as string) ?? "";
        if (phase && seenPhases[seenPhases.length - 1] !== phase) seenPhases.push(phase);
        const status = r.json().data.job.status as string;
        if (status === "done" || status === "failed") return status;
        await new Promise((r2) => setTimeout(r2, 60));
      }
      return "timeout";
    })();

    res = await app.inject({ method: "POST", url: API_ROUTES.researchJobStart(jobId), headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.job.status).toBe("running");

    const terminal = await poller;
    expect(terminal).toBe("done");
    const sseRes = await ssePromise;
    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.headers["content-type"]).toContain("text/event-stream");

    // Progress phases observed in order through the polling loop.
    const order = ["queued", "plan", "awaiting-start", "search", "fetch", "synthesize", "done"];
    const idx = (p: string) => order.indexOf(p);
    const key = seenPhases.filter((p) => idx(p) >= 0);
    expect(key).toContain("search");
    expect(key).toContain("fetch");
    expect(key).toContain("synthesize");
    expect(key).toContain("done");
    for (let i = 1; i < key.length; i++) {
      expect(idx(key[i])).toBeGreaterThanOrEqual(idx(key[i - 1]));
    }

    // SSE frames: replay first, terminal event last, phases non-decreasing.
    const events = sseEvents(sseRes.body);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("progress");
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    const ssePhases = events.filter((e) => e.type === "progress").map((e) => String(e.phase));
    for (let i = 1; i < ssePhases.length; i++) {
      expect(idx(ssePhases[i])).toBeGreaterThanOrEqual(idx(ssePhases[i - 1]));
    }

    // Completion is the terminal status; the report is cited and sectioned.
    res = await app.inject({ method: "GET", url: API_ROUTES.researchJob(jobId), headers: h });
    const job = res.json().data.job as {
      status: string;
      reportMarkdown: string;
      sources: Array<{ n: number; url: string; title: string }>;
      plan: { steps: string[] };
    };
    expect(job.status).toBe("done");
    expect(job.reportMarkdown).toContain("## Summary");
    expect(job.reportMarkdown).toContain("## Key findings");
    expect(job.reportMarkdown).toContain("## Where sources disagree");
    expect(job.reportMarkdown).toContain("## Open questions");
    expect(job.reportMarkdown).toContain("## Sources");
    expect(job.reportMarkdown).toMatch(/\[1\]/);
    expect(job.sources).toHaveLength(2);
    expect(job.sources[0].n).toBe(1);
    expect(job.sources[1].n).toBe(2);
    expect(job.sources[0].url).toContain("/page1");
    expect(job.plan.steps.length).toBe(4);

    // Metering: one record-only row, feature='research', phase stats in details.
    const m = await getPool().query(
      "SELECT feature, provider, details FROM usage_events WHERE user_id = $1 AND feature = 'research'",
      [userId],
    );
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].provider).toBe("anthropic");
    expect(m.rows[0].details.outcome).toBe("done");
    expect(m.rows[0].details.pagesFetched).toBe(2);

    // Library: the report group lists the job; delete reuses the research DELETE.
    const lib = await app.inject({ method: "GET", url: API_ROUTES.library, headers: h });
    const reportGroup = (lib.json().data.groups as Array<{ type: string; items: Array<{ id: string; title: string }> }>).find(
      (g) => g.type === "report",
    );
    expect(reportGroup).toBeDefined();
    expect(reportGroup!.items.some((i) => i.id === jobId && i.title === "history of coffee")).toBe(true);
    const libDel = await app.inject({
      method: "DELETE",
      url: API_ROUTES.libraryItem("report", jobId),
      headers: h,
    });
    expect(libDel.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: API_ROUTES.researchJob(jobId), headers: h });
    expect(gone.statusCode).toBe(404);
  }, 60000);

  it("export + citations endpoints serve the finished report", async () => {
    process.env.SEARCH_PROVIDER = "stub";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    stubProviderFetch([]);
    setStubResults([
      { title: "Page One", url: `${base}/page1`, snippet: "alpha" },
      { title: "Page Two", url: `${base}/page2`, snippet: "beta" },
    ]);
    const { tokens } = await signupVerifyLogin(email("rexp"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "export topic" },
    });
    const jobId = res.json().data.job.id as string;
    await pollPlan(h, jobId);
    await app.inject({ method: "POST", url: API_ROUTES.researchJobStart(jobId), headers: h });
    const job = await pollJob(h, jobId);
    expect(job.status).toBe("done");

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.researchJobExport(jobId)}?format=md`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("## Summary");
    expect(res.body).toContain("[1] Page One");

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.researchJobExport(jobId)}?format=pdf`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.body.slice(0, 5)).toBe("%PDF-");

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.researchJobExport(jobId)}?format=docx`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.body.slice(0, 2)).toBe("PK");

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.researchJobExport(jobId)}?format=png`,
      headers: h,
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.researchJobCitations(jobId)}?style=apa`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const citations = res.json().data.citations as Array<{ n: number; text: string }>;
    expect(citations).toHaveLength(2);
    expect(citations[0].n).toBe(1);
    expect(citations[0].text).toContain("(n.d.)");
    expect(citations[0].text).toContain("/page1");

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.researchJobCitations(jobId)}?style=mla`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data.citations as Array<{ text: string }>)[0].text).toContain("Accessed");

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.researchJobCitations(jobId)}?style=chicago`,
      headers: h,
    });
    expect(res.statusCode).toBe(400);
  }, 60000);

  it("start is only valid from planned; delete cancels a live run", async () => {
    process.env.SEARCH_PROVIDER = "stub";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    stubProviderFetch([]);
    setStubResults([{ title: "Page One", url: `${base}/page1`, snippet: "alpha" }]);
    const { tokens } = await signupVerifyLogin(email("rdel"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "deletion topic" },
    });
    const jobId = res.json().data.job.id as string;
    await pollPlan(h, jobId);

    // Starting twice: the second start is rejected.
    res = await app.inject({ method: "POST", url: API_ROUTES.researchJobStart(jobId), headers: h });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "POST", url: API_ROUTES.researchJobStart(jobId), headers: h });
    expect(res.statusCode).toBe(400);

    // Delete cancels the live run and removes the row.
    res = await app.inject({ method: "DELETE", url: API_ROUTES.researchJob(jobId), headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);
    res = await app.inject({ method: "GET", url: API_ROUTES.researchJob(jobId), headers: h });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: "DELETE", url: API_ROUTES.researchJob(jobId), headers: h });
    expect(res.statusCode).toBe(404);
  }, 60000);

  it("events on a finished job replay and terminate immediately", async () => {
    process.env.SEARCH_PROVIDER = "stub";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    stubProviderFetch([]);
    setStubResults([
      { title: "Page One", url: `${base}/page1`, snippet: "alpha" },
      { title: "Page Two", url: `${base}/page2`, snippet: "beta" },
    ]);
    const { tokens } = await signupVerifyLogin(email("revt"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.researchJobs,
      headers: h,
      payload: { topic: "event replay topic" },
    });
    const jobId = res.json().data.job.id as string;
    await pollPlan(h, jobId);
    await app.inject({ method: "POST", url: API_ROUTES.researchJobStart(jobId), headers: h });
    const job = await pollJob(h, jobId);
    expect(job.status).toBe("done");

    res = await app.inject({ method: "GET", url: API_ROUTES.researchJobEvents(jobId), headers: h });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events[0].type).toBe("progress");
    expect(events[events.length - 1].type).toBe("done");
  }, 60000);
});

/* ================= write: styles ================= */

describe("write styles", () => {
  it("CRUD over writing styles", async () => {
    const { tokens } = await signupVerifyLogin(email("wstyle"), "password123", "PK");
    const h = authHeader(tokens.accessToken);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeStyles,
      headers: h,
      payload: { name: "Plain", description: "Short sentences. No jargon." },
    });
    expect(res.statusCode).toBe(201);
    const styleId = res.json().data.style.id as string;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeStyles,
      headers: h,
      payload: { name: "", description: "x" },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: "GET", url: API_ROUTES.writeStyles, headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.styles).toHaveLength(1);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.writeStyle(styleId),
      headers: h,
      payload: { description: "Short sentences. No jargon, ever." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.style.description).toContain("ever");

    res = await app.inject({ method: "DELETE", url: API_ROUTES.writeStyle(styleId), headers: h });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.writeStyles, headers: h });
    expect(res.json().data.styles).toHaveLength(0);
  });

  it("styles are per-user (404 for another user's style)", async () => {
    const a = await signupVerifyLogin(email("wstyleA"), "password123", "PK");
    const b = await signupVerifyLogin(email("wstyleB"), "password123", "PK");
    const ha = authHeader(a.tokens.accessToken);
    const hb = authHeader(b.tokens.accessToken);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeStyles,
      headers: ha,
      payload: { name: "Mine", description: "mine" },
    });
    const styleId = res.json().data.style.id as string;
    res = await app.inject({ method: "GET", url: API_ROUTES.writeStyle(styleId), headers: hb });
    expect(res.statusCode).toBe(404);
  });
});

/* ================= write: drafts ================= */

describe("write drafts", () => {
  function writeEnv() {
    process.env.SEARCH_PROVIDER = "stub";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
  }

  it("generates a draft from a template + brief (201)", async () => {
    writeEnv();
    stubProviderFetch([]);
    const { tokens } = await signupVerifyLogin(email("wdraft"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "summary", brief: "Summarize the Eiffel Tower facts." },
    });
    expect(res.statusCode).toBe(201);
    const draft = res.json().data.draft as { id: string; template: string; content: string; title: string };
    expect(draft.template).toBe("summary");
    expect(draft.content).toContain("DRAFT OUTPUT");
    expect(draft.title.length).toBeGreaterThan(0);

    res = await app.inject({ method: "GET", url: API_ROUTES.writeDraft(draft.id), headers: h });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.writeDrafts, headers: h });
    expect(res.json().data.drafts).toHaveLength(1);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.writeDraft(draft.id),
      headers: h,
      payload: { title: "Edited title" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.draft.title).toBe("Edited title");

    res = await app.inject({ method: "DELETE", url: API_ROUTES.writeDraft(draft.id), headers: h });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.writeDraft(draft.id), headers: h });
    expect(res.statusCode).toBe(404);
  });

  it("validates template/brief/project/style references", async () => {
    writeEnv();
    stubProviderFetch([]);
    const { tokens } = await signupVerifyLogin(email("wdraft2"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    const bad = [
      { template: "novel", brief: "long enough brief here" },
      { template: "email", brief: "ab" },
      { template: "email", brief: "long enough brief here", projectId: randomUUID() },
      { template: "email", brief: "long enough brief here", styleId: randomUUID() },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: "POST", url: API_ROUTES.writeDrafts, headers: h, payload });
      expect([400, 404]).toContain(res.statusCode);
    }
  });

  it("503 without a provider, 403 without consent", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const { tokens } = await signupVerifyLogin(email("wdraft3"), "password123", "PK");
    const h = authHeader(tokens.accessToken);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "email", brief: "write me an email please" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CONSENT_REQUIRED");

    delete process.env.ANTHROPIC_API_KEY;
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "email", brief: "write me an email please" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NO_PROVIDER_AVAILABLE");
  });

  it("project default style is used as system context when no explicit style", async () => {
    writeEnv();
    const captured: string[] = [];
    stubProviderFetch(captured);
    const { tokens } = await signupVerifyLogin(email("wdraft4"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeStyles,
      headers: h,
      payload: { name: "Terse", description: "STYLE_MARKER_WORDS every sentence terse" },
    });
    const styleId = res.json().data.style.id as string;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      headers: h,
      payload: { title: "My project" },
    });
    const projectId = res.json().data.project.id as string;

    // PATCH projects/:id accepts defaultStyleId (owned style or null).
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.project(projectId),
      headers: h,
      payload: { defaultStyleId: styleId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.project.defaultStyleId).toBe(styleId);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.project(projectId),
      headers: h,
      payload: { defaultStyleId: randomUUID() },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "article", brief: "A brief about rivers.", projectId },
    });
    expect(res.statusCode).toBe(201);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[captured.length - 1]).toContain("STYLE_MARKER_WORDS");
    expect(res.json().data.draft.styleId).toBe(styleId);

    // Clearing works too.
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.project(projectId),
      headers: h,
      payload: { defaultStyleId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.project.defaultStyleId).toBeNull();
  });

  it("revise returns text only; the draft is not auto-saved", async () => {
    writeEnv();
    stubProviderFetch([]);
    const { tokens } = await signupVerifyLogin(email("wrev"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "email", brief: "A brief about rivers for revise." },
    });
    const draftId = res.json().data.draft.id as string;
    const before = res.json().data.draft.content as string;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftRevise(draftId),
      headers: h,
      payload: { action: "shorter" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.revised).toBe("REVISED DRAFT TEXT");

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftRevise(draftId),
      headers: h,
      payload: { action: "bogus" },
    });
    expect(res.statusCode).toBe(400);

    // The client persists via PATCH — the server did not auto-save.
    res = await app.inject({ method: "GET", url: API_ROUTES.writeDraft(draftId), headers: h });
    expect(res.json().data.draft.content).toBe(before);
  });

  it("draft exports produce real xlsx/pptx/docx/pdf files", async () => {
    writeEnv();
    stubProviderFetch([]);
    const { tokens } = await signupVerifyLogin(email("wexp"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "summary", brief: "Export me this brief please." },
    });
    const draftId = res.json().data.draft.id as string;

    // Route-level: status + content type + file magic (ASCII survives the
    // inject string decoding; exact byte content is covered by the unit
    // tests above, which run against real Buffers).
    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.writeDraftExport(draftId)}?format=xlsx`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.body.slice(0, 2)).toBe("PK");

    const magic: Record<string, string> = { pptx: "PK", docx: "PK", pdf: "%PDF-" };
    for (const [format, ct] of [
      ["pptx", "presentationml.presentation"],
      ["docx", "wordprocessingml.document"],
      ["pdf", "application/pdf"],
    ] as const) {
      res = await app.inject({
        method: "GET",
        url: `${API_ROUTES.writeDraftExport(draftId)}?format=${format}`,
        headers: h,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain(ct);
      expect(res.body.slice(0, magic[format].length)).toBe(magic[format]);
      expect(res.body.length).toBeGreaterThan(500);
    }

    res = await app.inject({
      method: "GET",
      url: `${API_ROUTES.writeDraftExport(draftId)}?format=txt`,
      headers: h,
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ================= write: fact-check ================= */

describe("write fact-check", () => {
  it("extracts claims and verifies each with sources", async () => {
    process.env.SEARCH_PROVIDER = "stub";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    stubProviderFetch([]);
    setStubResults([
      { title: "Page One", url: `${base}/page1`, snippet: "alpha" },
      { title: "Page Two", url: `${base}/page2`, snippet: "beta" },
    ]);
    const { tokens } = await signupVerifyLogin(email("wfc"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "summary", brief: "Facts about the Eiffel Tower." },
    });
    const draftId = res.json().data.draft.id as string;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftFactCheck(draftId),
      headers: h,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const checkId = res.json().data.check.id as string;
    expect(res.json().data.check.status).toBe("planned");

    const check = (await pollCheck(h, checkId)) as {
      status: string;
      claims: Array<{ claim: string; verdict: string; sources: Array<{ n: number; url: string; title: string }> }>;
    };
    expect(check.status).toBe("done");
    expect(check.claims).toHaveLength(2);
    expect(check.claims[0].claim).toContain("Eiffel Tower");
    expect(check.claims[0].verdict).toBe("supported");
    expect(check.claims[0].sources).toHaveLength(1);
    expect(check.claims[0].sources[0].url).toContain("127.0.0.1");
    expect(check.claims[0].sources[0].title).toBe("Page One");
    expect(check.claims[1].verdict).toBe("supported");
  }, 60000);

  it("gates: LOCKDOWN on a locked thread, SEARCH_NOT_CONFIGURED without a key", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    stubProviderFetch([]);
    const { tokens } = await signupVerifyLogin(email("wfc2"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "summary", brief: "Another brief for gating." },
    });
    const draftId = res.json().data.draft.id as string;

    // No search key -> 503 (SEARCH_PROVIDER unset and no TAVILY key).
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftFactCheck(draftId),
      headers: h,
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("SEARCH_NOT_CONFIGURED");

    // Locked thread -> 403 LOCKDOWN.
    process.env.SEARCH_PROVIDER = "stub";
    const t = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { title: "locked" },
    });
    const threadId = t.json().data.thread.id as string;
    await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: true },
    });
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftFactCheck(draftId),
      headers: h,
      payload: { threadId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("LOCKDOWN");
  });

  it("404 for unknown drafts and checks", async () => {
    const { tokens } = await signupVerifyLogin(email("wfc3"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftFactCheck(randomUUID()),
      headers: h,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: "GET", url: API_ROUTES.writeFactCheck(randomUUID()), headers: h });
    expect(res.statusCode).toBe(404);
  });
});

/* ================= memory ================= */

describe("memory", () => {
  it("CRUD + forget-all", async () => {
    const { tokens } = await signupVerifyLogin(email("mem"), "password123", "PK");
    const h = authHeader(tokens.accessToken);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.memories,
      headers: h,
      payload: { content: "The user's cat is named Miso." },
    });
    expect(res.statusCode).toBe(201);
    const id1 = res.json().data.memory.id as string;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.memories,
      headers: h,
      payload: { content: "The user prefers short answers." },
    });
    expect(res.statusCode).toBe(201);
    const id2 = res.json().data.memory.id as string;

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.memories,
      headers: h,
      payload: { content: "" },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.memories,
      headers: h,
      payload: { content: "x".repeat(501) },
    });
    expect(res.statusCode).toBe(400);

    // Newest first.
    res = await app.inject({ method: "GET", url: API_ROUTES.memories, headers: h });
    const memories = res.json().data.memories as Array<{ id: string; content: string }>;
    expect(memories).toHaveLength(2);
    expect(memories[0].id).toBe(id2);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.memoryItem(id1),
      headers: h,
      payload: { content: "The user's cat is named Miso Jr." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.memory.content).toContain("Miso Jr.");

    res = await app.inject({ method: "DELETE", url: API_ROUTES.memoryItem(id1), headers: h });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: API_ROUTES.memories, headers: h });
    expect(res.json().data.memories).toHaveLength(1);

    // Forget everything returns the count.
    res = await app.inject({ method: "DELETE", url: API_ROUTES.memories, headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(1);
    res = await app.inject({ method: "GET", url: API_ROUTES.memories, headers: h });
    expect(res.json().data.memories).toHaveLength(0);
  });

  it("memories are per-user", async () => {
    const a = await signupVerifyLogin(email("memA"), "password123", "PK");
    const b = await signupVerifyLogin(email("memB"), "password123", "PK");
    const ha = authHeader(a.tokens.accessToken);
    const hb = authHeader(b.tokens.accessToken);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.memories,
      headers: ha,
      payload: { content: "A's secret memory." },
    });
    const id = res.json().data.memory.id as string;
    const check = await app.inject({ method: "PATCH", url: API_ROUTES.memoryItem(id), headers: hb, payload: { content: "hijack" } });
    expect(check.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: API_ROUTES.memories, headers: hb });
    expect(list.json().data.memories).toHaveLength(0);
  });

  it("threaded chat reads memories; temp chat and lockdown do not", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const captured: string[] = [];
    stubProviderFetch(captured);
    const { tokens } = await signupVerifyLogin(email("memread"), "password123", "PK");
    const h = authHeader(tokens.accessToken);
    await grantConsent(h, "anthropic");

    await app.inject({
      method: "POST",
      url: API_ROUTES.memories,
      headers: h,
      payload: { content: "The user's cat is named Miso." },
    });

    // Threaded chat: memory is prepended as system context.
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { title: "memory thread" },
    });
    const threadId = res.json().data.thread.id as string;
    captured.length = 0;
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "What is my cat's name?" },
    });
    expect(res.statusCode).toBe(200);
    const threadedSystem = captured[captured.length - 1] ?? "";
    expect(threadedSystem).toContain("[What I remember about you:");
    expect(threadedSystem).toContain("Miso");

    // Temporary chat: never reads memory.
    captured.length = 0;
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: { messages: [{ role: "user", content: "What is my cat's name?" }] },
    });
    expect(res.statusCode).toBe(200);
    const tempSystem = captured[captured.length - 1] ?? "";
    expect(tempSystem).not.toContain("[What I remember about you:");

    // Lockdown thread: the seam disables memory.
    await app.inject({
      method: "PATCH",
      url: API_ROUTES.chatThread(threadId),
      headers: h,
      payload: { lockdown: true },
    });
    captured.length = 0;
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "What is my cat's name?" },
    });
    expect(res.statusCode).toBe(200);
    const lockedSystem = captured[captured.length - 1] ?? "";
    expect(lockedSystem).not.toContain("[What I remember about you:");
  });
});

/* ================= multilingual v1 (Step 4) ================= */

describe("multilingual v1", () => {
  const ML_PASSWORD = "password123";

  async function signupLang(em: string, language?: string) {
    const payload: Record<string, unknown> = { email: em, password: ML_PASSWORD, country: "PK" };
    if (language !== undefined) payload.language = language;
    const res = await app.inject({ method: "POST", url: API_ROUTES.signup, payload });
    expect(res.statusCode).toBe(201);
    return res.json().data.user as { id: string; preferredLanguage: string };
  }

  async function verifyLogin(em: string): Promise<Record<string, string>> {
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.verifyEmail,
      payload: { token: lastTokenFor(em) },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.login,
      payload: { email: em, password: ML_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return authHeader(res.json().data.tokens.accessToken as string);
  }

  it("signup accepts language:'fa' and GET /account/me returns it", async () => {
    const em = email("ml-fa");
    const user = await signupLang(em, "fa");
    expect(user.preferredLanguage).toBe("fa");
    const h = await verifyLogin(em);
    const me = await app.inject({ method: "GET", url: API_ROUTES.me, headers: h });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.preferredLanguage).toBe("fa");
  });

  it("signup defaults to 'en' when language is omitted; rejects a malformed language code", async () => {
    const user = await signupLang(email("ml-en"));
    expect(user.preferredLanguage).toBe("en");

    const bad = await app.inject({
      method: "POST",
      url: API_ROUTES.signup,
      payload: { email: email("ml-bad"), password: ML_PASSWORD, country: "PK", language: "e!" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("signup accepts arbitrary language codes ('es', 'ps', 'bn', 'pt-BR')", async () => {
    for (const code of ["es", "ps", "bn", "pt-BR"]) {
      const em = email(`ml-${code.replace(/[^a-z]/gi, "")}`);
      const user = await signupLang(em, code);
      expect(user.preferredLanguage).toBe(code.toLowerCase());
    }
  });

  it("PATCH /account/me sets preferredLanguage; invalid value -> 400", async () => {
    const em = email("ml-patch");
    await signupLang(em);
    const h = await verifyLogin(em);

    let res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.me,
      headers: h,
      payload: { preferredLanguage: "ur" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.preferredLanguage).toBe("ur");

    // Persisted.
    res = await app.inject({ method: "GET", url: API_ROUTES.me, headers: h });
    expect(res.json().data.user.preferredLanguage).toBe("ur");

    // Malformed value.
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.me,
      headers: h,
      payload: { preferredLanguage: "e!" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // Non-string value.
    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.me,
      headers: h,
      payload: { preferredLanguage: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // Unchanged by the failed patches.
    res = await app.inject({ method: "GET", url: API_ROUTES.me, headers: h });
    expect(res.json().data.user.preferredLanguage).toBe("ur");
  });

  it("PATCH /account/me accepts arbitrary language codes ('es', 'ps', 'bn')", async () => {
    const em = email("ml-patch-any");
    await signupLang(em);
    const h = await verifyLogin(em);
    for (const code of ["es", "ps", "bn"]) {
      const res = await app.inject({
        method: "PATCH",
        url: API_ROUTES.me,
        headers: h,
        payload: { preferredLanguage: code },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.user.preferredLanguage).toBe(code);
    }
  });

  it("threaded chat prepends the language instruction for a ur user", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const captured: string[] = [];
    stubProviderFetch(captured);
    const em = email("ml-chat");
    await signupLang(em, "ur");
    const h = await verifyLogin(em);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { title: "urdu thread" },
    });
    expect(res.statusCode).toBe(201);
    const threadId = res.json().data.thread.id as string;

    captured.length = 0;
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "Assalam o alaikum" },
    });
    expect(res.statusCode).toBe(200);
    const system = captured[captured.length - 1] ?? "";
    expect(system.startsWith(languageInstruction("ur"))).toBe(true);
    expect(system).toContain(`Reply in ${LANGUAGE_NAMES.ur} unless the user writes in another language.`);
    // Composes with the rest of the system prompt.
    expect(system).toContain("You are Genze");
  });

  it("languageDisplayName covers any code; unknown codes fall back to the raw code", () => {
    expect(languageDisplayName("es")).toBe("Español");
    expect(languageDisplayName("ps")).toBe("پښتو");
    expect(languageDisplayName("bn")).toBe("বাংলা");
    expect(languageDisplayName("pt-BR")).toBe("Português");
    expect(languageDisplayName("ur")).toBe(LANGUAGE_NAMES.ur);
    // Unknown code: graceful raw fallback, never a crash.
    expect(languageDisplayName("xx")).toBe("xx");
    expect(languageInstruction("xx")).toBe("Reply in xx unless the user writes in another language.");
  });

  it("isValidLanguageCode accepts BCP-47-ish codes, rejects malformed ones", () => {
    for (const ok of ["en", "es", "ps", "bn", "pt-BR", "zh-Hant"]) expect(isValidLanguageCode(ok)).toBe(true);
    for (const bad of ["e", "en!", "", "toolongcode".repeat(4), 42, null, "en--us"]) {
      expect(isValidLanguageCode(bad)).toBe(false);
    }
  });

  it("threaded chat prepends the right instruction for an arbitrary language (es)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const captured: string[] = [];
    stubProviderFetch(captured);
    const em = email("ml-es");
    await signupLang(em, "es");
    const h = await verifyLogin(em);
    await grantConsent(h, "anthropic");

    captured.length = 0;
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatThreads,
      headers: h,
      payload: { title: "spanish thread" },
    });
    expect(res.statusCode).toBe(201);
    const threadId = res.json().data.thread.id as string;
    await app.inject({
      method: "POST",
      url: API_ROUTES.chatMessages(threadId),
      headers: h,
      payload: { content: "hola" },
    });
    const system = captured[captured.length - 1] ?? "";
    expect(system.startsWith("Reply in Español unless the user writes in another language.")).toBe(true);
  });
  it("temporary chat prepends the language instruction (always present, even for en)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const captured: string[] = [];
    stubProviderFetch(captured);
    const em = email("ml-temp");
    await signupLang(em); // default 'en'
    const h = await verifyLogin(em);
    await grantConsent(h, "anthropic");

    captured.length = 0;
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: { messages: [{ role: "user", content: "hello there" }] },
    });
    expect(res.statusCode).toBe(200);
    const system = captured[captured.length - 1] ?? "";
    expect(system.startsWith(`Reply in ${LANGUAGE_NAMES.en} unless the user writes in another language.`)).toBe(true);
    expect(system).toContain("You are Genze");
  });

  it("unit: applyLanguageInstruction skips demo, prepends otherwise", () => {
    const base = "You are Genze, a calm and friendly assistant.";
    expect(applyLanguageInstruction(base, { demo: true, language: "ur" })).toBe(base);
    const applied = applyLanguageInstruction(base, { demo: false, language: "fa" });
    expect(applied).toBe(`${languageInstruction("fa")}\n\n${base}`);
    expect(applied).toContain(`Reply in ${LANGUAGE_NAMES.fa} unless the user writes in another language.`);
  });

  it("demo chat streams without the language instruction path", async () => {
    // No provider keys (beforeEach clears them): demo mode engages.
    const em = email("ml-demo");
    await signupLang(em, "ur");
    const h = await verifyLogin(em);

    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: h,
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.payload);
    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();
    expect(start!.demo).toBe(true);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    // Demo replies are fixed local copy; the provider never sees a system prompt.
  });

  it("translate revise works for all five target languages", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
    const sent: Array<{ system: string; messages: string }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.anthropic.com")) {
        const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
          system?: string;
          messages?: Array<{ content?: unknown }>;
        };
        sent.push({
          system: String(body.system ?? ""),
          messages: (body.messages ?? []).map((m) => String(m.content ?? "")).join("\n"),
        });
        return new Response(sseWithText("REVISED OK"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return realFetch(url as string, init);
    }) as typeof fetch;

    const em = email("ml-rev");
    await signupLang(em, "fa");
    const h = await verifyLogin(em);
    await grantConsent(h, "anthropic");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDrafts,
      headers: h,
      payload: { template: "summary", brief: "Translate test brief about coffee." },
    });
    expect(res.statusCode).toBe(201);
    const draftId = res.json().data.draft.id as string;

    // translate-de is now a VALID target (any BCP-47 code works).
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftRevise(draftId),
      headers: h,
      payload: { action: "translate-de" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.revised).toBe("REVISED OK");
    expect(sent[sent.length - 1].messages).toContain(
      `Translate the following text into ${languageDisplayName("de")}, preserving the meaning, tone, and formatting.`,
    );

    // Malformed translate target -> 400.
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.writeDraftRevise(draftId),
      headers: h,
      payload: { action: "translate-e!" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    const expected: Record<string, string> = {
      en: `Translate the following text into ${LANGUAGE_NAMES.en}, preserving the meaning, tone, and formatting.`,
      ur: `Translate the following text into ${LANGUAGE_NAMES.ur} (using the Urdu script), preserving the meaning, tone, and formatting.`,
      ar: `Translate the following text into ${LANGUAGE_NAMES.ar}, preserving the meaning, tone, and formatting.`,
      tr: `Translate the following text into ${LANGUAGE_NAMES.tr}, preserving the meaning, tone, and formatting.`,
      fa: `Translate the following text into ${LANGUAGE_NAMES.fa}, preserving the meaning, tone, and formatting.`,
    };
    for (const target of ["en", "ur", "ar", "tr", "fa"]) {
      sent.length = 0;
      res = await app.inject({
        method: "POST",
        url: API_ROUTES.writeDraftRevise(draftId),
        headers: h,
        payload: { action: `translate-${target}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.revised).toBe("REVISED OK");
      expect(sent).toHaveLength(1);
      expect(sent[0].messages).toContain(expected[target]);
      // The original draft text rides along after the prompt.
      expect(sent[0].messages).toContain("Text:");
    }
  });
});
