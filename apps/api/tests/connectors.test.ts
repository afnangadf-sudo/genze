// Step 6 tests (backend worker A): MCP connectors.
// OAuth authorize/callback, AES-256-GCM token store, confirmation-gated
// write tools, Gmail send, disconnect, refresh, audit log.
// No real network: globalThis.fetch is stubbed (OAuth token endpoints, Gmail
// API) and the MCP transport is faked at the SDK Transport seam.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResponse } from "@modelcontextprotocol/client";
import { API_ROUTES } from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { loadConfig, resetConfig } from "../src/config.js";
import { encryptToken, decryptToken } from "../src/connectors/tokens.js";
import { setMcpTransportFactory } from "../src/connectors/manager.js";
import { discoverOAuth } from "../src/connectors/discovery.js";
import { CONNECTOR_ROUTES } from "../src/connectors/routes.js";
import { signupVerifyLogin, authHeader, email } from "./helpers.js";

// Env must be set before buildApp() (config is loaded lazily on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-made-of-words-only-one";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-made-of-words-only-two";
process.env.REDIS_URL = ""; // health must report redis:false, not hang
process.env.APP_URL = "http://localhost:3000";
// Deterministic 64-hex key, computed at runtime so the file holds no
// secret-looking literal (decision #79).
process.env.TOKEN_ENCRYPTION_KEY = crypto
  .createHash("sha256")
  .update("genze-test-token-encryption-key")
  .digest("hex");
process.env.NOTION_MCP_CLIENT_ID = "test-notion-client-id-made-of-words";
process.env.NOTION_MCP_CLIENT_SECRET = "test-notion-client-secret-made-of-words";
// Slack/GitHub/Dropbox OAuth creds intentionally unset -> NOT_CONFIGURED paths.

const MANAGED = [
  "TOKEN_ENCRYPTION_KEY",
  "NOTION_MCP_CLIENT_ID",
  "NOTION_MCP_CLIENT_SECRET",
  "NOTION_MCP_URL",
];

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof globalThis.fetch | undefined;

let app: FastifyInstance;

// ---- fetch stub -----------------------------------------------------------
interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
let fetchCalls: FetchCall[];
let tokenHandler: ((url: string, init: RequestInit) => Response | Promise<Response>) | null;
let gmailHandler: ((url: string, init: RequestInit) => Response | Promise<Response>) | null;
// Prefix-routed mock handlers for arbitrary URLs (e.g. OAuth discovery chain).
let mockRouteHandlers: Array<{
  prefix: string;
  handler: (url: string, init: RequestInit) => Response | Promise<Response>;
}>;
let realFetch: typeof globalThis.fetch;

const jsonRes = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---- fake MCP transport ----------------------------------------------------
interface FakeTool {
  name: string;
  description: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema?: Record<string, unknown>;
}

class FakeMcpTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  listCalls = 0;
  callCalls: Array<{ name: string; args: unknown }> = [];
  constructor(
    private tools: FakeTool[],
    private onCall?: (name: string, args: unknown) => unknown,
    private failCalls = false,
  ) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  private respond(
    req: JSONRPCRequest,
    payload: { result?: unknown; error?: { code: number; message: string } },
  ): void {
    const base = { jsonrpc: "2.0", id: req.id };
    const msg =
      payload.error !== undefined
        ? { ...base, error: payload.error }
        : { ...base, result: payload.result ?? {} };
    queueMicrotask(() => this.onmessage?.(msg as JSONRPCResponse));
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const req = message as JSONRPCRequest;
    if (!req.method || typeof req.id === "undefined") return; // notification
    if (req.method === "initialize") {
      const pv =
        (req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-06-18";
      // The SDK v2 Client refuses listTools/callTool unless the server
      // advertises the tools capability — advertise it like a real server.
      this.respond(req, {
        result: {
          protocolVersion: pv,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "0.0.1" },
        },
      });
      return;
    }
    if (req.method === "tools/list") {
      this.listCalls++;
      this.respond(req, { result: { tools: this.tools } });
      return;
    }
    if (req.method === "tools/call") {
      const params = (req.params ?? {}) as { name: string; arguments?: unknown };
      this.callCalls.push({ name: params.name, args: params.arguments });
      if (this.failCalls) {
        this.respond(req, { error: { code: -32000, message: "vendor exploded" } });
        return;
      }
      this.respond(req, {
        result: this.onCall
          ? this.onCall(params.name, params.arguments)
          : { content: [{ type: "text", text: "fake-ok" }] },
      });
      return;
    }
    this.respond(req, { error: { code: -32601, message: "Method not found" } });
  }
}

const NOTION_TOOLS: FakeTool[] = [
  {
    name: "notion-search",
    description: "Search pages",
    annotations: { readOnlyHint: true },
    // The SDK v2 validates tools/list strictly: inputSchema is required.
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notion-create-page",
    description: "Create a page",
    inputSchema: { type: "object", properties: {} },
  }, // no annotation => write tool
];

function useFakeMcp(opts: { failCalls?: boolean } = {}): FakeMcpTransport {
  const fake = new FakeMcpTransport(NOTION_TOOLS, undefined, opts.failCalls ?? false);
  setMcpTransportFactory(() => fake);
  return fake;
}

// ---- helpers ---------------------------------------------------------------
async function newUser(): Promise<{ token: string; userId: string }> {
  const em = email(`conn-${randomUUID().slice(0, 6)}`);
  const token = await signupVerifyLogin(app, em);
  const r = await getPool().query<{ id: string }>("SELECT id FROM users WHERE email = $1", [em]);
  return { token, userId: r.rows[0].id };
}

function stateOfUrl(url: string): string {
  const s = new URL(url).searchParams.get("state");
  expect(s).toBeTruthy();
  return s!;
}

