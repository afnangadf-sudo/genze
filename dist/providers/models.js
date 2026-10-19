// Chat model catalog + smart router (per CONTRACTS.md Step 2).
//
// Catalog defaults (USD per 1M tokens, Oct 2026 research — re-verify before
// launch). Model *ids* are overridable via env vars, read lazily at call
// time; prices stay as listed. Keep pickProvider() in router.ts untouched.
import { getProvider } from "./registry.js";
import { REGION_MAP } from "./regions.js";
/** Providers whose chat path is actually implemented in this step. */
export const CHAT_IMPLEMENTED = ["anthropic", "openai"];
const CATALOG_DEFS = [
    {
        defaultId: "claude-haiku-5.5",
        envVar: "ANTHROPIC_CHAT_MODEL",
        provider: "anthropic",
        inputPerM: 0.1,
        outputPerM: 0.5,
        context: 200000,
        taskTypes: ["chat", "long-context"],
    },
    {
        defaultId: "claude-sonnet-5.5",
        envVar: "ANTHROPIC_REASONING_MODEL",
        provider: "anthropic",
        inputPerM: 2,
        outputPerM: 10,
        context: 200000,
        taskTypes: ["reasoning"],
    },
    {
        defaultId: "gpt-6-luna",
        envVar: "OPENAI_CHAT_MODEL",
        provider: "openai",
        inputPerM: 0.1,
        outputPerM: 0.5,
        context: 128000,
        taskTypes: ["chat"],
    },
    {
        defaultId: "gpt-6.1-sol",
        envVar: "OPENAI_REASONING_MODEL",
        provider: "openai",
        inputPerM: 2,
        outputPerM: 10,
        context: 128000,
        taskTypes: ["reasoning", "long-context"],
    },
];
/** Full catalog with env id-overrides applied (env read lazily). */
export function chatCatalog() {
    return CATALOG_DEFS.map((d) => {
        const override = (process.env[d.envVar] ?? "").trim();
        return {
            id: override || d.defaultId,
            provider: d.provider,
            inputPerM: d.inputPerM,
            outputPerM: d.outputPerM,
            context: d.context,
            taskTypes: [...d.taskTypes],
        };
    });
}
/** Exact catalog lookup (used for the manual `model` choice validation). */
export function findChatModel(id) {
    return chatCatalog().find((m) => m.id === id) ?? null;
}
/** The routing gates every model must pass: configured + enabled (kill
 *  switch) + region-allowed for the country + chat-implemented. */
function gatesPass(model, country) {
    const cc = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc))
        return false;
    if (!CHAT_IMPLEMENTED.includes(model.provider))
        return false;
    const allowed = REGION_MAP.get(cc);
    if (!allowed || !allowed.includes(model.provider))
        return false;
    const provider = getProvider(model.provider);
    return provider.isConfigured() && provider.isEnabled();
}
/**
 * Pick the cheapest capable model for the request. Returns null when nothing
 * may serve (fail closed): unknown/blocked country, kill-switched provider,
 * unconfigured provider, unknown manual model id, or no model matching the
 * task type. The caller maps null to 503 NO_PROVIDER_AVAILABLE — except an
 * unknown manual model id, which the route maps to 400 VALIDATION_ERROR.
 */
export function routeChat(req) {
    const catalog = chatCatalog();
    if (req.manualModelId !== undefined) {
        const model = catalog.find((m) => m.id === req.manualModelId) ?? null;
        if (!model || !gatesPass(model, req.country))
            return null;
        return { provider: model.provider, model };
    }
    const candidates = catalog.filter((m) => m.taskTypes.includes(req.taskType) && gatesPass(m, req.country));
    // Cheapest by inputPerM + 2*outputPerM. sort() is stable, so exact ties
    // keep catalog order (anthropic first).
    candidates.sort((a, b) => a.inputPerM + 2 * a.outputPerM - (b.inputPerM + 2 * b.outputPerM));
    const best = candidates[0] ?? null;
    return best ? { provider: best.provider, model: best } : null;
}
/** USD cost of one completed reply from the catalog prices. */
export function chatReplyCost(model, inputTokens, outputTokens) {
    return (inputTokens / 1e6) * model.inputPerM + (outputTokens / 1e6) * model.outputPerM;
}
//# sourceMappingURL=models.js.map