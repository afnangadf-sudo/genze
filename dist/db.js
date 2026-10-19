// Postgres connection pool — lazy singleton so importing this module never
// touches the network (tests set DATABASE_URL before the first query).
import { Pool } from "pg";
import { loadConfig } from "./config.js";
let pool = null;
export function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: loadConfig().databaseUrl,
            max: 20,
            idleTimeoutMillis: 30000,
        });
        pool.on("error", (err) => console.error("[db] idle pool error:", err));
    }
    return pool;
}
export async function pingDb() {
    try {
        await getPool().query("SELECT 1");
        return true;
    }
    catch {
        return false;
    }
}
export async function closePool() {
    if (pool) {
        const p = pool;
        pool = null;
        await p.end();
    }
}
//# sourceMappingURL=db.js.map