async function connectNotion(token: string, access = "vendor-access-token-words"): Promise<void> {
  tokenHandler = (_url, init) =>
    jsonRes({ access_token: access, refresh_token: "vendor-refresh-token-words", expires_in: 3600 });
  const res = await app.inject({
    method: "GET",
    url: CONNECTOR_ROUTES.connectorAuthorize("notion"),
    headers: authHeader(token),
  });
  expect(res.statusCode).toBe(200);
  const cb = await app.inject({
    method: "GET",
    url: `${CONNECTOR_ROUTES.connectorCallback("notion")}?code=auth-code-words&state=${stateOfUrl(res.json().data.url)}`,
    headers: authHeader(token),
  });
  expect(cb.statusCode).toBe(200);
  expect(cb.json().data.connected).toBe(true);
}

async function count(table: string, userId: string, connectorId?: string): Promise<number> {
  const where =
    connectorId !== undefined
      ? "WHERE user_id = $1 AND connector_id = $2"
      : "WHERE user_id = $1";
  const r = await getPool().query(
    `SELECT count(*)::int AS n FROM ${table} ${where}`,
    connectorId !== undefined ? [userId, connectorId] : [userId],
  );
  return r.rows[0].n as number;
}

// ---- suite -----------------------------------------------------------------
beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
});

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED) {
    savedEnv[k] = process.env[k];
  }
  savedFetch = globalThis.fetch;
  realFetch = savedFetch!;
  fetchCalls = [];
  tokenHandler = null;
  gmailHandler = null;
  mockRouteHandlers = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    // Loopback passes through to the real network (mock MCP servers).
    if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(u)) {
      return realFetch(u, init);
    }
    fetchCalls.push({ url: u, init });
    for (const { prefix, handler } of mockRouteHandlers) {
      if (u.startsWith(prefix)) return handler(u, init ?? {});
    }
    if (u.includes("/oauth/token") || u.includes("oauth.v2.access") || u.includes("oauth/access_token")) {
      if (tokenHandler) return tokenHandler(u, init ?? {});
    }
    if (u.startsWith("https://gmail.googleapis.com/")) {
      if (gmailHandler) return gmailHandler(u, init ?? {});
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof globalThis.fetch;
  useFakeMcp();
});

afterEach(() => {
  for (const k of MANAGED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch!;
  setMcpTransportFactory(null);
});

afterAll(async () => {
  await closeRedis();
  await closePool();
});

describe("token encryption key config", () => {
  function restoreFileEnv() {
    process.env.TOKEN_ENCRYPTION_KEY = crypto
      .createHash("sha256")
      .update("genze-test-token-encryption-key")
      .digest("hex");
    resetConfig();
    loadConfig(); // re-memoize with the file's env
  }
  it("auto-generates a 64-hex dev key when unset", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.tokenEncryptionKey).toMatch(/^[0-9a-f]{64}$/);
    restoreFileEnv();
  });
  it("rejects a short key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "too-short";
    resetConfig();
    expect(() => loadConfig()).toThrow(/64 hex/);
    restoreFileEnv();
  });
  it("rejects a non-hex 64-char key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "x".repeat(64);
    resetConfig();
    expect(() => loadConfig()).toThrow(/64 hex/);
    restoreFileEnv();
  });
});

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips and uses format iv:ct:tag hex", () => {
    const enc = encryptToken("some-oauth-token");
    expect(enc.split(":")).toHaveLength(3);
    expect(enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decryptToken(enc)).toBe("some-oauth-token");
  });
  it("uses a fresh random IV per encryption", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same");
    expect(decryptToken(b)).toBe("same");
  });
  it("rejects tampered payloads", () => {
    const enc = encryptToken("secret");
    const [iv, ct, tag] = enc.split(":");
    const flipped = ct.slice(0, -1) + (ct.endsWith("0") ? "1" : "0");
    expect(() => decryptToken(`${iv}:${flipped}:${tag}`)).toThrow();
    expect(() => decryptToken("not-a-payload")).toThrow();
  });
});

describe("connector directory", () => {
  it("lists all 8 connectors with honest availability", async () => {
    const { token } = await newUser();
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectors,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().data.connectors as Array<{ id: string; availability: string; connected: boolean }>;
    expect(list).toHaveLength(8);
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    expect(byId["notion"].availability).toBe("available");
    expect(byId["slack"].availability).toBe("beta");
    expect(byId["github"].availability).toBe("beta");
    expect(byId["dropbox"].availability).toBe("beta");
    expect(byId["google-drive"].availability).toBe("not_available_yet");
    expect(byId["gmail"].availability).toBe("not_available_yet");
    expect(byId["google-calendar"].availability).toBe("not_available_yet");
    expect(byId["onedrive"].availability).toBe("coming_later");
    expect(list.every((c) => c.connected === false)).toBe(true);
    // never leaks secrets
    expect(JSON.stringify(res.json())).not.toContain("test-notion-client-secret");
  });

  it("marks a connector connected after OAuth", async () => {
    const { token } = await newUser();
    await connectNotion(token);
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectors,
      headers: authHeader(token),
    });
    const byId = Object.fromEntries(
      (res.json().data.connectors as Array<{ id: string; connected: boolean; connectedAt: string | null }>).map(
        (c) => [c.id, c],
      ),
    );
    expect(byId["notion"].connected).toBe(true);
    expect(byId["notion"].connectedAt).toBeTruthy();
    expect(byId["slack"].connected).toBe(false);
  });
});

