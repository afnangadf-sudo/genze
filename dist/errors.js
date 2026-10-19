// Contract-shaped errors: { error: { code, message } }, with optional
// machine-readable extras as { error: { code, message, details } }
// (per the shared ApiErrorBody contract, e.g. LIMIT_EXCEEDED carries
// { feature, resetAt }).
export function sendError(reply, status, code, message, details) {
    if (details === undefined)
        return reply.code(status).send({ error: { code, message } });
    return reply.code(status).send({ error: { code, message, details } });
}
//# sourceMappingURL=errors.js.map