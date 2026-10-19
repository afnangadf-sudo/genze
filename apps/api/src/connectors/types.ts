// Connector domain types (Step 6).
//
// packages/shared is FROZEN for Step 6, so the connector payload types live
// here in the API instead of @genze/shared. The web client should mirror
// these shapes (see CONNECTOR_ROUTES in routes.ts for the path table).

/** Honest availability of a connector — never aspirational. */
export type ConnectorAvailability =
  | "available"
  | "beta"
  | "not_available_yet"
  | "coming_later";

export interface ConnectorDefinition {
  /** Stable id, e.g. "notion". */
  id: string;
  /** Display name, e.g. "Notion". */
  name: string;
  /** One-line plain-language blurb for the directory card. */
  blurb: string;
  availability: ConnectorAvailability;
  /** OAuth 2.0 authorization endpoint (vendor). */
  authorizeEndpoint: string;
  /** OAuth 2.0 token endpoint (vendor). */
  tokenEndpoint: string;
  /** Optional token revocation endpoint; absent => revoke is skipped. */
  revocationEndpoint?: string;
  /** Scopes requested at authorize time (vendor scope strings). */
  scopes: string[];
  /** Human-readable scope labels shown in the UI, parallel to `scopes`. */
  scopeLabels: string[];
  /** Browser-automation fallback marker for sites with no API/MCP (consumed by Step 8). */
  fallback: "browser" | null;
}

export interface ConnectorStatus {
  id: string;
  name: string;
  blurb: string;
  availability: ConnectorAvailability;
  connected: boolean;
  connectedAt: string | null;
  scopes: string[];
  scopeLabels: string[];
  fallback: "browser" | null;
}

export interface ConnectorToolInfo {
  name: string;
  description: string;
  /** true only when the vendor's annotations explicitly say read-only. */
  readOnly: boolean;
}

export interface PendingConfirmation {
  id: string;
  connectorId: string;
  tool: string;
  arguments: Record<string, unknown>;
  summary: string;
  expiresAt: string;
}

export interface ConnectorAuditEntry {
  id: string;
  connectorId: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** Result envelope for write-tool calls and Gmail send without a confirmation. */
export interface ConfirmationRequired {
  confirmationRequired: true;
  confirmation: PendingConfirmation;
}
