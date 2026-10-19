// Vitest global setup: creates the test database (if missing) and runs all
// migrations against it, once per test run. The resolved URL is published via
// process.env.TEST_DATABASE_URL, which forked workers inherit.

import type { GlobalSetupContext } from "vitest/node";
import { Client } from "pg";
import { runMigrations } from "../src/migrate.js";

function databaseUrlFor(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}

export default async function setup(_context: GlobalSetupContext): Promise<() => Promise<void>> {
  const fallback = process.env.DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze";
  const target = process.env.TEST_DATABASE_URL ?? databaseUrlFor(fallback, "genze_test");
  const dbName = new URL(target).pathname.replace(/^\//, "") || "genze_test";

  const admin = new Client({ connectionString: databaseUrlFor(target, "postgres") });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`[test setup] created database "${dbName}"`);
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "42P04") throw err; // 42P04 = already exists
  } finally {
    await admin.end();
  }

  const ran = await runMigrations(target);
  if (ran.length) console.log(`[test setup] applied migrations: ${ran.join(", ")}`);

  process.env.TEST_DATABASE_URL = target;
  return async () => {};
}
