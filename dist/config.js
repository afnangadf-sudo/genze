// Central environment configuration — the single source of truth for env var
// names (see CONTRACTS.md). Parsed lazily via loadConfig() so tests can set
// env vars before the first read; the result is memoized afterwards.
import crypto from "node:crypto";
let cached = null;
function optional(name) {
    const v = process.env[name];
    return v !== undefined && v !== "" ? v : null;
}
function withDefault(name, def) {
    return optional(name) ?? def;
}
/**
 * JWT secrets must be >= 32 chars. In production a missing secret is a boot
 * failure (fail closed). In dev/test we generate one and warn LOUDLY so that
 * `pnpm dev` works with zero setup.
 */
function jwtSecret(name) {
    const v = optional(name);
    if (v) {
        if (v.length < 32) {
            throw new Error(`[config] ${name} must be at least 32 characters long`);
        }
        return v;
    }
    if (process.env.NODE_ENV === "production") {
        throw new Error(`[config] ${name} is required in production — refusing to boot`);
    }
    const generated = crypto.randomBytes(48).toString("hex");
    console.warn("\n************************************************************************\n" +
        `  WARNING: ${name} is not set.\n` +
        "  Generated a random dev secret — sessions/tokens will NOT survive restarts.\n" +
        `  Set ${name} (min 32 chars) in your environment for anything real.\n` +
        "************************************************************************\n");
    return generated;
}
/**
 * Connector token encryption key: exactly 64 hex chars (32 bytes) for
 * AES-256-GCM. Production refuses to boot without it (fail closed); in
 * dev/test we generate one and warn LOUDLY (same pattern as JWT secrets).
 */
function tokenEncryptionKey() {
    const v = optional("TOKEN_ENCRYPTION_KEY");
    if (v) {
        if (!/^[0-9a-fA-F]{64}$/.test(v)) {
            throw new Error("[config] TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
        }
        return v.toLowerCase();
    }
    if (process.env.NODE_ENV === "production") {
        throw new Error("[config] TOKEN_ENCRYPTION_KEY is required in production — refusing to boot");
    }
    const generated = crypto.randomBytes(32).toString("hex");
    console.warn("\n************************************************************************\n" +
        "  WARNING: TOKEN_ENCRYPTION_KEY is not set.\n" +
        "  Generated a random dev key — connector tokens will NOT survive restarts.\n" +
        "  Set TOKEN_ENCRYPTION_KEY (64 hex chars) in your environment for anything real.\n" +
        "************************************************************************\n");
    return generated;
}
// Verified vendor MCP endpoints (2026-10-18); all env-overridable.
// Google Workspace connectors (google-drive/gmail/google-calendar) have NO
// env vars by design (contract: availability is "not_available_yet", wiring
// deferred), and onedrive is "coming_later" — lookups for those ids fall
// back to an empty (unconfigured) config below.
const CONNECTOR_ENV_SPECS = {
    notion: {
        clientIdEnv: "NOTION_MCP_CLIENT_ID",
        clientSecretEnv: "NOTION_MCP_CLIENT_SECRET",
        mcpUrlEnv: "NOTION_MCP_URL",
        mcpUrlDefault: "https://mcp.notion.com/mcp",
    },
    slack: {
        clientIdEnv: "SLACK_MCP_CLIENT_ID",
        clientSecretEnv: "SLACK_MCP_CLIENT_SECRET",
        mcpUrlEnv: "SLACK_MCP_URL",
        mcpUrlDefault: "https://mcp.slack.com/mcp",
    },
    github: {
        clientIdEnv: "GITHUB_MCP_CLIENT_ID",
        clientSecretEnv: "GITHUB_MCP_CLIENT_SECRET",
        mcpUrlEnv: "GITHUB_MCP_URL",
        mcpUrlDefault: "https://api.githubcopilot.com/mcp/",
    },
    dropbox: {
        clientIdEnv: "DROPBOX_MCP_CLIENT_ID",
        clientSecretEnv: "DROPBOX_MCP_CLIENT_SECRET",
        mcpUrlEnv: "DROPBOX_MCP_URL",
        mcpUrlDefault: "https://mcp.dropbox.com/mcp",
    },
};
const EMPTY_CONNECTOR_CONFIG = {
    clientId: null,
    clientSecret: null,
    mcpUrl: "",
};
function connectorConfigs() {
    const out = {};
    for (const [id, spec] of Object.entries(CONNECTOR_ENV_SPECS)) {
        out[id] = {
            clientId: optional(spec.clientIdEnv),
            clientSecret: optional(spec.clientSecretEnv),
            mcpUrl: optional(spec.mcpUrlEnv) ?? spec.mcpUrlDefault,
        };
    }
    return out;
}
/** Env config for one connector; unconfigured (empty) for ids with no env spec. */
export function connectorEnvConfig(id) {
    return loadConfig().connectors[id] ?? EMPTY_CONNECTOR_CONFIG;
}
export function loadConfig() {
    if (cached)
        return cached;
    // Render/Heroku-style platforms inject PORT; API_PORT stays the explicit knob.
    const port = Number(process.env.PORT || withDefault("API_PORT", "4000"));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("[config] API_PORT must be a valid port number");
    }
    cached = {
        nodeEnv: withDefault("NODE_ENV", "development"),
        databaseUrl: withDefault("DATABASE_URL", "postgresql://genze:genze@localhost:5432/genze"),
        redisUrl: withDefault("REDIS_URL", "redis://localhost:6379"),
        apiPort: port,
        appUrl: withDefault("APP_URL", "http://localhost:3000").replace(/\/+$/, ""),
        jwtAccessSecret: jwtSecret("JWT_ACCESS_SECRET"),
        jwtRefreshSecret: jwtSecret("JWT_REFRESH_SECRET"),
        tokenEncryptionKey: tokenEncryptionKey(),
        resendApiKey: optional("RESEND_API_KEY"),
        emailFrom: withDefault("EMAIL_FROM", "Genze <noreply@localhost>"),
        googleOAuthClientId: optional("GOOGLE_OAUTH_CLIENT_ID"),
        googleOAuthClientSecret: optional("GOOGLE_OAUTH_CLIENT_SECRET"),
        appleClientId: optional("APPLE_CLIENT_ID"),
        connectors: connectorConfigs(),
    };
    return cached;
}
/** Test hook: drop the memoized config so env changes take effect. */
export function resetConfig() {
    cached = null;
}
//# sourceMappingURL=config.js.map