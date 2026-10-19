// OAuth discovery for user-registered MCP servers (Step 6b).
//
// Implements the MCP-spec flow:
//   1. GET the MCP URL unauthenticated -> expect 401 with a WWW-Authenticate
//      header carrying `resource_metadata=`.
//   2. Fetch the Protected Resource Metadata (RFC 9728) ->
//      `authorization_servers[0]`.
//   3. Fetch the Authorization Server Metadata (RFC 8414,
//      `/.well-known/oauth-authorization-server[+path]`) ->
//      `{authorization_endpoint, token_endpoint}` (+ optional
//      `registration_endpoint` for RFC 7591 dynamic client registration).
//
// Any step failing -> null (the caller surfaces 502 OAUTH_FAILED with a
// plain message — never a fake flow).

export interface DiscoveredOAuth {
  authorizeUrl: string;
  tokenUrl: string;
  /** Present when the server supports RFC 7591 dynamic client registration. */
  registrationUrl?: string;
  /** Present when the server advertises RFC 7009 token revocation. */
  revocationUrl?: string;
}

const FETCH_TIMEOUT_MS = 15_000;

async function getJson(url: string): Promise<{ status: number; headers: Headers; json: () => Promise<unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    return {
      status: res.status,
      headers: res.headers,
      json: () => res.json() as Promise<unknown>,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** RFC 8414 §3: insert /.well-known/oauth-authorization-server before the path. */
function authorizationServerMetadataUrl(issuer: string): string {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  u.pathname = path
    ? `/.well-known/oauth-authorization-server${path}`
    : "/.well-known/oauth-authorization-server";
  u.search = "";
  u.hash = "";
  return u.toString();
}

export async function discoverOAuth(mcpUrl: string): Promise<DiscoveredOAuth | null> {
  try {
    // 1. Unauthenticated probe -> 401 + WWW-Authenticate with resource_metadata.
    const probe = await getJson(mcpUrl);
    if (probe.status !== 401) return null;
    const wwwAuth = probe.headers.get("www-authenticate");
    if (!wwwAuth) return null;
    const rmMatch = /resource_metadata="([^"]+)"/i.exec(wwwAuth);
    if (!rmMatch) return null;
    const resourceMetadataUrl = new URL(rmMatch[1], mcpUrl).toString();

    // 2. Protected Resource Metadata (RFC 9728).
    const prmRes = await getJson(resourceMetadataUrl);
    if (prmRes.status < 200 || prmRes.status >= 300) return null;
    const prm = (await prmRes.json()) as { authorization_servers?: unknown };
    const servers = prm?.authorization_servers;
    if (!Array.isArray(servers) || typeof servers[0] !== "string" || !servers[0]) return null;

    // 3. Authorization Server Metadata (RFC 8414).
    const asmRes = await getJson(authorizationServerMetadataUrl(servers[0]));
    if (asmRes.status < 200 || asmRes.status >= 300) return null;
    const asm = (await asmRes.json()) as {
      authorization_endpoint?: unknown;
      token_endpoint?: unknown;
      registration_endpoint?: unknown;
      revocation_endpoint?: unknown;
    };
    if (typeof asm?.authorization_endpoint !== "string" || typeof asm?.token_endpoint !== "string") {
      return null;
    }
    const out: DiscoveredOAuth = {
      authorizeUrl: asm.authorization_endpoint,
      tokenUrl: asm.token_endpoint,
    };
    if (typeof asm.registration_endpoint === "string" && asm.registration_endpoint) {
      out.registrationUrl = asm.registration_endpoint;
    }
    if (typeof asm.revocation_endpoint === "string" && asm.revocation_endpoint) {
      out.revocationUrl = asm.revocation_endpoint;
    }
    return out;
  } catch {
    return null;
  }
}
