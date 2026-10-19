// Provider kill switches: three layers.
//
// 1. Env: PROVIDER_DISABLED (comma list). Always wins — a DB toggle cannot
//    override it. Read live at call time (synchronous).
// 2. DB: provider_killswitches, toggled by the owner via PATCH
//    /admin/providers/:id. Served from a small process-local cache because
//    the registry's isEnabled() is synchronous; the cache loads at boot
//    (buildApp) and is refreshed on every admin toggle.
// 3. Circuit breaker (circuit.ts): automatic, temporary, in-memory.
//
// "env" and "db" for the admin view: env-disabled => "env" (DB cannot
// override env); DB-killed or breaker-tripped => "db"; else null.

import { getPool } from "../db.js";

/** PROVIDER_DISABLED="anthropic,kling" — comma-separated kill switch. */
export function providerDisabledSet(): Set<string> {
  const raw = process.env.PROVIDER_DISABLED ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

let cache: Map<string, boolean> | null = null;

/**
 * Load the DB kill states into the process-local cache. Called at boot and
 * after every admin toggle.
 */
export async function refreshKillswitchCache(): Promise<void> {
  try {
    const r = await getPool().query<{ provider: string; killed: boolean }>(
      "SELECT provider, killed FROM provider_killswitches",
    );
    cache = new Map(r.rows.map((row) => [row.provider, row.killed]));
  } catch {
    // Table missing (migrations not run yet) => nothing is killed.
    cache = new Map();
  }
}

/** Sync read of the cached DB kill state. False when the cache never loaded. */
export function isDbKilled(id: string): boolean {
  return cache?.get(id) ?? false;
}

/** Upsert the DB kill row and refresh the cache entry. */
export async function setProviderKilled(id: string, killed: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO provider_killswitches (provider, killed, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (provider) DO UPDATE SET killed = $2, updated_at = now()`,
    [id, killed],
  );
  if (!cache) cache = new Map();
  cache.set(id, killed);
}

/** Test hook: drop the in-memory cache so the next read starts unloaded. */
export function resetKillswitchCache(): void {
  cache = null;
}

/**
 * Where a kill came from for the admin view. "env" when env-disabled (a DB
 * toggle cannot override env), "db" when DB-killed or breaker-tripped.
 */
export function killedBy(id: string, circuitTripped: boolean): "env" | "db" | null {
  if (providerDisabledSet().has(id)) return "env";
  if (isDbKilled(id) || circuitTripped) return "db";
  return null;
}

/** True when id is env-disabled OR DB-killed. Live DB read (no cache). */
export async function isProviderKilled(id: string): Promise<boolean> {
  if (providerDisabledSet().has(id)) return true;
  try {
    const r = await getPool().query<{ killed: boolean }>(
      "SELECT killed FROM provider_killswitches WHERE provider = $1",
      [id],
    );
    return r.rowCount ? r.rows[0].killed : false;
  } catch {
    return false;
  }
}
