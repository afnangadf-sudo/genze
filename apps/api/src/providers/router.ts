// Provider router: pick the first provider that may serve `country` for
// `capability`. Fail-closed — unknown country, kill-switched provider,
// unconfigured provider, or capability mismatch all yield null.

import type { Capability, ProviderId } from "@genze/shared";
import { getProvider } from "./registry.js";
import { REGION_MAP } from "./regions.js";

export function pickProvider(country: string, capability: Capability): ProviderId | null {
  const cc = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  const allowed = REGION_MAP.get(cc);
  if (!allowed) return null;
  for (const id of allowed) {
    const p = getProvider(id);
    if (!p.isConfigured() || !p.isEnabled()) continue;
    if (!p.capabilities.includes(capability)) continue;
    return id;
  }
  return null;
}
