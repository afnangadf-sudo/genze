// Chat API client: SSE streaming for replies + REST wrappers for threads,
// messages and consent. Every route comes from API_ROUTES (@genze/shared) —
// never hardcoded.

import {
  API_ROUTES,
  type ChatConfirmationRequiredEvent,
  type ChatMessage,
  type ChatStreamEvent,
  type ChatThread,
  type ChatToolActivityEvent,
  type ConsentProviderStatus,
  type TempChatMessageInput,
} from "@genze/shared";
import { API_BASE, ApiClientError, apiFetch, clearTokens, getTokens, setTokens } from "./auth";

/**
 * The streaming chat protocol plus the Step 6 connector events.
 * (The shared ChatStreamEvent union doesn't include them yet — they are
 * declared separately in @genze/shared, so the web unions them here rather
 * than editing the shared package.)
 */
export type ExtendedChatStreamEvent =
  | ChatStreamEvent
  | ChatConfirmationRequiredEvent
  | ChatToolActivityEvent;

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
  onEvent: (event: ExtendedChatStreamEvent) => void;
  /** Abort the stream (STOP button). */
  signal?: AbortSignal;
  /** Attached file ids — sent in the POST body so the reply can use them. */
  fileIds?: string[];
  /** Connected connector ids the assistant may use for this message. */
  useConnectors?: string[];
  /** Pending write confirmations the user just approved (resend after confirm). */
  confirmedActions?: { confirmationId: string }[];
}

export interface TempStreamOptions {
  /** Called for every parsed SSE event (start, token, done, error). */
  onEvent: (event: ExtendedChatStreamEvent) => void;
  /** Abort the stream (STOP button). */
  signal?: AbortSignal;
  /** Routing hint for the stateless reply (search, write, …). */
  taskType?: string;
  /** Guided-learning mode for the stateless reply — nothing is persisted. */
  tutor?: boolean;
}

async function toApiError(res: Response): Promise<ApiClientError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null =
    null;
  try {
    body = (await res.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
  } catch {
    /* not JSON */
  }
  const code = body?.error?.code ?? "UNKNOWN";
  const message = body?.error?.message ?? `Request failed (${res.status})`;
  return new ApiClientError(code, message, res.status, body?.error?.details);
}

