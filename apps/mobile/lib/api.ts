// Genze mobile API client.
//
// Mirrors apps/web/lib/auth.ts + lib/chat.ts:
//  - every route comes from API_ROUTES (@genze/shared) — never hardcoded,
//    except the Step 10 backend routes (STEP10_ROUTES below) which do not
//    exist in @genze/shared yet; they move there when the API worker lands
//    them.
//  - refresh-on-401 with a single retry, same as web.
//  - SSE streaming goes through XMLHttpRequest, not fetch: React Native's
//    fetch does not expose an incremental response body, while XHR's
//    responseText grows as chunks arrive, which is enough for the
//    `data: <json>\n\n` wire protocol.
//  - multipart uploads use FormData (React Native file objects).

import * as SecureStore from "expo-secure-store";
import {
  API_ROUTES,
  type ApiResponse,
  type AuthTokens,
  type ChatMessage,
  type ChatStreamEvent,
  type ChatThread,
  type ConsentProviderStatus,
  type LibraryGroup,
  type UsageSummary,
  type User,
} from "@genze/shared";

export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL && process.env.EXPO_PUBLIC_API_URL.length > 0
    ? process.env.EXPO_PUBLIC_API_URL
    : "http://localhost:4000";

const ACCESS_KEY = "genze_access";
const REFRESH_KEY = "genze_refresh";

export class ApiClientError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Step 10 backend routes from the mobile task contract. These are NOT in
 * @genze/shared yet (the API worker has not landed them) — they live here
 * in exactly one place so they can be moved into API_ROUTES later.
 * Calls to them degrade gracefully (plain-language "not available yet")
 * until the backend exists.
 */
const STEP10_ROUTES = {
  authApple: "/api/v1/auth/apple",
  moderationReport: "/api/v1/moderation/report",
  moderationBlock: "/api/v1/moderation/block",
} as const;

/* ---------- tokens ---------- */

export async function getTokens(): Promise<{ access: string | null; refresh: string | null }> {
  const [access, refresh] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_KEY),
    SecureStore.getItemAsync(REFRESH_KEY),
  ]);
  return { access, refresh };
}

export async function setTokens(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, refreshToken),
  ]);
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}

/** The session provider sets this; fired when a refresh fails so the UI can route to login. */
let onSessionExpired: (() => void) | null = null;
export function setOnSessionExpired(cb: (() => void) | null): void {
  onSessionExpired = cb;
}

interface FetchOptions extends RequestInit {
  /** Skip the 401 -> refresh -> retry flow (e.g. on the login form itself). */
  skipRefresh?: boolean;
}

function toApiError(status: number, body: unknown): ApiClientError {
  const err = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)
    ?.error;
  const code = err?.code ?? "UNKNOWN";
  const message = err?.message ?? `Request failed (${status})`;
  return new ApiClientError(code, message, status, err?.details);
}

async function parseErrorResponse(res: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return toApiError(res.status, body);
}

