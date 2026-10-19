// System routes: health and provider status.
import { pingDb } from "../db.js";
import { pingRedis } from "../redis.js";
import { getProviderStatus } from "../providers/registry.js";
export async function systemRoutes(app) {
    app.get("/health", async (_req, reply) => {
        const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
        // Redis is optional: the API counts as "ok" while the database is
        // reachable; a down Redis is reported as redis:false instead of failing.
        return reply.send({ data: { ok: db, db, redis } });
    });
    app.get("/providers/status", async (_req, reply) => {
        // getProviderStatus() exposes booleans only — secret values never leave
        // the server. The /providers/status test asserts this.
        return reply.send({ data: { providers: getProviderStatus() } });
    });
}
//# sourceMappingURL=system.js.map