// Connector routes (Fastify, prefix /api/v1/connectors, all require auth).
// Contract: CONTRACTS.md — Step 6.
//
// packages/shared is FROZEN for Step 6, so the path table lives here as
// CONNECTOR_ROUTES (same parameterized style as API_ROUTES) instead of in
// @genze/shared. The web client should import these from the API contract
// or mirror them.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { listDefinitions } from "./registry.js";
import type { ConnectorStatus, ConnectorAuditEntry } from "./types.js";
import {
  ConnectorError,
  authorizeUrl,
  handleCallback,
  disconnect,
  listTools,
  callTool,
  confirmPendingWrite,
  cancelPendingWrite,
} from "./manager.js";
import { sendGmail } from "./gmailSend.js";

export const CONNECTOR_ROUTES = {
  connectors: "/api/v1/connectors",
  connectorAuthorize: (id: string) => `/api/v1/connectors/${id}/authorize`,
  connectorCallback: (id: string) => `/api/v1/connectors/${id}/callback`,
  connectorDisconnect: (id: string) => `/api/v1/connectors/${id}/disconnect`,
  connectorTools: (id: string) => `/api/v1/connectors/${id}/tools`,
  connectorToolCall: (id: string, tool: string) =>
    `/api/v1/connectors/${id}/tools/${encodeURIComponent(tool)}/call`,
  gmailSend: "/api/v1/connectors/gmail/send",
  confirmConfirmation: (id: string) => `/api/v1/connectors/confirmations/${id}/confirm`,
  cancelConfirmation: (id: string) => `/api/v1/connectors/confirmations/${id}/cancel`,
  connectorAudit: "/api/v1/connectors/audit",
} as const;

type Body = Record<string, unknown>;
function bodyOf(req: FastifyRequest): Body {
  return (req.body as Body | undefined) ?? {};
}

function authOf(req: FastifyRequest): { userId: string } {
  return req.auth as { userId: string };
}

/** Map ConnectorError to the contract envelope; anything else goes to the global handler. */
function handleRouteError(reply: Parameters<typeof sendError>[0], err: unknown) {
  if (err instanceof ConnectorError) {
    return sendError(reply, err.status, err.code, err.message);
  }
  throw err;
}

interface DbConnected {
  connector_id: string;
  scopes: string[];
  created_at: Date;
}

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  // Directory: definition + connected flag + connectedAt. Never secrets.
  app.get("/", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const rows = await getPool().query<DbConnected>(
      `SELECT connector_id, scopes, created_at FROM connector_accounts WHERE user_id = $1`,
      [userId],
    );
    const byId = new Map(rows.rows.map((r) => [r.connector_id, r]));
    const connectors: ConnectorStatus[] = listDefinitions().map((def) => {
      const row = byId.get(def.id);
      return {
        id: def.id,
        name: def.name,
        blurb: def.blurb,
        availability: def.availability,
        connected: !!row,
        connectedAt: row ? new Date(row.created_at).toISOString() : null,
        scopes: row ? row.scopes : [],
        scopeLabels: def.scopeLabels,
        fallback: def.fallback,
      };
    });
    return reply.send({ data: { connectors } });
  });

  app.get("/:id/authorize", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      const url = await authorizeUrl(userId, id);
      return reply.send({ data: { url } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  app.get("/:id/callback", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    const q = req.query as { code?: unknown; state?: unknown };
    if (typeof q.code !== "string" || !q.code || typeof q.state !== "string" || !q.state) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Missing code or state.");
    }
    try {
      await handleCallback(userId, id, q.code, q.state);
      return reply.send({ data: { connected: true } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  app.post("/:id/disconnect", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      await disconnect(userId, id);
      return reply.send({ data: { disconnected: true } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  app.get("/:id/tools", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      const tools = await listTools(userId, id);
      return reply.send({ data: { tools } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  app.post("/:id/tools/:tool/call", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const { id, tool } = req.params as { id: string; tool: string };
    const body = bodyOf(req);
    const args =
      body.arguments === undefined
        ? {}
        : typeof body.arguments === "object" && body.arguments !== null && !Array.isArray(body.arguments)
          ? (body.arguments as Record<string, unknown>)
          : null;
    if (args === null) {
      return sendError(reply, 400, "VALIDATION_ERROR", "arguments must be an object.");
    }
    const confirmationId =
      typeof body.confirmationId === "string" && body.confirmationId ? body.confirmationId : undefined;
    try {
      const out = await callTool(userId, id, tool, args, { confirmationId });
      if (out && typeof out === "object" && "confirmationRequired" in out) {
        return reply.send({ data: out });
      }
      return reply.send({ data: { result: out } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  // Gmail send (direct Gmail API — the MCP server has no send tool).
  // Registered before /:id/* param routes for clarity; no path conflict.
  app.post("/gmail/send", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const body = bodyOf(req);
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject : "";
    const btext = typeof body.body === "string" ? body.body : "";
    if (!to || !to.includes("@") || !subject.trim() || !btext.trim()) {
      return sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "to (a valid email), subject, and body are required.",
      );
    }
    const confirmationId =
      typeof body.confirmationId === "string" && body.confirmationId ? body.confirmationId : undefined;
    try {
      const out = await sendGmail(userId, { to, subject, body: btext, confirmationId });
      if ("confirmationRequired" in out) {
        return reply.send({ data: out });
      }
      return reply.send({ data: { result: { sent: true, messageId: out.messageId } } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  app.post("/confirmations/:id/confirm", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      const result = await confirmPendingWrite(userId, id);
      return reply.send({ data: { result } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  app.post("/confirmations/:id/cancel", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      await cancelPendingWrite(userId, id);
      return reply.send({ data: { cancelled: true } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  app.get("/audit", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const rows = await getPool().query<{
      id: string;
      connector_id: string;
      action: string;
      details: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `SELECT id, connector_id, action, details, created_at
       FROM connector_audit_log WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    const entries: ConnectorAuditEntry[] = rows.rows.map((r) => ({
      id: r.id,
      connectorId: r.connector_id,
      action: r.action,
      details: r.details,
      createdAt: new Date(r.created_at).toISOString(),
    }));
    return reply.send({ data: { entries } });
  });
}
