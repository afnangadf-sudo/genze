// Step 9 — Studio media catalog: image + video model defaults (Oct 2026
// research, re-verify ids/prices before launch), cheapest-capable routing
// over the same gates as pickProvider (configured + enabled/kill-switch +
// region-allowed + capability), and the retirement guards.
//
// Verified facts baked in:
// - Google Veo 3.1, model `veo-3.1-generate-001`, clip lengths 4/6/8 s only.
//   Gemini API pricing: Standard $0.40/s (720p/1080p), Fast $0.10–0.12/s,
//   Lite $0.05–0.08/s. OFFICIAL RETIREMENT: 2026-11-17 or later — the catalog
//   carries retiresAt and requesting a retired model is a 400.
// - Kling 3.0 fallback: 3–15 s per clip, 1080p $0.112/s silent / $0.168/s
//   with native audio (v1 renders silent; we add our own voiceover).
// - Sora API is DEAD (retired 2026-09-24); Imagen 4 endpoints shut Jun–Aug
//   2026. Any sora*/imagen* id -> 400 VALIDATION_ERROR, never attempted.
// - Images: gemini-nano-banana-2.1 (~$0.0336/image @1K) and OpenAI
//   GPT Image 2.5 (~$0.01 low / $0.05 high per 1024px;
//   `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`).
import { getProvider } from "../providers/registry.js";
import { REGION_MAP } from "../providers/regions.js";
export const IMAGE_CATALOG = [
    { id: "gpt-image-2.5-flare", provider: "openai", costUsdPerImage: 0.01 },
    { id: "gemini-nano-banana-2.1", provider: "google", costUsdPerImage: 0.0336 },
    { id: "gpt-image-2.5-sunburst", provider: "openai", costUsdPerImage: 0.05 },
];
export const VIDEO_CATALOG = [
    {
        id: "veo-3.1-generate-001",
        provider: "google",
        costUsdPerSecond: 0.4,
        fixedDurations: [4, 6, 8],
        // Official: Veo 3.1 retires 2026-11-17 or later. Today (~2026-10-19) it
        // is still live; isVideoModelRetired() flips it to a 400 on/after the
        // date, and the picker excludes it (Kling becomes the fallback).
        retiresAt: "2026-11-17",
    },
    {
        id: "kling-3.0",
        provider: "kling",
        costUsdPerSecond: 0.112,
        minDurationS: 3,
        maxDurationS: 15,
    },
];
/** True when a model id is dead-on-arrival: Sora (retired 2026-09-24) or
 *  Imagen 4 (endpoints shut Jun–Aug 2026). Never attempted, always a 400. */
export function isDeadModelId(id) {
    return /^(sora|imagen)[-_a-z0-9]*/i.test(id.trim());
}
/** True when a catalog video model is past its official retirement date. */
export function isVideoModelRetired(model, now = new Date()) {
    if (!model.retiresAt)
        return false;
    return now.getTime() >= Date.parse(`${model.retiresAt}T00:00:00Z`);
}
function gatesPass(provider, country, capability) {
    const cc = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc))
        return false;
    const allowed = REGION_MAP.get(cc);
    if (!allowed || !allowed.includes(provider))
        return false;
    const p = getProvider(provider);
    return p.isConfigured() && p.isEnabled() && p.capabilities.includes(capability);
}
/**
 * Cheapest image-capable provider for the country. An explicit `preferred`
 * must pass every gate itself (fail closed -> null); otherwise the cheapest
 * passing model wins. Null -> the route answers 503 NO_PROVIDER_AVAILABLE.
 */
export function pickImageProvider(country, preferred) {
    if (preferred !== undefined) {
        // Dead ids (sora/imagen) are rejected by the route as 400 before this;
        // anything else unknown here simply fails closed.
        const model = IMAGE_CATALOG.find((m) => m.provider === preferred);
        if (!model || !gatesPass(model.provider, country, "image"))
            return null;
        return { provider: model.provider, model };
    }
    const passing = IMAGE_CATALOG.filter((m) => gatesPass(m.provider, country, "image"));
    passing.sort((a, b) => a.costUsdPerImage - b.costUsdPerImage);
    const best = passing[0];
    return best ? { provider: best.provider, model: best } : null;
}
/**
 * Cheapest video-capable provider for the country (retired models excluded).
 * Explicit `preferred` must pass every gate itself; sora/imagen ids are
 * dead (the route maps them to 400 before calling this).
 */
export function pickVideoProvider(country, preferred) {
    const live = (m) => !isVideoModelRetired(m);
    if (preferred !== undefined) {
        const model = VIDEO_CATALOG.find((m) => m.provider === preferred && live(m));
        if (!model || !gatesPass(model.provider, country, "video"))
            return null;
        return { provider: model.provider, model };
    }
    const passing = VIDEO_CATALOG.filter((m) => live(m) && gatesPass(m.provider, country, "video"));
    passing.sort((a, b) => a.costUsdPerSecond - b.costUsdPerSecond);
    const best = passing[0];
    return best ? { provider: best.provider, model: best } : null;
}
/** USD cost of one image from the catalog rate. */
export function imageCostUsd(model) {
    return model.costUsdPerImage;
}
/** USD cost of one video shot from the catalog rate. */
export function videoShotCostUsd(model, durationS) {
    return durationS * model.costUsdPerSecond;
}
/**
 * Coerce a requested shot length to something the model accepts.
 * Veo: snap to the nearest of {4,6,8}. Kling: clamp to 3..15 (rounded).
 * Returns the coerced seconds.
 */
export function normalizeShotDuration(model, seconds) {
    if (model.fixedDurations) {
        let best = model.fixedDurations[0];
        for (const d of model.fixedDurations) {
            if (Math.abs(d - seconds) < Math.abs(best - seconds))
                best = d;
        }
        return best;
    }
    const lo = model.minDurationS ?? 1;
    const hi = model.maxDurationS ?? 60;
    return Math.min(hi, Math.max(lo, Math.round(seconds)));
}
//# sourceMappingURL=catalog.js.map