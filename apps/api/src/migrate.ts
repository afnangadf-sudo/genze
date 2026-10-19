// Migration runner. Applies apps/api/migrations/*.sql in filename order,
// tracking applied files in schema_migrations. Every migration must be
// idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING).
//
// Used three ways:
//   1. `pnpm migrate`            -> this file as CLI
//   2. API boot (src/index.ts)   -> runMigrations(DATABASE_URL)
//   3. vitest globalSetup        -> runMigrations(TEST_DATABASE_URL)

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { loadConfig } from "./config.js";

function migrationsDir(): string {
  // src/migrate.ts -> ../migrations ; dist/migrate.js -> ../migrations
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const dir = migrationsDir();
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      ran.push(file);
    }
    return ran;
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const config = loadConfig();
  runMigrations(config.databaseUrl)
    .then((ran) => {
      console.log(ran.length ? `[migrate] applied: ${ran.join(", ")}` : "[migrate] database is up to date");
    })
    .catch((err) => {
      console.error("[migrate] failed:", err);
      process.exit(1);
    });
}
