// Metering writes (record only — no enforcement; Step 5 adds limits).
// One row per completed unit of work; `details` carries feature-specific
// stats as a JSON object.

import { v4 as uuidv4 } from "uuid";
import { getPool } from "./db.js";

export interface UsageRecord {
  userId: string;
  feature: string;
  provider: string | null;
  units: number;
  costUsd: number | null;
  details?: unknown;
}

export async function recordUsage(record: UsageRecord): Promise<void> {
  await getPool().query(
    `INSERT INTO usage_events (id, user_id, feature, provider, units, cost_usd, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      uuidv4(),
      record.userId,
      record.feature,
      record.provider,
      record.units,
      record.costUsd,
      JSON.stringify(record.details ?? {}),
    ],
  );
}
