// Optional Redis client. Redis is best-effort in Step 1: it is only used for
// the /health check. A missing/down Redis never fails a request or the boot.

import { Redis } from "ioredis";
import { loadConfig } from "./config.js";

let client: Redis | null = null;

function getClient(): Redis | null {
  const { redisUrl } = loadConfig();
  if (!redisUrl) return null;
  if (!client) {
    client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      // Don't retry in the background; health is a point-in-time check.
      retryStrategy: () => null,
    });
    // Swallowed on purpose: pingRedis() reports false instead of crashing.
    client.on("error", () => {});
  }
  return client;
}

export async function pingRedis(): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    return (await c.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    c.disconnect();
  }
}
