// Step 9 — Studio consent surface.
//
// Consent records are per provider (shared with chat): granting a provider
// here grants it everywhere, and withdrawing blocks it everywhere. This
// surface only differs in WHICH providers are "required" (image/video/voice
// capable instead of chat capable) and WHAT the copy describes (the Studio
// data each provider receives — see consentCopy.ts).

import type { FastifyInstance } from "fastify";
import type { ProviderId } from "@genze/shared";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getUserCountry, hasLiveConsent } from "../users.js";
import { getProvider } from "../providers/registry.js";
import { REGION_MAP } from "../providers/regions.js";
import { CONSENT_COPY, STUDIO_CAPABILITIES, studioConsentCopy } from "../providers/consentCopy.js";

const STUDIO_PROVIDERS: ProviderId[] = ["openai", "google", "kling", "elevenlabs"];

function isStudioRequired(id: ProviderId, country: string): boolean {
  const cc = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return false;
  if (STUDIO_CAPABILITIES[id].length === 0) return false;
  const allowed = REGION_MAP.get(cc);
  if (!allowed || !allowed.includes(id)) return false;
  const p = getProvider(id);
  return p.isConfigured() && p.isEnabled();
}

export async function studioConsentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/consent", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const country = (await getUserCountry(auth.userId)) ?? "";
    const providers = await Promise.all(
      STUDIO_PROVIDERS.map(async (id) => ({
        id,
        name: CONSENT_COPY[id].name,
        whatSees: studioConsentCopy(id),
        required: isStudioRequired(id, country),
        granted: await hasLiveConsent(auth.userId, id),
        capabilities: [...STUDIO_CAPABILITIES[id]],
      })),
    );
    return reply.send({ data: { providers } });
  });

  app.post("/consent", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const ids = body.providerIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((p) => typeof p !== "string")) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Choose at least one provider.");
    }
    const country = (await getUserCountry(auth.userId)) ?? "";
    const unique = [...new Set(ids as string[])];
    for (const id of unique) {
      if (!STUDIO_PROVIDERS.includes(id as ProviderId) || !isStudioRequired(id as ProviderId, country)) {
        return sendError(reply, 400, "VALIDATION_ERROR", "That provider can't be granted here.");
      }
    }
    const pool = getPool();
    for (const id of unique) {
      await pool.query(
        `INSERT INTO consent_records (user_id, provider, granted_at, revoked_at)
         VALUES ($1, $2, now(), NULL)
         ON CONFLICT (user_id, provider)
         DO UPDATE SET granted_at = now(), revoked_at = NULL`,
        [auth.userId, id],
      );
    }
    return reply.send({ data: { granted: unique } });
  });

  app.delete("/consent/:provider", { preHandler: authenticate }, async (req, reply) => {
    const auth = req.auth as { userId: string };
    const provider = (req.params as { provider: string }).provider;
    if (!STUDIO_PROVIDERS.includes(provider as ProviderId)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Unknown provider.");
    }
    await getPool().query(
      "UPDATE consent_records SET revoked_at = now() WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL",
      [auth.userId, provider],
    );
    return reply.send({ data: { revoked: true } });
  });
}
