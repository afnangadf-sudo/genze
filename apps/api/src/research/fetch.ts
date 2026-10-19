// Self-hosted page fetcher (per CONTRACTS.md Step 4): global fetch +
// @mozilla/readability over linkedom. No API key.
//
// Honors robots.txt (skip disallowed URLs), sends a Genze-Research/1.0
// User-Agent, enforces FETCH_TIMEOUT_MS / FETCH_MAX_CHARS, and only accepts
// html/xhtml/plain/pdf content (PDFs reuse the Step 3 extractor).
// All failures are typed FetchErrors — callers never get a fake page.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { extractPdfText } from "../files/extract.js";

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  fetchedAt: string;
}

export type FetchErrorCode =
  | "invalid_url"
  | "robots"
  | "timeout"
  | "content_type"
  | "too_large"
  | "http"
  | "network";

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  constructor(code: FetchErrorCode, message: string) {
    super(message);
    this.name = "FetchError";
    this.code = code;
  }
}

export const RESEARCH_USER_AGENT = "Genze-Research/1.0";

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export function fetchTimeoutMs(): number {
  return envInt("FETCH_TIMEOUT_MS", 15_000);
}

export function fetchMaxChars(): number {
  return envInt("FETCH_MAX_CHARS", 30_000);
}

/** Hard byte ceiling while streaming a body (prevents memory blowups). */
export function fetchMaxBytes(): number {
  return envInt("FETCH_MAX_BYTES", 2_000_000);
}

/* ---------- robots.txt ---------- */

interface RobotsRules {
  disallows: string[];
  allows: string[];
}

const robotsCache = new Map<string, RobotsRules | null>();

function parseRobots(text: string): RobotsRules {
  // Minimal parser: collect Disallow/Allow for `*` and our own UA token.
  const disallows: string[] = [];
  const allows: string[] = [];
  let inScope = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [fieldRaw, ...valueParts] = line.split(":");
    const field = fieldRaw.trim().toLowerCase();
    const value = valueParts.join(":").trim();
    if (field === "user-agent") {
      const ua = value.toLowerCase();
      inScope = ua === "*" || ua === "genze-research" || ua === "genze-research/1.0";
    } else if (inScope && field === "disallow" && value) {
      disallows.push(value);
    } else if (inScope && field === "allow" && value) {
      allows.push(value);
    }
  }
  return { disallows, allows };
}

async function robotsFor(origin: string): Promise<RobotsRules | null> {
  const cached = robotsCache.get(origin);
  if (cached !== undefined) return cached;
  let rules: RobotsRules | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": RESEARCH_USER_AGENT },
        signal: controller.signal,
      });
      if (res.ok) {
        const text = await res.text();
        rules = parseRobots(text);
      }
      // Missing/unreachable robots.txt => no restrictions (standard).
    } finally {
      clearTimeout(timer);
    }
  } catch {
    rules = null;
  }
  robotsCache.set(origin, rules);
  return rules;
}

/** Test hook: clear the in-memory robots cache between cases. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

export function isDisallowed(path: string, rules: RobotsRules): boolean {
  // Longest matching rule wins (Allow beats Disallow on ties-or-longer).
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const a of rules.allows) if (path.startsWith(a)) bestAllow = Math.max(bestAllow, a.length);
  for (const d of rules.disallows)
    if (path.startsWith(d)) bestDisallow = Math.max(bestDisallow, d.length);
  return bestDisallow > bestAllow;
}

/* ---------- fetching ---------- */

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const TEXT_TYPES = ["text/plain"];

function baseContentType(header: string | null): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) throw new FetchError("network", "Empty response body.");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchError("too_large", "The page is larger than the fetch size limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function extractReadable(html: string, url: string): { title: string; text: string } {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as unknown as Document, {
      charThreshold: 20,
    });
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      return {
        title: (article.title ?? "").trim() || url,
        text: article.textContent.replace(/[ \t]+\n/g, "\n").trim(),
      };
    }
  } catch {
    // fall through to the raw-text fallback
  }
  // Fallback: strip tags crudely so a page never yields zero text when the
  // body had content.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return { title: (titleMatch?.[1] ?? "").trim() || url, text };
}

export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError("invalid_url", "That URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError("invalid_url", "Only http and https pages can be opened.");
  }

  // robots.txt first — a disallowed URL is skipped, never fetched.
  const rules = await robotsFor(url.origin);
  if (rules && isDisallowed(url.pathname, rules)) {
    throw new FetchError("robots", "This page is disallowed by the site's robots.txt.");
  }

  const timeoutMs = fetchTimeoutMs();
  const maxBytes = fetchMaxBytes();
  const maxChars = fetchMaxChars();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "user-agent": RESEARCH_USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,application/pdf" },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === "AbortError") {
      throw new FetchError("timeout", "The page took too long to respond.");
    }
    throw new FetchError("network", "The page could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new FetchError("http", `The page returned an error (HTTP ${res.status}).`);
  }

  const type = baseContentType(res.headers.get("content-type"));
  const isHtml = HTML_TYPES.includes(type);
  const isText = TEXT_TYPES.includes(type);
  const isPdf = type === "application/pdf";
  // No content-type header: sniff the first bytes (some servers omit it).
  if (!isHtml && !isText && !isPdf && type !== "") {
    throw new FetchError(
      "content_type",
      "This page is not an article, text, or PDF file.",
    );
  }

  let body: Buffer;
  try {
    body = await readBodyCapped(res, maxBytes);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError("network", "The page could not be read.");
  }

  const fetchedAt = new Date().toISOString();
  const finalUrl = res.url || url.toString();

  if (isPdf || (!type && body.subarray(0, 5).toString() === "%PDF-") || (type === "" && /\.pdf(\?|$)/i.test(finalUrl))) {
    const text = (await extractPdfText(body)).slice(0, maxChars);
    return { url: finalUrl, title: finalUrl, text, fetchedAt };
  }

  const html = body.toString("utf8");
  if (isHtml || type === "") {
    const { title, text } = extractReadable(html, finalUrl);
    return { url: finalUrl, title, text: text.slice(0, maxChars), fetchedAt };
  }
  return { url: finalUrl, title: finalUrl, text: html.slice(0, maxChars), fetchedAt };
}
