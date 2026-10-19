// Connector registry (Step 6): static definitions for the 8 connectors.
// Availability is honest, not aspirational — per CONTRACTS.md.

import type { ConnectorAvailability, ConnectorDefinition } from "./types.js";

const AVAILABLE: ConnectorAvailability = "available";
const BETA: ConnectorAvailability = "beta";
const NOT_YET: ConnectorAvailability = "not_available_yet";
const LATER: ConnectorAvailability = "coming_later";

export const CONNECTOR_DEFINITIONS: ConnectorDefinition[] = [
  {
    id: "google-drive",
    name: "Google Drive",
    blurb: "Your Drive files, readable by the assistant.",
    availability: NOT_YET,
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    scopeLabels: ["Read your Drive files"],
    fallback: null,
  },
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Read and draft email; sending always asks you first.",
    availability: NOT_YET,
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    scopeLabels: ["Read your email", "Send email on your behalf (always confirmed first)"],
    fallback: null,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    blurb: "See what's on your calendar.",
    availability: NOT_YET,
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    scopeLabels: ["Read your calendar"],
    fallback: null,
  },
  {
    id: "notion",
    name: "Notion",
    blurb: "Search, read, create, and manage Notion pages and databases.",
    availability: AVAILABLE,
    authorizeEndpoint: "https://api.notion.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    scopeLabels: [],
    fallback: null,
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Search messages and channels in your Slack workspace.",
    availability: BETA,
    authorizeEndpoint: "https://slack.com/oauth/v2/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    revocationEndpoint: "https://slack.com/api/auth.revoke",
    scopes: ["channels:read", "channels:history", "groups:read", "groups:history", "im:read", "im:history", "mpim:read", "mpim:history", "search:read", "users:read"],
    scopeLabels: ["Read messages in channels you can access", "Search your workspace", "See workspace members"],
    fallback: null,
  },
  {
    id: "github",
    name: "GitHub",
    blurb: "Read repos, issues, and pull requests.",
    availability: BETA,
    authorizeEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user"],
    scopeLabels: ["Read your repositories, issues, and pull requests", "See your GitHub profile"],
    fallback: null,
  },
  {
    id: "dropbox",
    name: "Dropbox",
    blurb: "Read and manage your Dropbox files.",
    availability: BETA,
    authorizeEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
    revocationEndpoint: "https://api.dropboxapi.com/oauth2/token/revoke",
    scopes: ["files.metadata.read", "files.content.read"],
    scopeLabels: ["See your Dropbox files", "Read file contents"],
    fallback: null,
  },
  {
    id: "onedrive",
    name: "OneDrive",
    blurb: "Your OneDrive files, readable by the assistant.",
    availability: LATER,
    authorizeEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Files.Read"],
    scopeLabels: ["Read your OneDrive files"],
    fallback: "browser",
  },
];

export function getDefinition(id: string): ConnectorDefinition | undefined {
  return CONNECTOR_DEFINITIONS.find((d) => d.id === id);
}

export function listDefinitions(): ConnectorDefinition[] {
  return [...CONNECTOR_DEFINITIONS];
}

/** Gated connectors can never start an OAuth flow or serve tools. */
export function isGated(def: ConnectorDefinition): boolean {
  return def.availability === "not_available_yet" || def.availability === "coming_later";
}

/** Notion's hosted MCP uses OAuth discovery on the server itself — no scopes
 *  are registered in the authorize request (the server drives consent). */
export function authorizeScopes(def: ConnectorDefinition): string {
  return def.scopes.join(" ");
}
