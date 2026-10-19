// Auth client: token storage + fetch wrapper. Every route comes from
// API_ROUTES (@genze/shared) — never hardcoded.

import { API_ROUTES, type ApiErrorBody, type ApiResponse } from "@genze/shared";

export const API_BASE =
  // Runtime override injected by the host (public/runtime-config.js) — lets
  // the same build point at any API without rebuilding.
  (typeof window !== "undefined" &&
    (window as unknown as { __GENZE_API_URL?: string }).__GENZE_API_URL) ||
  (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL.length > 0
    ? process.env.NEXT_PUBLIC_API_URL
    : "http://localhost:4000");

const ACCESS_KEY = "genze_access";
const REFRESH_KEY = "genze_refresh";

export class ApiClientError extends Error {
  code: string;
  status: number;
  /** Machine-readable extras, e.g. { feature, resetAt } on LIMIT_EXCEEDED. */
  details?: Record<string, unknown>;
  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getTokens(): { access: string | null; refresh: string | null } {
  return { access: read(ACCESS_KEY), refresh: read(REFRESH_KEY) };
}

export function setTokens(accessToken: string, refreshToken: string) {
  try {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  } catch {
    /* storage unavailable */
  }
}

export function clearTokens() {
  try {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function isLoggedIn(): boolean {
  return getTokens().access !== null;
}

// Pages where a failed refresh should NOT bounce the user to /login
// (public auth pages handle their own errors).
const PUBLIC_PREFIXES = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/auth/"];

interface FetchOptions extends RequestInit {
  /** Skip the 401 -> refresh -> retry flow (e.g. on the login form itself). */
  skipRefresh?: boolean;
}

async function parseError(res: Response): Promise<ApiClientError> {
  let body: { error?: ApiErrorBody } | null = null;
  try {
    body = (await res.json()) as { error?: ApiErrorBody };
  } catch {
    /* not JSON */
  }
  const code = body?.error?.code ?? "UNKNOWN";
  const message = body?.error?.message ?? `Request failed (${res.status})`;
  const details = body?.error?.details;
  return new ApiClientError(code, message, res.status, details);
}

/**
 * Fetch against the API. Attaches the access token, and on 401 tries one
 * refresh-rotation then retries the request once. If the refresh fails too,
 * tokens are cleared and the user is sent to /login (unless on a public page).
 */
export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { skipRefresh, ...init } = options;
  const { access, refresh } = getTokens();

  const doFetch = async (token: string | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  };

  let res = await doFetch(access);

  if (res.status === 401 && !skipRefresh && access && refresh) {
    // One refresh attempt, then retry the original request once.
    const refreshRes = await fetch(`${API_BASE}${API_ROUTES.refresh}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (refreshRes.ok) {
      const json = (await refreshRes.json()) as ApiResponse<{ accessToken: string; refreshToken: string }>;
      const tokens = (json as { data?: { accessToken: string; refreshToken: string } }).data;
      if (tokens?.accessToken && tokens?.refreshToken) {
        setTokens(tokens.accessToken, tokens.refreshToken);
        res = await doFetch(tokens.accessToken);
      }
    } else {
      clearTokens();
      if (typeof window !== "undefined") {
        const onPublicPage = PUBLIC_PREFIXES.some((p) => window.location.pathname.startsWith(p));
        if (!onPublicPage) window.location.href = "/login";
      }
      throw new ApiClientError("UNAUTHORIZED", "Please log in again.", 401);
    }
  }

  if (!res.ok) throw await parseError(res);
  const json = (await res.json()) as ApiResponse<T>;
  return (json as { data?: T }).data as T;
}

export function logoutLocal() {
  clearTokens();
  if (typeof window !== "undefined") window.location.href = "/login";
}
