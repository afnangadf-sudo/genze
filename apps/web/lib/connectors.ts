// Connectors API client: directory, OAuth connect/disconnect, tool calls with
// confirmation, and the connector audit log. Every route comes from
// API_ROUTES (@genze/shared) — never hardcoded.

import {
  API_ROUTES,
  type ConnectorAuditEntry,
  type ConnectorId,
  type ConnectorStatus,
  type ConnectorToolCallResponse,
  type ConnectorToolInfo,
  type CustomConnector,
  type CustomConnectorAuthType,
} from "@genze/shared";
import { apiFetch } from "./auth";

/** Directory: definition + connected flag + connectedAt (never secrets). */
export async function listConnectors(): Promise<ConnectorStatus[]> {
  const data = await apiFetch<{ connectors: ConnectorStatus[] }>(API_ROUTES.connectors);
  return data.connectors;
}

/** The OAuth authorization URL the user opens to start connecting. */
export async function getConnectorAuthorizeUrl(connectorId: ConnectorId): Promise<string> {
  const data = await apiFetch<{ url: string }>(API_ROUTES.connectorAuthorize(connectorId));
  return data.url;
}

/** Completes OAuth from the vendor's redirect (?code=…&state=…). */
export async function completeConnectorCallback(
  connectorId: string,
  code: string,
  state: string
): Promise<boolean> {
  const query = `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  const data = await apiFetch<{ connected: boolean }>(
    `${API_ROUTES.connectorCallback(connectorId)}${query}`
  );
  return data.connected;
}

/** Disconnects a connector (best-effort vendor revoke, then forgets tokens). */
export async function disconnectConnector(connectorId: ConnectorId): Promise<void> {
  await apiFetch<{ disconnected: boolean }>(API_ROUTES.connectorDisconnect(connectorId), {
    method: "POST",
  });
}

/** Tools a connected connector offers, with read-only flags. */
export async function listConnectorTools(connectorId: ConnectorId): Promise<ConnectorToolInfo[]> {
  const data = await apiFetch<{ tools: ConnectorToolInfo[] }>(
    API_ROUTES.connectorTools(connectorId)
  );
  return data.tools;
}

/**
 * Calls a connector tool. Read-only tools execute immediately; write tools
 * return { confirmationRequired: true, confirmation } first and NOTHING runs
 * until the user confirms via confirmPendingWrite.
 */
export async function callConnectorTool(
  connectorId: ConnectorId,
  tool: string,
  args: Record<string, unknown> = {},
  confirmationId?: string
): Promise<ConnectorToolCallResponse> {
  return apiFetch<ConnectorToolCallResponse>(
    API_ROUTES.connectorCallTool(connectorId, tool),
    {
      method: "POST",
      body: JSON.stringify({ arguments: args, ...(confirmationId ? { confirmationId } : {}) }),
    }
  );
}

/** Executes a pending write tool the user approved in a confirmation card. */
export async function confirmPendingWrite(confirmationId: string): Promise<unknown> {
  const data = await apiFetch<{ result: unknown }>(
    API_ROUTES.connectorConfirmationConfirm(confirmationId),
    { method: "POST" }
  );
  return data.result;
}

/** Cancels a pending write — the tool never runs. */
export async function cancelPendingWrite(confirmationId: string): Promise<void> {
  await apiFetch<{ cancelled: boolean }>(API_ROUTES.connectorConfirmationCancel(confirmationId), {
    method: "POST",
  });
}

/** The user's own connector audit log, newest first. */
export async function getConnectorAudit(): Promise<ConnectorAuditEntry[]> {
  const data = await apiFetch<{ entries: ConnectorAuditEntry[] }>(API_ROUTES.connectorAudit);
  return data.entries;
}

/* ---------- Step 6b: custom (user-registered) MCP connectors ---------- */

/** All custom connectors this user has registered. */
export async function listCustomConnectors(): Promise<CustomConnector[]> {
  const data = await apiFetch<{ connectors: CustomConnector[] }>(API_ROUTES.customConnectors);
  return data.connectors;
}

export interface RegisterCustomConnectorInput {
  name: string;
  mcpUrl: string;
  authType: CustomConnectorAuthType;
  /** Required iff authType === "token"; never logged or shown again. */
  token?: string;
}

/** Registers a custom MCP connector. Token-auth connectors are connected
 *  immediately; OAuth ones need a connect (authorize) round afterwards. */
export async function registerCustomConnector(
  input: RegisterCustomConnectorInput
): Promise<CustomConnector> {
  const data = await apiFetch<{ connector: CustomConnector }>(API_ROUTES.customConnectors, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      mcpUrl: input.mcpUrl,
      authType: input.authType,
      ...(input.token !== undefined ? { token: input.token } : {}),
    }),
  });
  return data.connector;
}

/** One custom connector by id (404 when not owned). */
export async function getCustomConnector(id: string): Promise<CustomConnector> {
  const data = await apiFetch<{ connector: CustomConnector }>(API_ROUTES.customConnector(id));
  return data.connector;
}

/** Removes a custom connector registration (forgetting its tokens). */
export async function removeCustomConnector(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.customConnector(id), { method: "DELETE" });
}

/** The OAuth authorization URL for an OAuth custom connector. */
export async function getCustomConnectorAuthorizeUrl(id: string): Promise<string> {
  const data = await apiFetch<{ url: string }>(API_ROUTES.customConnectorAuthorize(id));
  return data.url;
}

/** Completes OAuth from the vendor's redirect (?code=…&state=…). */
export async function completeCustomConnectorCallback(
  id: string,
  code: string,
  state: string
): Promise<boolean> {
  const query = `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  const data = await apiFetch<{ connected: boolean }>(
    `${API_ROUTES.customConnectorCallback(id)}${query}`
  );
  return data.connected;
}

/** Disconnects a custom connector: keeps the registration, clears tokens. */
export async function disconnectCustomConnector(id: string): Promise<void> {
  await apiFetch<{ disconnected: boolean }>(API_ROUTES.customConnectorDisconnect(id), {
    method: "POST",
  });
}
