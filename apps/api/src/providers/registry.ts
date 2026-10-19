// Provider registry: the six known providers, their capabilities, whether each
// is configured (key present) and enabled (not kill-switched). Every env read
// happens lazily at call time so tests can flip env vars per case.

import type { Capability, ProviderId, ProviderStatus } from "@genze/shared";
import type { AIProvider } from "./types.js";
import { REGION_RULES } from "./regions.js";
import { isDbKilled, providerDisabledSet } from "./killswitches.js";
import { isCircuitTripped } from "./circuit.js";

// providerDisabledSet moved to killswitches.ts (Step 5); keep the old import
// path working for existing tests.
export { providerDisabledSet } from "./killswitches.js";

const CAPABILITIES: Record<ProviderId, Capability[]> = {
  anthropic: ["chat"],
  openai: ["chat", "image", "voice"],
  google: ["chat", "image", "video", "voice"],
  kling: ["video"],
  steel: ["browser"],
  elevenlabs: ["voice"],
};

const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENAI_API_KEY",
  kling: "KLING_API_KEY",
  steel: "STEEL_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

const ORDER: ProviderId[] = ["anthropic", "openai", "google", "kling", "steel", "elevenlabs"];

function makeProvider(id: ProviderId): AIProvider {
  return {
    id,
    capabilities: CAPABILITIES[id],
    isConfigured: () => {
      const v = process.env[ENV_KEYS[id]];
      return v !== undefined && v !== "";
    },
    // Kill switches (Step 5): env list wins, then the DB toggle (cached),
    // then the circuit breaker (temporary auto-kill).
    isEnabled: () =>
      !providerDisabledSet().has(id) && !isDbKilled(id) && !isCircuitTripped(id),
  };
}

export function getProviders(): AIProvider[] {
  return ORDER.map(makeProvider);
}

export function getProvider(id: ProviderId): AIProvider {
  return makeProvider(id);
}

// Invert the region rules: provider -> countries it may serve.
const PROVIDER_REGIONS: Record<ProviderId, string[]> = (() => {
  const m: Record<ProviderId, string[]> = {
    anthropic: [],
    openai: [],
    google: [],
    kling: [],
    steel: [],
    elevenlabs: [],
  };
  for (const rule of REGION_RULES) {
    for (const p of rule.providers) m[p].push(rule.country);
  }
  return m;
})();

/**
 * Public status for GET /providers/status. Booleans only — key values are
 * NEVER included (the api test asserts no secret leaks into the JSON).
 */
export function getProviderStatus(): ProviderStatus[] {
  return getProviders().map((p) => ({
    id: p.id,
    configured: p.isConfigured(),
    enabled: p.isEnabled(),
    capabilities: [...p.capabilities],
    regions: [...PROVIDER_REGIONS[p.id]],
  }));
}
