// Custom connector routes (Fastify, prefix /api/v1/connectors/custom, all
// require auth). Contract: CONTRACTS.md — Step 6b. Users register ANY MCP
// server by URL; custom connectors get the identical treatment as built-ins:
// encrypted token storage, read-only-by-default + write confirmation cards,
// audit logging, disconnect/revoke.
//
// Path table lives in @genze/shared API_ROUTES (customConnectors,
// customConnector, customConnectorAuthorize, customConnectorCallback,
// customConnectorDisconnect).
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { ConnectorError, registerCustomConnector, listCustomConnectors, requireCustomConnector, deleteCustomConnector, customAuthorizeUrl, customHandleCallback, disconnect, toCustomConnectorPayload, } from "./manager.js";
function bodyOf(req) {
    return req.body ?? {};
}
function authOf(req) {
    return req.auth;
}
function handleRouteError(reply, err) {
    if (err instanceof ConnectorError) {
        return sendError(reply, err.status, err.code, err.message);
    }
    throw err;
}
export async function customConnectorRoutes(app) {
    // Register a custom MCP server.
    app.post("/", { preHandler: authenticate }, async (req, reply) => {
        const { userId } = authOf(req);
        const body = bodyOf(req);
        try {
            const connector = await registerCustomConnector(userId, {
                name: body.name,
                mcpUrl: body.mcpUrl,
                authType: body.authType,
                token: body.token,
                fallback: body.fallback,
            });
            return reply.code(201).send({ data: { connector } });
        }
        catch (err) {
            return handleRouteError(reply, err);
        }
    });
    app.get("/", { preHandler: authenticate }, async (req, reply) => {
        const { userId } = authOf(req);
        const connectors = await listCustomConnectors(userId);
        return reply.send({ data: { connectors } });
    });
    app.get("/:id", { preHandler: authenticate }, async (req, reply) => {
        const { userId } = authOf(req);
        const id = req.params.id;
        try {
            const row = await requireCustomConnector(userId, id);
            return reply.send({ data: { connector: toCustomConnectorPayload(row) } });
        }
        catch (err) {
            return handleRouteError(reply, err);
        }
    });
    app.delete("/:id", { preHandler: authenticate }, async (req, reply) => {
        const { userId } = authOf(req);
        const id = req.params.id;
        try {
            await deleteCustomConnector(userId, id);
            return reply.send({ data: { deleted: true } });
        }
        catch (err) {
            return handleRouteError(reply, err);
        }
    });
    app.get("/:id/authorize", { preHandler: authenticate }, async (req, reply) => {
        const { userId } = authOf(req);
        const id = req.params.id;
        try {
            const url = await customAuthorizeUrl(userId, id);
            return reply.send({ data: { url } });
        }
        catch (err) {
            return handleRouteError(reply, err);
        }
    });
    app.get("/:id/callback", { preHandler: authenticate }, async (req, reply) => {
        const { userId } = authOf(req);
        const id = req.params.id;
        const q = req.query;
        if (typeof q.code !== "string" || !q.code || typeof q.state !== "string" || !q.state) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Missing code or state.");
        }
        try {
            await customHandleCallback(userId, id, q.code, q.state);
            return reply.send({ data: { connected: true } });
        }
        catch (err) {
            return handleRouteError(reply, err);
        }
    });
    // Disconnect: keeps the registration row, clears the tokens.
    app.post("/:id/disconnect", { preHandler: authenticate }, async (req, reply) => {
        const { userId } = authOf(req);
        const id = req.params.id;
        try {
            await disconnect(userId, id);
            return reply.send({ data: { disconnected: true } });
        }
        catch (err) {
            return handleRouteError(reply, err);
        }
    });
}
//# sourceMappingURL=customRoutes.js.map