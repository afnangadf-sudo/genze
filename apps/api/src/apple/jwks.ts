// Apple's public signing keys (JWKS) used to verify Sign in with Apple
// identity tokens. Keys are cached in-process for ~24h per Apple's guidance
// (key rotation is infrequent). The fetch implementation is injectable so
// tests never touch the real Apple endpoint.

export interface AppleJwk {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

const JWKS_URL = "https://appleid.apple.com/auth/keys";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cached: AppleJwk[] | null = null;
let cachedAt = 0;

export async function fetchAppleJwks(
  fetchImpl: typeof fetch = fetch,
): Promise<AppleJwk[]> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
  let res: Response;
  try {
    res = await fetchImpl(JWKS_URL);
  } catch (err) {
    throw new Error(`Could not reach Apple's key server: ${(err as Error)?.message ?? err}`);
  }
  if (!res.ok) {
    throw new Error(`Apple's key server returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as { keys?: AppleJwk[] };
  if (!json || !Array.isArray(json.keys) || json.keys.length === 0) {
    throw new Error("Apple's key server returned no signing keys.");
  }
  cached = json.keys;
  cachedAt = now;
  return cached;
}

/** Test hook: drop the JWKS cache. */
export function resetJwksCacheForTests(): void {
  cached = null;
  cachedAt = 0;
}
