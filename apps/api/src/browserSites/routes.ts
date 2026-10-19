// Browser-site routes (Fastify, prefix /api/v1/connectors/browser-sites, all auth).
// Contract: CONTRACTS.md — Step 8.
//
// Path table lives here (same convention as CONNECTOR_ROUTES in
// connectors/routes.ts); types + error codes live in @genze/shared.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { ConnectorError } from "../connectors/manager.js";
import {
  addSite,
  listSites,
  getSite,
  disconnectSite,
  beginLogin,
  completeLogin,
  checkHealth,
} from "./manager.js";

export const BROWSER_SITE_ROUTES = {
  browserSites: "/api/v1/connectors/browser-sites",
  browserSite: (siteId: string) => `/api/v1/connectors/browser-sites/${siteId}`,
  browserSiteLogin: (siteId: string) => `/api/v1/connectors/browser-sites/${siteId}/login`,
  browserSiteLoginComplete: (siteId: string) =>
    `/api/v1/connectors/browser-sites/${siteId}/login/complete`,
  browserSiteCheck: (siteId: string) => `/api/v1/connectors/browser-sites/${siteId}/check`,
} as const;

type Body = Record<string, unknown>;
function bodyOf(req: FastifyRequest): Body {
  return (req.body as Body | undefined) ?? {};
}
function authOf(req: FastifyRequest): { userId: string } {
  return req.auth as { userId: string };
}

/** Map ConnectorError to the contract envelope; anything else goes to the global handler. */
function handleRouteError(reply: FastifyReply, err: unknown) {
  if (err instanceof ConnectorError) {
    return sendError(reply, err.status, err.code, err.message);
  }
  throw err;
}

export async function browserSiteRoutes(app: FastifyInstance): Promise<void> {
  // List the user's browser sites (never secrets).
  app.get("/", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    return reply.send({ data: { sites: await listSites(userId) } });
  });

  // Add a site (name + URL). Shows as "works through the browser".
  app.post("/", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const body = bodyOf(req);
    try {
      const site = await addSite(userId, { name: body.name, url: body.url });
      return reply.code(201).send({ data: { site } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  // One site.
  app.get("/:id", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      return reply.send({ data: { site: await getSite(userId, id) } });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  // Begin a guided login: opens the site in a cloud browser, returns the
  // live view URL the user opens to log in themselves.
  app.post("/:id/login", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      return reply.send({ data: await beginLogin(userId, id) });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  // Finish a guided login: captures + verifies the profile.
  // Body: { loginSessionId }.
  app.post("/:id/login/complete", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    const { loginSessionId } = bodyOf(req);
    if (typeof loginSessionId !== "string" || !loginSessionId) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Missing login session.");
    }
    try {
      return reply.send({ data: await completeLogin(userId, id, loginSessionId) });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  // Health check now: is the saved login still valid?
  app.post("/:id/check", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      return reply.send({ data: await checkHealth(userId, id) });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });

  // Disconnect: destroys the saved login (profile blob wiped).
  app.delete("/:id", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = authOf(req);
    const id = (req.params as { id: string }).id;
    try {
      return reply.send({ data: await disconnectSite(userId, id) });
    } catch (err) {
      return handleRouteError(reply, err);
    }
  });
}