describe("OAuth authorize", () => {
  it("returns a PKCE authorize URL and stores the state", async () => {
    const { token, userId } = await newUser();
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorAuthorize("notion"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().data.url as string);
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-notion-client-id-made-of-words");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/settings/connectors/callback?connector=notion",
    );
    expect(await count("connector_oauth_states", userId, "notion")).toBe(1);
  });

  it("unknown connector -> 404", async () => {
    const { token } = await newUser();
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorAuthorize("nope"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("gated connectors -> 503 CONNECTOR_NOT_AVAILABLE", async () => {
    const { token } = await newUser();
    for (const id of ["google-drive", "gmail", "google-calendar", "onedrive"]) {
      const res = await app.inject({
        method: "GET",
        url: CONNECTOR_ROUTES.connectorAuthorize(id),
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("CONNECTOR_NOT_AVAILABLE");
    }
  });

  it("missing OAuth env -> 503 NOT_CONFIGURED", async () => {
    const { token } = await newUser();
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorAuthorize("slack"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NOT_CONFIGURED");
  });
});

describe("OAuth callback", () => {
  it("exchanges the code and stores ENCRYPTED tokens", async () => {
    const { token, userId } = await newUser();
    let seenBody = "";
    tokenHandler = (_url, init) => {
      seenBody = String(init.body);
      return jsonRes({
        access_token: "vendor-access-token-abc",
        refresh_token: "vendor-refresh-token-def",
        expires_in: 3600,
        scope: "read write",
      });
    };
    const authRes = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorAuthorize("notion"),
      headers: authHeader(token),
    });
    const state = stateOfUrl(authRes.json().data.url);
    const res = await app.inject({
      method: "GET",
      url: `${CONNECTOR_ROUTES.connectorCallback("notion")}?code=auth-code-words&state=${state}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.connected).toBe(true);
    // PKCE verifier was sent to the vendor
    expect(seenBody).toContain("grant_type=authorization_code");
    expect(seenBody).toContain("code_verifier=");

    const row = (
      await getPool().query(
        `SELECT access_token, refresh_token, scopes FROM connector_accounts WHERE user_id = $1 AND connector_id = 'notion'`,
        [userId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    expect(row.access_token).not.toContain("vendor-access-token-abc");
    expect(row.refresh_token).not.toContain("vendor-refresh-token-def");
    expect(decryptToken(row.access_token)).toBe("vendor-access-token-abc");
    expect(decryptToken(row.refresh_token)).toBe("vendor-refresh-token-def");
    expect(row.scopes).toEqual(["read", "write"]);
    // state is single-use: the row is gone
    expect(await count("connector_oauth_states", userId, "notion")).toBe(0);
    // audit recorded the connect
    const audit = await getPool().query(
      `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = 'notion'`,
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain("connect");
  });

  it("reused state -> 400 VALIDATION_ERROR", async () => {
    const { token } = await newUser();
    tokenHandler = () => jsonRes({ access_token: "tok" });
    const authRes = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorAuthorize("notion"),
      headers: authHeader(token),
    });
    const state = stateOfUrl(authRes.json().data.url);
    const cb = (s: string) =>
      app.inject({
        method: "GET",
        url: `${CONNECTOR_ROUTES.connectorCallback("notion")}?code=c&state=${s}`,
        headers: authHeader(token),
      });
    expect((await cb(state)).statusCode).toBe(200);
    const again = await cb(state);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("unknown or stale state -> 400", async () => {
    const { token, userId } = await newUser();
    const bad = await app.inject({
      method: "GET",
      url: `${CONNECTOR_ROUTES.connectorCallback("notion")}?code=c&state=${"0".repeat(64)}`,
      headers: authHeader(token),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");

    // stale (>30 min) row is ignored
    await getPool().query(
      `INSERT INTO connector_oauth_states (id, user_id, connector_id, state, code_verifier, created_at)
       VALUES ($1, $2, 'notion', $3, 'verifier', now() - interval '31 minutes')`,
      [randomUUID(), userId, "a".repeat(64)],
    );
    const stale = await app.inject({
      method: "GET",
      url: `${CONNECTOR_ROUTES.connectorCallback("notion")}?code=c&state=${"a".repeat(64)}`,
      headers: authHeader(token),
    });
    expect(stale.statusCode).toBe(400);
  });

  it("missing code/state -> 400", async () => {
    const { token } = await newUser();
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorCallback("notion"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("vendor token error -> 502 OAUTH_FAILED", async () => {
    const { token } = await newUser();
    tokenHandler = () => jsonRes({ error: "invalid_grant" }, 400);
    const authRes = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorAuthorize("notion"),
      headers: authHeader(token),
    });
    const res = await app.inject({
      method: "GET",
      url: `${CONNECTOR_ROUTES.connectorCallback("notion")}?code=bad&state=${stateOfUrl(authRes.json().data.url)}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("OAUTH_FAILED");
  });
});

describe("MCP tools", () => {
  it("lists tools with conservative readOnly flags", async () => {
    const { token } = await newUser();
    await connectNotion(token);
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorTools("notion"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const tools = res.json().data.tools as Array<{ name: string; readOnly: boolean }>;
    expect(tools.find((t) => t.name === "notion-search")?.readOnly).toBe(true);
    // no explicit readOnlyHint => needs confirmation
    expect(tools.find((t) => t.name === "notion-create-page")?.readOnly).toBe(false);
  });

  it("not connected -> 400 CONNECTOR_NOT_CONNECTED", async () => {
    const { token } = await newUser();
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorTools("notion"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CONNECTOR_NOT_CONNECTED");
  });

  it("read-only tool executes immediately, no confirmation", async () => {
    const { token, userId } = await newUser();
    await connectNotion(token);
    const fake = useFakeMcp();
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-search"),
      headers: authHeader(token),
      payload: { arguments: { query: "hello" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.result).toBeDefined();
    expect(fake.callCalls).toHaveLength(1);
    expect(fake.callCalls[0]).toEqual({ name: "notion-search", args: { query: "hello" } });
    expect(await count("connector_confirmations", userId)).toBe(0);
    const audit = await getPool().query(
      `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = 'notion'`,
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain("tool_call");
    // metered as connector_tool
    const usage = await getPool().query(
      `SELECT feature, provider FROM usage_events WHERE user_id = $1 AND feature = 'connector_tool'`,
      [userId],
    );
    expect(usage.rows.length).toBeGreaterThan(0);
    expect(usage.rows[0].provider).toBe("notion");
  });

  it("write tool without confirmationId returns confirmationRequired; vendor never called", async () => {
    const { token, userId } = await newUser();
    await connectNotion(token);
    const fake = useFakeMcp();
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-create-page"),
      headers: authHeader(token),
      payload: { arguments: { title: "New page" } },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.confirmationRequired).toBe(true);
    expect(data.confirmation.id).toBeTruthy();
    expect(data.confirmation.connectorId).toBe("notion");
    expect(data.confirmation.tool).toBe("notion-create-page");
    expect(data.confirmation.arguments).toEqual({ title: "New page" });
    expect(data.confirmation.summary).toContain("notion-create-page");
    expect(data.confirmation.expiresAt).toBeTruthy();
    expect(fake.callCalls).toHaveLength(0); // NOTHING executed
    expect(await count("connector_confirmations", userId, "notion")).toBe(1);
  });

  it("confirm executes the pending write and deletes the row", async () => {
    const { token, userId } = await newUser();
    await connectNotion(token);
    const fake = useFakeMcp();
    const pending = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-create-page"),
      headers: authHeader(token),
      payload: { arguments: { title: "New page" } },
    });
    const confirmationId = pending.json().data.confirmation.id as string;
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.confirmConfirmation(confirmationId),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.result).toBeDefined();
    expect(fake.callCalls).toHaveLength(1);
    expect(fake.callCalls[0].name).toBe("notion-create-page");
    expect(await count("connector_confirmations", userId)).toBe(0);
    const audit = await getPool().query(
      `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = 'notion' ORDER BY created_at`,
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain("write_confirmed");
  });

  it("tool call with confirmationId executes directly", async () => {
    const { token } = await newUser();
    await connectNotion(token);
    const fake = useFakeMcp();
    const pending = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-create-page"),
      headers: authHeader(token),
      payload: { arguments: { title: "Direct" } },
    });
    const confirmationId = pending.json().data.confirmation.id as string;
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-create-page"),
      headers: authHeader(token),
      payload: { arguments: { title: "Direct" }, confirmationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.result).toBeDefined();
    expect(fake.callCalls).toHaveLength(1);
  });

  it("mismatched confirmationId -> 410 CONFIRMATION_EXPIRED; vendor never called", async () => {
    const { token } = await newUser();
    await connectNotion(token);
    const fake = useFakeMcp();
    const pending = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-create-page"),
      headers: authHeader(token),
      payload: { arguments: { title: "A" } },
    });
    const confirmationId = pending.json().data.confirmation.id as string;
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-create-page"),
      headers: authHeader(token),
      payload: { arguments: { title: "DIFFERENT" }, confirmationId },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe("CONFIRMATION_EXPIRED");
    expect(fake.callCalls).toHaveLength(0);
  });

  it("expired confirmation -> 410 on confirm and on call", async () => {
    const { token, userId } = await newUser();
    await connectNotion(token);
    useFakeMcp();
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO connector_confirmations (id, user_id, connector_id, tool, arguments, summary, expires_at)
       VALUES ($1, $2, 'notion', 'notion-create-page', '{}', 'summary', now() - interval '1 minute')`,
      [id, userId],
    );
    const confirmRes = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.confirmConfirmation(id),
      headers: authHeader(token),
      payload: {},
    });
    expect(confirmRes.statusCode).toBe(410);
    expect(confirmRes.json().error.code).toBe("CONFIRMATION_EXPIRED");
    // expired row was cleaned up
    expect(await count("connector_confirmations", userId)).toBe(0);
  });

  it("cancel deletes the row and audits write_cancelled", async () => {
    const { token, userId } = await newUser();
    await connectNotion(token);
    const fake = useFakeMcp();
    const pending = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-create-page"),
      headers: authHeader(token),
      payload: { arguments: { title: "Nope" } },
    });
    const confirmationId = pending.json().data.confirmation.id as string;
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.cancelConfirmation(confirmationId),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cancelled).toBe(true);
    expect(fake.callCalls).toHaveLength(0);
    expect(await count("connector_confirmations", userId)).toBe(0);
    const audit = await getPool().query(
      `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = 'notion'`,
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain("write_cancelled");
  });

  it("unknown tool -> 404", async () => {
    const { token } = await newUser();
    await connectNotion(token);
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "nope"),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("vendor failure -> 502 CONNECTOR_ERROR", async () => {
    const { token } = await newUser();
    await connectNotion(token);
    useFakeMcp({ failCalls: true });
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-search"),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("CONNECTOR_ERROR");
  });
});

describe("token refresh", () => {
  async function seedAccount(
    userId: string,
    opts: { expired: boolean; withRefresh: boolean },
  ): Promise<void> {
    await getPool().query(`DELETE FROM connector_accounts WHERE user_id = $1 AND connector_id = 'notion'`, [
      userId,
    ]);
    await getPool().query(
      `INSERT INTO connector_accounts (id, user_id, connector_id, access_token, refresh_token, expires_at, scopes)
       VALUES ($1, $2, 'notion', $3, $4, $5, '{}')`,
      [
        randomUUID(),
        userId,
        encryptToken("old-access-token"),
        opts.withRefresh ? encryptToken("old-refresh-token") : null,
        opts.expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3600_000),
      ],
    );
  }

  it("expired token with refresh token is refreshed transparently", async () => {
    const { token, userId } = await newUser();
    await seedAccount(userId, { expired: true, withRefresh: true });
    let grant = "";
    tokenHandler = (_url, init) => {
      grant = String(init.body);
      return jsonRes({ access_token: "fresh-access-token", expires_in: 3600 });
    };
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorTools("notion"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(grant).toContain("grant_type=refresh_token");
    const row = (
      await getPool().query(`SELECT access_token FROM connector_accounts WHERE user_id = $1 AND connector_id = 'notion'`, [
        userId,
      ])
    ).rows[0];
    expect(decryptToken(row.access_token)).toBe("fresh-access-token");
  });

  it("expired token without refresh token is blocked (502)", async () => {
    const { token, userId } = await newUser();
    await seedAccount(userId, { expired: true, withRefresh: false });
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorTools("notion"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("OAUTH_FAILED");
  });

  it("failed refresh is blocked (502)", async () => {
    const { token, userId } = await newUser();
    await seedAccount(userId, { expired: true, withRefresh: true });
    tokenHandler = () => jsonRes({ error: "invalid_grant" }, 400);
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorTools("notion"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("OAUTH_FAILED");
  });
});

describe("disconnect", () => {
  it("deletes tokens but keeps the audit trail", async () => {
    const { token, userId } = await newUser();
    await connectNotion(token);
    useFakeMcp();
    // generate some audit entries
    await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-search"),
      headers: authHeader(token),
      payload: {},
    });
    expect(await count("connector_accounts", userId, "notion")).toBe(1);
    expect(await count("connector_audit_log", userId, "notion")).toBeGreaterThan(0);

    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorDisconnect("notion"),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.disconnected).toBe(true);
    expect(await count("connector_accounts", userId, "notion")).toBe(0);
    // Audit trail is append-only: history kept, disconnect recorded.
    const actions = (
      await getPool().query(
        `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = 'notion' ORDER BY created_at`,
        [userId],
      )
    ).rows.map((r) => r.action);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[actions.length - 1]).toBe("disconnect");
    expect(await count("connector_confirmations", userId, "notion")).toBe(0);
    // tools now report not connected
    const tools = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorTools("notion"),
      headers: authHeader(token),
    });
    expect(tools.statusCode).toBe(400);
    expect(tools.json().error.code).toBe("CONNECTOR_NOT_CONNECTED");
  });

  it("unknown connector -> 404", async () => {
    const { token } = await newUser();
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorDisconnect("nope"),
      headers: authHeader(token),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("audit log", () => {
  it("records every action, newest first, own log only", async () => {
    const { token, userId } = await newUser();
    const other = await newUser();
    await connectNotion(token);
    await connectNotion(other.token);
    useFakeMcp();
    await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.connectorToolCall("notion", "notion-search"),
      headers: authHeader(token),
      payload: {},
    });
    const res = await app.inject({
      method: "GET",
      url: CONNECTOR_ROUTES.connectorAudit,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().data.entries as Array<{ action: string; createdAt: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("connect");
    expect(actions).toContain("tool_call");
    // newest first
    const times = entries.map((e) => new Date(e.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // other user's connect is not visible
    expect(await count("connector_audit_log", userId, "notion")).toBe(entries.length);
  });
});

describe("gmail send", () => {
  const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

  async function seedGmail(userId: string, scopes: string[]): Promise<void> {
    await getPool().query(`DELETE FROM connector_accounts WHERE user_id = $1 AND connector_id = 'gmail'`, [
      userId,
    ]);
    await getPool().query(
      `INSERT INTO connector_accounts (id, user_id, connector_id, access_token, refresh_token, expires_at, scopes)
       VALUES ($1, $2, 'gmail', $3, NULL, NULL, $4)`,
      [randomUUID(), userId, encryptToken("gmail-access-token-words"), scopes],
    );
  }

  function b64urlDecode(raw: string): string {
    return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }

  it("requires confirmation first; the Gmail API is never called without one", async () => {
    const { token, userId } = await newUser();
    await seedGmail(userId, [GMAIL_SEND_SCOPE]);
    gmailHandler = () => jsonRes({ id: "msg-1" });
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.gmailSend,
      headers: authHeader(token),
      payload: { to: "friend@example.com", subject: "Hi", body: "Hello there" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.confirmationRequired).toBe(true);
    expect(data.confirmation.tool).toBe("gmail.send");
    expect(fetchCalls.filter((c) => c.url.startsWith("https://gmail.googleapis.com/"))).toHaveLength(0);
  });

  it("sends via the Gmail API once confirmed", async () => {
    const { token, userId } = await newUser();
    await seedGmail(userId, [GMAIL_SEND_SCOPE]);
    let sentBody = "";
    gmailHandler = (_url, init) => {
      sentBody = String(init.body);
      return jsonRes({ id: "msg-123" });
    };
    const pending = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.gmailSend,
      headers: authHeader(token),
      payload: { to: "friend@example.com", subject: "Hi there", body: "Hello there" },
    });
    const confirmationId = pending.json().data.confirmation.id as string;
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.gmailSend,
      headers: authHeader(token),
      payload: { to: "friend@example.com", subject: "Hi there", body: "Hello there", confirmationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.result).toEqual({ sent: true, messageId: "msg-123" });
    expect(fetchCalls.filter((c) => c.url.startsWith("https://gmail.googleapis.com/"))).toHaveLength(1);
    const raw = (JSON.parse(sentBody) as { raw: string }).raw;
    const decoded = b64urlDecode(raw);
    expect(decoded).toContain("To: friend@example.com");
    expect(decoded).toContain("Subject: Hi there");
    expect(decoded).toContain("Hello there");
    expect(await count("connector_confirmations", userId)).toBe(0);
    const audit = await getPool().query(
      `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = 'gmail'`,
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain("write_confirmed");
  });

  it("missing gmail.send scope -> 403 naming the missing permission", async () => {
    const { token, userId } = await newUser();
    await seedGmail(userId, ["https://www.googleapis.com/auth/gmail.readonly"]);
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.gmailSend,
      headers: authHeader(token),
      payload: { to: "friend@example.com", subject: "Hi", body: "Hello" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/send email/i);
  });

  it("not connected -> 400 CONNECTOR_NOT_CONNECTED", async () => {
    const { token } = await newUser();
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.gmailSend,
      headers: authHeader(token),
      payload: { to: "friend@example.com", subject: "Hi", body: "Hello" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CONNECTOR_NOT_CONNECTED");
  });

  it("validation -> 400", async () => {
    const { token, userId } = await newUser();
    await seedGmail(userId, [GMAIL_SEND_SCOPE]);
    const res = await app.inject({
      method: "POST",
      url: CONNECTOR_ROUTES.gmailSend,
      headers: authHeader(token),
      payload: { to: "not-an-email", subject: "", body: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("custom connectors (Step 6b)", () => {
  // ---- mock Streamable HTTP MCP server (real transport, no SDK fake) ----
  interface MockMcp {
    url: string;
    calls: Array<{ method: string; params: unknown }>;
    close: () => Promise<void>;
  }

  async function startMockMcpServer(): Promise<MockMcp> {
    const calls: Array<{ method: string; params: unknown }> = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
        try {
          msg = JSON.parse(body || "{}");
        } catch {
          msg = {};
        }
        if (msg.method) calls.push({ method: msg.method, params: msg.params });
        if (msg.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const send = (payload: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        switch (msg.method) {
          case "initialize": {
            const pv =
              (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ??
              "2025-06-18";
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: pv,
                capabilities: { tools: {} },
                serverInfo: { name: "mock-mcp", version: "1.0.0" },
              },
            });
            return;
          }
          case "tools/list":
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  {
                    name: "mock-read",
                    description: "Read things",
                    inputSchema: { type: "object", properties: {} },
                    annotations: { readOnlyHint: true },
                  },
                  {
                    name: "mock-write",
                    description: "Write things",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            });
            return;
          case "tools/call": {
            const p = (msg.params ?? {}) as { name?: string; arguments?: unknown };
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [
                  { type: "text", text: `called:${p.name}:${JSON.stringify(p.arguments ?? {})}` },
                ],
              },
            });
            return;
          }
          default:
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${addr.port}/mcp`,
      calls,
      close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  let mock: MockMcp | null = null;
  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  async function registerCustom(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: any }> {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.customConnectors,
      headers: authHeader(token),
      payload: body,
    });
    return { status: res.statusCode, json: res.json() };
  }

  describe("registration", () => {
    it("registers a token-auth server; token stored encrypted", async () => {
      const { token, userId } = await newUser();
      mock = await startMockMcpServer();
      const { status, json } = await registerCustom(token, {
        name: "My MCP",
        mcpUrl: mock.url,
        authType: "token",
        token: "pasted-token-words",
      });
      expect(status).toBe(201);
      const c = json.data.connector;
      expect(c.name).toBe("My MCP");
      expect(c.mcpUrl).toBe(mock.url);
      expect(c.authType).toBe("token");
      expect(c.connected).toBe(true);
      expect(c.fallback).toBeNull();
      const row = (
        await getPool().query(`SELECT access_token FROM custom_connectors WHERE user_id = $1`, [userId])
      ).rows[0];
      expect(row.access_token).not.toContain("pasted-token-words");
      expect(decryptToken(row.access_token)).toBe("pasted-token-words");
      // audit connect written
      const audit = await getPool().query(
        `SELECT action, details FROM connector_audit_log WHERE user_id = $1 AND connector_id = $2`,
        [userId, c.id],
      );
      expect(audit.rows[0].action).toBe("connect");
      expect(audit.rows[0].details).toMatchObject({ custom: true, authType: "token" });
    });

    it("accepts an optional browser fallback marker", async () => {
      const { token } = await newUser();
      mock = await startMockMcpServer();
      const { status, json } = await registerCustom(token, {
        name: "Fallback MCP",
        mcpUrl: mock.url,
        authType: "token",
        token: "tok",
        fallback: "browser",
      });
      expect(status).toBe(201);
      expect(json.data.connector.fallback).toBe("browser");
    });

    it("duplicate URL for the same user -> 409", async () => {
      const { token } = await newUser();
      mock = await startMockMcpServer();
      const body = { name: "Dup", mcpUrl: mock.url, authType: "token", token: "tok" };
      expect((await registerCustom(token, body)).status).toBe(201);
      const again = await registerCustom(token, { ...body, name: "Dup 2" });
      expect(again.status).toBe(409);
      expect(again.json.error.code).toBe("CONFLICT");
    });

    it("different users may register the same URL", async () => {
      const a = await newUser();
      const b = await newUser();
      mock = await startMockMcpServer();
      const body = { name: "Shared", mcpUrl: mock.url, authType: "token", token: "tok" };
      expect((await registerCustom(a.token, body)).status).toBe(201);
      expect((await registerCustom(b.token, body)).status).toBe(201);
    });

    it("invalid URLs -> 400", async () => {
      const { token } = await newUser();
      for (const mcpUrl of ["not a url", "ftp://example.com/mcp", "http://example.com/mcp", ""]) {
        const r = await registerCustom(token, { name: "Bad", mcpUrl, authType: "token", token: "tok" });
        expect(r.status).toBe(400);
        expect(r.json.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("validation: name/authType/token/fallback", async () => {
      const { token } = await newUser();
      mock = await startMockMcpServer();
      const good = { name: "V", mcpUrl: mock.url, authType: "token", token: "tok" };
      // empty name
      expect((await registerCustom(token, { ...good, name: "" })).status).toBe(400);
      // unknown authType
      expect((await registerCustom(token, { ...good, authType: "magic" })).status).toBe(400);
      // token missing for token auth
      expect((await registerCustom(token, { ...good, token: undefined })).status).toBe(400);
      // token present with oauth auth
      expect((await registerCustom(token, { ...good, authType: "oauth", token: "tok" })).status).toBe(400);
      // bad fallback
      expect((await registerCustom(token, { ...good, fallback: "email" })).status).toBe(400);
    });

    it("lists and gets own connectors; other users' -> 404", async () => {
      const a = await newUser();
      const b = await newUser();
      mock = await startMockMcpServer();
      const created = await registerCustom(a.token, {
        name: "Mine",
        mcpUrl: mock.url,
        authType: "token",
        token: "tok",
      });
      const id = created.json.data.connector.id;
      const list = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnectors,
        headers: authHeader(a.token),
      });
      expect(list.statusCode).toBe(200);
      expect((list.json().data.connectors as unknown[])).toHaveLength(1);
      const otherList = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnectors,
        headers: authHeader(b.token),
      });
      expect((otherList.json().data.connectors as unknown[])).toHaveLength(0);
      const otherGet = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnector(id),
        headers: authHeader(b.token),
      });
      expect(otherGet.statusCode).toBe(404);
    });
  });

  describe("tools on custom connectors (real Streamable HTTP transport)", () => {
    it("lists tools, read-only executes, write needs confirmation — identical to built-ins", async () => {
      const { token, userId } = await newUser();
      mock = await startMockMcpServer();
      // Use the REAL SDK transport for custom connectors (no fake factory).
      setMcpTransportFactory(null);
      const created = await registerCustom(token, {
        name: "Real MCP",
        mcpUrl: mock.url,
        authType: "token",
        token: "tok",
      });
      const id = created.json.data.connector.id as string;

      const toolsRes = await app.inject({
        method: "GET",
        url: CONNECTOR_ROUTES.connectorTools(id),
        headers: authHeader(token),
      });
      expect(toolsRes.statusCode).toBe(200);
      const tools = toolsRes.json().data.tools as Array<{ name: string; readOnly: boolean }>;
      expect(tools.find((t) => t.name === "mock-read")?.readOnly).toBe(true);
      expect(tools.find((t) => t.name === "mock-write")?.readOnly).toBe(false);

      // read-only executes immediately
      const readRes = await app.inject({
        method: "POST",
        url: CONNECTOR_ROUTES.connectorToolCall(id, "mock-read"),
        headers: authHeader(token),
        payload: { arguments: { q: "hi" } },
      });
      expect(readRes.statusCode).toBe(200);
      expect(JSON.stringify(readRes.json().data.result)).toContain("called:mock-read");

      // write without confirmation -> confirmationRequired; vendor never called
      const callsBefore = mock.calls.filter((c) => c.method === "tools/call").length;
      const writeRes = await app.inject({
        method: "POST",
        url: CONNECTOR_ROUTES.connectorToolCall(id, "mock-write"),
        headers: authHeader(token),
        payload: { arguments: { text: "hello" } },
      });
      expect(writeRes.statusCode).toBe(200);
      expect(writeRes.json().data.confirmationRequired).toBe(true);
      const confirmationId = writeRes.json().data.confirmation.id as string;
      expect(mock.calls.filter((c) => c.method === "tools/call").length).toBe(callsBefore);

      // confirm executes
      const confirmRes = await app.inject({
        method: "POST",
        url: CONNECTOR_ROUTES.confirmConfirmation(confirmationId),
        headers: authHeader(token),
        payload: {},
      });
      expect(confirmRes.statusCode).toBe(200);
      expect(JSON.stringify(confirmRes.json().data.result)).toContain("called:mock-write");
      expect(mock.calls.filter((c) => c.method === "tools/call").length).toBe(callsBefore + 1);

      // audit + metering match built-in semantics
      const audit = await getPool().query(
        `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = $2`,
        [userId, id],
      );
      const actions = audit.rows.map((r) => r.action as string);
      expect(actions).toContain("tool_call");
      expect(actions).toContain("write_confirmed");
      const usage = await getPool().query(
        `SELECT provider FROM usage_events WHERE user_id = $1 AND feature = 'connector_tool'`,
        [userId],
      );
      expect(usage.rows.map((r) => r.provider)).toContain(id);
    });

    it("unknown custom uuid -> 404 on shared endpoints", async () => {
      const { token } = await newUser();
      const nope = randomUUID();
      const tools = await app.inject({
        method: "GET",
        url: CONNECTOR_ROUTES.connectorTools(nope),
        headers: authHeader(token),
      });
      expect(tools.statusCode).toBe(404);
      const call = await app.inject({
        method: "POST",
        url: CONNECTOR_ROUTES.connectorToolCall(nope, "x"),
        headers: authHeader(token),
        payload: {},
      });
      expect(call.statusCode).toBe(404);
    });

    it("not connected (oauth, no tokens yet) -> 400 CONNECTOR_NOT_CONNECTED", async () => {
      const { token } = await newUser();
      const created = await registerCustom(token, {
        name: "OAuth MCP",
        mcpUrl: "https://mcp.example.com/mcp",
        authType: "oauth",
      });
      expect(created.status).toBe(201);
      expect(created.json.data.connector.connected).toBe(false);
      const id = created.json.data.connector.id as string;
      const tools = await app.inject({
        method: "GET",
        url: CONNECTOR_ROUTES.connectorTools(id),
        headers: authHeader(token),
      });
      expect(tools.statusCode).toBe(400);
      expect(tools.json().error.code).toBe("CONNECTOR_NOT_CONNECTED");
    });
  });

  describe("OAuth discovery", () => {
    function mockDiscoveryChain() {
      mockRouteHandlers.push({
        prefix: "https://mcp.example.com/mcp",
        handler: () =>
          new Response("", {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://auth.example.com/.well-known/oauth-protected-resource"',
            },
          }),
      });
      mockRouteHandlers.push({
        prefix: "https://auth.example.com/.well-known/oauth-protected-resource",
        handler: () => jsonRes({ authorization_servers: ["https://auth.example.com"] }),
      });
      mockRouteHandlers.push({
        prefix: "https://auth.example.com/.well-known/oauth-authorization-server",
        handler: () =>
          jsonRes({
            authorization_endpoint: "https://auth.example.com/authorize",
            token_endpoint: "https://auth.example.com/token",
            registration_endpoint: "https://auth.example.com/register",
            revocation_endpoint: "https://auth.example.com/revoke",
          }),
      });
    }

    it("follows 401 -> resource metadata -> server metadata", async () => {
      mockDiscoveryChain();
      const d = await discoverOAuth("https://mcp.example.com/mcp");
      expect(d).toEqual({
        authorizeUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        registrationUrl: "https://auth.example.com/register",
        revocationUrl: "https://auth.example.com/revoke",
      });
    });

    it("any failure -> null", async () => {
      // no 401
      mockRouteHandlers.push({ prefix: "https://plain.example.com/", handler: () => jsonRes({}) });
      expect(await discoverOAuth("https://plain.example.com/mcp")).toBeNull();
      // 401 without the header
      mockRouteHandlers.push({
        prefix: "https://noheader.example.com/",
        handler: () => new Response("", { status: 401 }),
      });
      expect(await discoverOAuth("https://noheader.example.com/mcp")).toBeNull();
      // unreachable
      expect(await discoverOAuth("https://unreachable.invalid/mcp")).toBeNull();
    });

    it("custom authorize runs discovery + dynamic registration, callback connects", async () => {
      const { token, userId } = await newUser();
      mockDiscoveryChain();
      mockRouteHandlers.push({
        prefix: "https://auth.example.com/register",
        handler: () => jsonRes({ client_id: "dynamic-client-id-words" }),
      });
      mockRouteHandlers.push({
        prefix: "https://auth.example.com/token",
        handler: () =>
          jsonRes({
            access_token: "custom-access-token-words",
            refresh_token: "custom-refresh-token-words",
            expires_in: 3600,
          }),
      });
      const created = await registerCustom(token, {
        name: "OAuth Server",
        mcpUrl: "https://mcp.example.com/mcp",
        authType: "oauth",
      });
      expect(created.status).toBe(201);
      const id = created.json.data.connector.id as string;

      const authRes = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnectorAuthorize(id),
        headers: authHeader(token),
      });
      expect(authRes.statusCode).toBe(200);
      const url = new URL(authRes.json().data.url as string);
      expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
      expect(url.searchParams.get("client_id")).toBe("dynamic-client-id-words");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      // redirect goes to the web's callback page with the connector uuid
      expect(url.searchParams.get("redirect_uri")).toBe(
        `http://localhost:3000/settings/connectors/callback?connector=${id}`,
      );
      const state = url.searchParams.get("state");
      expect(state).toBeTruthy();

      const cb = await app.inject({
        method: "GET",
        url: `${API_ROUTES.customConnectorCallback(id)}?code=auth-code-words&state=${state}`,
        headers: authHeader(token),
      });
      expect(cb.statusCode).toBe(200);
      expect(cb.json().data.connected).toBe(true);
      const row = (
        await getPool().query(
          `SELECT access_token, oauth_client_id FROM custom_connectors WHERE id = $1`,
          [id],
        )
      ).rows[0];
      expect(decryptToken(row.access_token)).toBe("custom-access-token-words");
      expect(row.oauth_client_id).toBe("dynamic-client-id-words");
      // state single-use
      const again = await app.inject({
        method: "GET",
        url: `${API_ROUTES.customConnectorCallback(id)}?code=auth-code-words&state=${state}`,
        headers: authHeader(token),
      });
      expect(again.statusCode).toBe(400);
      // audit
      const audit = await getPool().query(
        `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = $2`,
        [userId, id],
      );
      expect(audit.rows.map((r) => r.action)).toContain("connect");
    });

    it("authorize on a token-auth connector -> 400", async () => {
      const { token } = await newUser();
      mock = await startMockMcpServer();
      const created = await registerCustom(token, {
        name: "Token MCP",
        mcpUrl: mock.url,
        authType: "token",
        token: "tok",
      });
      const id = created.json.data.connector.id as string;
      const res = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnectorAuthorize(id),
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/saved token/);
    });

    it("discovery failure -> 502 OAUTH_FAILED", async () => {
      const { token } = await newUser();
      const created = await registerCustom(token, {
        name: "Dead Server",
        mcpUrl: "https://dead.example.com/mcp",
        authType: "oauth",
      });
      const id = created.json.data.connector.id as string;
      const res = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnectorAuthorize(id),
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("OAUTH_FAILED");
    });
  });

  describe("disconnect + delete", () => {
    it("disconnect keeps the row and clears tokens; audit kept", async () => {
      const { token, userId } = await newUser();
      mock = await startMockMcpServer();
      const created = await registerCustom(token, {
        name: "Temp MCP",
        mcpUrl: mock.url,
        authType: "token",
        token: "tok",
      });
      const id = created.json.data.connector.id as string;
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.customConnectorDisconnect(id),
        headers: authHeader(token),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.disconnected).toBe(true);
      const row = (
        await getPool().query(`SELECT access_token FROM custom_connectors WHERE id = $1`, [id])
      ).rows[0];
      expect(row).toBeDefined();
      expect(row.access_token).toBeNull();
      const get = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnector(id),
        headers: authHeader(token),
      });
      expect(get.json().data.connector.connected).toBe(false);
      const audit = await getPool().query(
        `SELECT action FROM connector_audit_log WHERE user_id = $1 AND connector_id = $2`,
        [userId, id],
      );
      expect(audit.rows.map((r) => r.action)).toContain("disconnect");
    });

    it("shared disconnect route also accepts a custom uuid", async () => {
      const { token, userId } = await newUser();
      mock = await startMockMcpServer();
      const created = await registerCustom(token, {
        name: "Shared Route MCP",
        mcpUrl: mock.url,
        authType: "token",
        token: "tok",
      });
      const id = created.json.data.connector.id as string;
      const res = await app.inject({
        method: "POST",
        url: CONNECTOR_ROUTES.connectorDisconnect(id),
        headers: authHeader(token),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const row = (
        await getPool().query(`SELECT access_token FROM custom_connectors WHERE id = $1`, [id])
      ).rows[0];
      expect(row.access_token).toBeNull();
      expect(userId).toBeTruthy();
    });

    it("DELETE removes the registration", async () => {
      const { token, userId } = await newUser();
      mock = await startMockMcpServer();
      const created = await registerCustom(token, {
        name: "Gone MCP",
        mcpUrl: mock.url,
        authType: "token",
        token: "tok",
      });
      const id = created.json.data.connector.id as string;
      const del = await app.inject({
        method: "DELETE",
        url: API_ROUTES.customConnector(id),
        headers: authHeader(token),
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().data.deleted).toBe(true);
      expect(
        (await getPool().query(`SELECT count(*)::int n FROM custom_connectors WHERE id = $1`, [id]))
          .rows[0].n,
      ).toBe(0);
      const get = await app.inject({
        method: "GET",
        url: API_ROUTES.customConnector(id),
        headers: authHeader(token),
      });
      expect(get.statusCode).toBe(404);
      expect(userId).toBeTruthy();
    });
  });

  describe("builtin directory fallback marker", () => {
    it("onedrive carries fallback browser; others null", async () => {
      const { token } = await newUser();
      const res = await app.inject({
        method: "GET",
        url: CONNECTOR_ROUTES.connectors,
        headers: authHeader(token),
      });
      const byId = Object.fromEntries(
        (res.json().data.connectors as Array<{ id: string; fallback: string | null }>).map((c) => [
          c.id,
          c,
        ]),
      );
      expect(byId["onedrive"].fallback).toBe("browser");
      expect(byId["notion"].fallback).toBeNull();
      expect(byId["slack"].fallback).toBeNull();
    });
  });
});