async function refreshOnce(): Promise<string | null> {
  const { refresh } = await getTokens();
  if (!refresh) return null;
  try {
    const res = await fetch(`${API_BASE}${API_ROUTES.refresh}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as ApiResponse<AuthTokens>;
    const tokens = (json as { data?: AuthTokens }).data;
    if (tokens?.accessToken && tokens?.refreshToken) {
      await setTokens(tokens.accessToken, tokens.refreshToken);
      return tokens.accessToken;
    }
  } catch {
    /* network failure */
  }
  return null;
}

/**
 * Fetch against the API. Attaches the access token; on 401 tries one
 * refresh-rotation then retries the request once. If the refresh fails too,
 * tokens are cleared and the session-expiry hook fires (the UI routes to
 * login — no window.location on native).
 */
export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { skipRefresh, ...init } = options;
  const { access } = await getTokens();

  const doFetch = async (token: string | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  };

  let res = await doFetch(access);

  if (res.status === 401 && !skipRefresh && access) {
    const fresh = await refreshOnce();
    if (fresh) {
      res = await doFetch(fresh);
    } else {
      await clearTokens();
      if (onSessionExpired) onSessionExpired();
      throw new ApiClientError("UNAUTHORIZED", "Please log in again.", 401);
    }
  }

  if (!res.ok) throw await parseErrorResponse(res);
  const json = (await res.json()) as ApiResponse<T>;
  return (json as { data?: T }).data as T;
}

/** Multipart upload with the same auth/refresh behaviour as apiFetch. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const { access } = await getTokens();

  const doFetch = async (token: string | null): Promise<Response> => {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    // Do NOT set Content-Type: fetch adds the multipart boundary itself.
    return fetch(`${API_BASE}${path}`, { method: "POST", headers, body: form });
  };

  let res = await doFetch(access);
  if (res.status === 401 && access) {
    const fresh = await refreshOnce();
    if (fresh) {
      res = await doFetch(fresh);
    } else {
      await clearTokens();
      if (onSessionExpired) onSessionExpired();
      throw new ApiClientError("UNAUTHORIZED", "Please log in again.", 401);
    }
  }
  if (!res.ok) throw await parseErrorResponse(res);
  const json = (await res.json()) as ApiResponse<T>;
  return (json as { data?: T }).data as T;
}

/* ---------- SSE streaming over XMLHttpRequest ---------- */

/** "chat"-class SSE events — everything the composer cares about. */
const KNOWN_EVENT_TYPES = new Set([
  "start",
  "token",
  "compacted",
  "done",
  "error",
  "tool_activity",
  "confirmation_required",
]);

export interface StreamOptions {
  /** Called for every parsed SSE event (start, token, done, error, …). */
  onEvent: (event: ChatStreamEvent) => void;
  /** Abort the stream (STOP button). */
  signal?: AbortSignal;
}

function dispatchSSEChunk(chunk: string, onEvent: (event: ChatStreamEvent) => void): void {
  for (const line of chunk.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith(":")) continue; // heartbeat comments
    if (!text.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(text.slice(5).trim()) as { type?: string };
      if (ev && typeof ev.type === "string" && KNOWN_EVENT_TYPES.has(ev.type)) {
        onEvent(ev as ChatStreamEvent);
      }
    } catch {
      /* ignore malformed lines */
    }
  }
}

/**
 * POSTs to an SSE endpoint and parses the incremental `data:` lines via
 * XMLHttpRequest (React Native fetch cannot stream response bodies).
 * `body` may be a JSON object or a FormData (for the voice endpoint —
 * Content-Type is then left for XHR to set with the multipart boundary).
 *
 * Gate failures (401/403/503/…) arrive as a normal HTTP error BEFORE the
 * stream starts and become ApiClientError with the API's plain-language
 * message — e.g. 403 CONSENT_REQUIRED, which the chat screen routes back
 * to the AI consent screen. Terminal provider failures arrive mid-stream
 * as `{type:"error"}` events and are delivered to onEvent (not thrown).
 */
export async function streamSSE(
  path: string,
  body: Record<string, unknown> | FormData,
  { onEvent, signal }: StreamOptions,
): Promise<void> {
  let { access } = await getTokens();

  const attempt = (token: string | null): Promise<void> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        xhr.abort();
        finish(() => resolve());
      };
      if (signal) {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", onAbort);
      }

      let buffer = "";
      let lastLen = 0;
      const pump = () => {
        const text = xhr.responseText.slice(lastLen);
        lastLen = xhr.responseText.length;
        buffer += text;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          dispatchSSEChunk(chunk, onEvent);
        }
      };

      xhr.open("POST", `${API_BASE}${path}`);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      const isForm = typeof FormData !== "undefined" && body instanceof FormData;
      if (!isForm) xhr.setRequestHeader("Content-Type", "application/json");

      xhr.onprogress = () => pump();
      xhr.onload = () => {
        pump();
        if (buffer.trim().length > 0) dispatchSSEChunk(buffer, onEvent);
        buffer = "";
        if (xhr.status === 401) {
          finish(() => reject(new ApiClientError("UNAUTHORIZED", "Please log in again.", 401)));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(xhr.responseText);
          } catch {
            /* not JSON */
          }
          finish(() => reject(toApiError(xhr.status, parsed)));
          return;
        }
        finish(() => resolve());
      };
      xhr.onerror = () => finish(() => reject(new ApiClientError("NETWORK_ERROR", "Couldn't reach Genze. Check your connection and try again.", 0)));
      xhr.ontimeout = () => finish(() => reject(new ApiClientError("NETWORK_ERROR", "The request took too long. Please try again.", 0)));
      xhr.send(isForm ? (body as FormData) : JSON.stringify(body));
    });

  try {
    await attempt(access);
  } catch (err) {
    // One refresh + retry on 401, mirroring apiFetch (web chat.ts does the same).
    if (err instanceof ApiClientError && err.code === "UNAUTHORIZED" && access) {
      const fresh = await refreshOnce();
      if (fresh) {
        access = fresh;
        await attempt(access);
        return;
      }
      await clearTokens();
      if (onSessionExpired) onSessionExpired();
    }
    throw err;
  }
}

/* ---------- auth ---------- */

export interface LoginResult {
  tokens: AuthTokens;
  user: User;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const data = await apiFetch<{ tokens: AuthTokens; user: User } & { twoFactorRequired?: boolean }>(
    API_ROUTES.login,
    {
      method: "POST",
      skipRefresh: true,
      body: JSON.stringify({ email, password }),
    },
  );
  if (data.twoFactorRequired || !data.tokens) {
    // 202: this account needs its authenticator code. Mobile v1 does not
    // implement the TOTP step — the web app handles it; the user can then
    // use Google/Apple sign-in here.
    throw new ApiClientError(
      "TWO_FACTOR_REQUIRED",
      "This account uses two-factor sign-in. Please sign in on the web app first.",
      202,
    );
  }
  await setTokens(data.tokens.accessToken, data.tokens.refreshToken);
  return data;
}

/**
 * Sign in with Apple. `identityToken` comes from expo-apple-authentication
 * (iOS only). The backend verifies it with Apple and returns the same
 * token pair as password login.
 */
export async function loginWithApple(identityToken: string): Promise<LoginResult> {
  const data = await apiFetch<{ tokens: AuthTokens; user: User }>(STEP10_ROUTES.authApple, {
    method: "POST",
    skipRefresh: true,
    body: JSON.stringify({ identityToken }),
  });
  await setTokens(data.tokens.accessToken, data.tokens.refreshToken);
  return data;
}

export async function signup(email: string, password: string, country: string): Promise<void> {
  await apiFetch<{ user: User }>(API_ROUTES.signup, {
    method: "POST",
    skipRefresh: true,
    body: JSON.stringify({ email, password, country }),
  });
}

export async function verifyEmail(token: string): Promise<void> {
  await apiFetch<{ user: User }>(API_ROUTES.verifyEmail, {
    method: "POST",
    skipRefresh: true,
    body: JSON.stringify({ token }),
  });
}

export async function forgotPassword(email: string): Promise<void> {
  await apiFetch<unknown>(API_ROUTES.forgotPassword, {
    method: "POST",
    skipRefresh: true,
    body: JSON.stringify({ email }),
  });
}

export async function logout(): Promise<void> {
  try {
    const { refresh } = await getTokens();
    await apiFetch<unknown>(API_ROUTES.logout, {
      method: "POST",
      body: JSON.stringify({ refreshToken: refresh ?? undefined }),
    });
  } catch {
    /* best effort — local wipe happens regardless */
  }
  await clearTokens();
}

/* ---------- account ---------- */

export async function getMe(): Promise<User> {
  const data = await apiFetch<{ user: User }>(API_ROUTES.me);
  return data.user;
}

export async function updateAccount(patch: {
  preferredLanguage?: string;
  aiNoticeAccepted?: boolean;
}): Promise<User> {
  const data = await apiFetch<{ user: User }>(API_ROUTES.me, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.user;
}

export async function deleteAccount(input: { password?: string; oauthConfirm?: boolean }): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.deleteAccount, {
    method: "DELETE",
    body: JSON.stringify(input),
  });
  await clearTokens();
}

export async function getUsageSummary(): Promise<UsageSummary> {
  // The API returns the summary object directly as `data` (mirrors web lib/usage.ts).
  return apiFetch<UsageSummary>(API_ROUTES.usageSummary);
}

/* ---------- chat ---------- */

export async function listThreads(): Promise<ChatThread[]> {
  const data = await apiFetch<{ threads: ChatThread[] }>(API_ROUTES.chatThreads);
  return data.threads;
}

export async function createThread(title?: string): Promise<ChatThread> {
  const data = await apiFetch<{ thread: ChatThread }>(API_ROUTES.chatThreads, {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
  return data.thread;
}

export async function getMessages(threadId: string): Promise<ChatMessage[]> {
  const data = await apiFetch<{ messages: ChatMessage[] }>(API_ROUTES.chatMessages(threadId));
  return data.messages;
}

export async function deleteThread(threadId: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.chatThread(threadId), { method: "DELETE" });
}

export function streamChatMessage(
  threadId: string,
  content: string,
  options: StreamOptions,
): Promise<void> {
  return streamSSE(API_ROUTES.chatMessages(threadId), { content }, options);
}

/* ---------- consent ---------- */

export async function getConsent(): Promise<ConsentProviderStatus[]> {
  const data = await apiFetch<{ providers: ConsentProviderStatus[] }>(API_ROUTES.chatConsent);
  return data.providers;
}

export async function grantConsent(providerIds: string[]): Promise<string[]> {
  const data = await apiFetch<{ granted: string[] }>(API_ROUTES.chatConsent, {
    method: "POST",
    body: JSON.stringify({ providerIds }),
  });
  return data.granted;
}

export async function revokeConsent(provider: string): Promise<void> {
  await apiFetch<{ revoked: boolean }>(API_ROUTES.chatConsentProvider(provider), { method: "DELETE" });
}

/* ---------- voice ---------- */

export interface TranscribeResult {
  transcript: string;
  provider: string;
}

/** React Native file descriptor for FormData (uri/name/type). */
function rnFile(uri: string, name: string, type: string): unknown {
  return { uri, name, type };
}

/** POST /studio/voice/transcribe — multipart audio, returns the transcript text. */
export async function transcribeAudio(audioUri: string): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("audio", rnFile(audioUri, "voice.m4a", "audio/m4a") as unknown as Blob);
  const data = await apiUpload<{ transcript: string; provider: string }>(
    API_ROUTES.studioVoiceTranscribe,
    form,
  );
  return { transcript: data.transcript, provider: data.provider };
}

/**
 * POST /chat/threads/:id/voice — multipart audio. The server transcribes,
 * posts the transcript as the user message, then the response IS the chat
 * SSE stream (same wire protocol as text chat).
 */
export function streamVoiceMessage(
  threadId: string,
  audioUri: string,
  options: StreamOptions,
): Promise<void> {
  const form = new FormData();
  form.append("audio", rnFile(audioUri, "voice.m4a", "audio/m4a") as unknown as Blob);
  return streamSSE(API_ROUTES.chatThreadVoice(threadId), form, options);
}

/* ---------- library ---------- */

export async function getLibrary(q?: string): Promise<LibraryGroup[]> {
  const path = q && q.length > 0 ? `${API_ROUTES.library}?q=${encodeURIComponent(q)}` : API_ROUTES.library;
  const data = await apiFetch<{ groups: LibraryGroup[] }>(path);
  return data.groups;
}

/* ---------- moderation (Step 10 backend contract) ---------- */

export type ReportTargetType = "chat_message" | "image" | "audio" | "video" | "text";

/**
 * Report an AI-generated item. The backend route does not exist yet
 * (Step 10 API work); until it lands, this throws a plain-language
 * "not available yet" instead of a raw 404 so the UI stays honest.
 */
export async function reportContent(
  targetType: ReportTargetType,
  targetId: string,
  reason?: string,
): Promise<void> {
  try {
    await apiFetch<{ reported: boolean }>(STEP10_ROUTES.moderationReport, {
      method: "POST",
      body: JSON.stringify({ targetType, targetId, ...(reason ? { reason } : {}) }),
    });
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) {
      throw new ApiClientError(
        "NOT_AVAILABLE",
        "Reporting isn't available yet. Please try again later.",
        404,
      );
    }
    throw err;
  }
}

/** Block another user (shared content). Same graceful-degradation as reportContent. */
export async function blockUser(userId: string): Promise<void> {
  try {
    await apiFetch<{ blocked: boolean }>(STEP10_ROUTES.moderationBlock, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) {
      throw new ApiClientError(
        "NOT_AVAILABLE",
        "Blocking isn't available yet. Please try again later.",
        404,
      );
    }
    throw err;
  }
}
