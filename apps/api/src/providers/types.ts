// AIProvider interface (per CONTRACTS.md). No real provider API calls here —
// interface, configuration and capability metadata only.

import type { Capability, ProviderId } from "@genze/shared";

export interface AIProvider {
  id: ProviderId;
  capabilities: Capability[];
  /** A key for this provider is present in the environment. */
  isConfigured(): boolean;
  /** Not force-disabled via PROVIDER_DISABLED (kill switch). */
  isEnabled(): boolean;
}
