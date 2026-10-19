// Contract-shaped errors: { error: { code, message } }, with optional
// machine-readable extras as { error: { code, message, details } }
// (per the shared ApiErrorBody contract, e.g. LIMIT_EXCEEDED carries
// { feature, resetAt }).

import type { FastifyReply } from "fastify";

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  if (details === undefined) return reply.code(status).send({ error: { code, message } });
  return reply.code(status).send({ error: { code, message, details } });
}