/** Mirrors lib/auth's refresh flow for the streaming POST (which can't use apiFetch). */
async function refreshOnce(): Promise<boolean> {
  const { refresh } = getTokens();
  if (!refresh) return false;
  try {
    const res = await fetch(`${API_BASE}${API_ROUTES.refresh}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { accessToken?: string; refreshToken?: string } };
    const tokens = json.data;
    if (tokens?.accessToken && tokens?.refreshToken) {
      setTokens(tokens.accessToken, tokens.refreshToken);
      return true;
    }
  } catch {
    /* network failure */
  }
  return false;
}

/** Shared SSE plumbing for the streaming chat POSTs (thread + temporary). */
function postStreamHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getTokens().access;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function postStream(url: string, body: object, signal?: AbortSignal) {
  return fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers: postStreamHeaders(),
    body: JSON.stringify(body),
    signal,
  });
}

async function readSSE(res: Response, onEvent: (event: ExtendedChatStreamEvent) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith(":")) continue; // heartbeat comments
      if (!text.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(text.slice(5).trim()) as { type?: string };
        // Only known protocol events reach the UI; unknown ones are ignored.
        if (ev && typeof ev.type === "string" && KNOWN_EVENT_TYPES.has(ev.type)) {
          onEvent(ev as ExtendedChatStreamEvent);
        }
      } catch {
        /* ignore malformed lines */
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatch(chunk);
      }
    }
    if (buffer.trim().length > 0) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}

/**
 * POSTs a streaming body, retries once on 401 after refreshing the session,
 * then reads the SSE event stream.
 */
async function streamPost(
  url: string,
  body: object,
  { onEvent, signal }: { onEvent: (event: ExtendedChatStreamEvent) => void; signal?: AbortSignal }
): Promise<void> {
  let res = await postStream(url, body, signal);

  if (res.status === 401 && (await refreshOnce())) {
    res = await postStream(url, body, signal);
  }
  if (res.status === 401) {
    // Session is dead — same behaviour as apiFetch: clear and send to login.
    clearTokens();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new ApiClientError("UNAUTHORIZED", "Please log in again.", 401);
  }
  if (!res.ok) throw await toApiError(res);
  await readSSE(res, onEvent);
}

/**
 * Streams an assistant reply as SSE events.
 *
 * The POST itself may fail (401/403/503/…) before the stream starts — those
 * become ApiClientError with the API's plain-language message. Inside the
 * stream, terminal provider failures arrive as `{type:"error"}` events and
 * are delivered to onEvent (not thrown). `: ping` heartbeat comments are
 * ignored.
 */
export async function streamChatMessage(
  threadId: string,
  content: string,
  { onEvent, signal, fileIds, useConnectors, confirmedActions }: StreamOptions
): Promise<void> {
  return streamPost(
    API_ROUTES.chatMessages(threadId),
    {
      content,
      ...(fileIds && fileIds.length > 0 ? { fileIds } : {}),
      ...(useConnectors && useConnectors.length > 0 ? { useConnectors } : {}),
      ...(confirmedActions && confirmedActions.length > 0 ? { confirmedActions } : {}),
    },
    { onEvent, signal }
  );
}

/**
 * Streams an assistant reply for a temporary (stateless) chat. No thread is
 * created and nothing is saved server-side — the caller keeps the messages.
 */
export async function streamTempChatMessage(
  messages: TempChatMessageInput[],
  { onEvent, signal, taskType, tutor }: TempStreamOptions
): Promise<void> {
  return streamPost(
    API_ROUTES.chatTempMessages,
    { messages, ...(taskType ? { taskType } : {}), ...(tutor ? { tutor: true } : {}) },
    { onEvent, signal }
  );
}

/** Toggles lockdown on a thread (no web/agent/memory when on). */
export async function setThreadLockdown(
  threadId: string,
  lockdown: boolean
): Promise<ChatThread> {
  const data = await apiFetch<{ thread: ChatThread }>(API_ROUTES.chatThread(threadId), {
    method: "PATCH",
    body: JSON.stringify({ lockdown }),
  });
  return data.thread;
}

/* ---------- Threads & messages ---------- */

export async function listThreads(): Promise<ChatThread[]> {
  const data = await apiFetch<{ threads: ChatThread[] }>(API_ROUTES.chatThreads);
  return data.threads;
}

export async function createThread(title?: string, projectId?: string, gemId?: string): Promise<ChatThread> {
  const body: { title?: string; projectId?: string; gemId?: string } = {};
  if (title) body.title = title;
  if (projectId) body.projectId = projectId;
  if (gemId) body.gemId = gemId;
  const data = await apiFetch<{ thread: ChatThread }>(API_ROUTES.chatThreads, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.thread;
}

/** Attaches a gem to a thread (or removes it with null). */
export async function setThreadGem(threadId: string, gemId: string | null): Promise<ChatThread> {
  const data = await apiFetch<{ thread: ChatThread }>(API_ROUTES.chatThread(threadId), {
    method: "PATCH",
    body: JSON.stringify({ gemId }),
  });
  return data.thread;
}

/** Toggles the thread's guided-learning ("Teach me") mode. */
export async function setThreadTutorMode(
  threadId: string,
  tutorMode: boolean
): Promise<ChatThread> {
  const data = await apiFetch<{ thread: ChatThread }>(API_ROUTES.chatThread(threadId), {
    method: "PATCH",
    body: JSON.stringify({ tutorMode }),
  });
  return data.thread;
}

export async function renameThread(threadId: string, title: string): Promise<ChatThread> {
  const data = await apiFetch<{ thread: ChatThread }>(API_ROUTES.chatThread(threadId), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  return data.thread;
}

export async function deleteThread(threadId: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.chatThread(threadId), { method: "DELETE" });
}

export async function getMessages(threadId: string): Promise<ChatMessage[]> {
  const data = await apiFetch<{ messages: ChatMessage[] }>(API_ROUTES.chatMessages(threadId));
  return data.messages;
}

export async function deleteMessage(messageId: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.chatMessage(messageId), { method: "DELETE" });
}

/* ---------- Consent ---------- */

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
