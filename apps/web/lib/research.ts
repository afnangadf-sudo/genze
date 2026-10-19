// Research API client: jobs, plan, start, SSE progress events (+ polling
// fallback), report, exports, citations. Every route comes from API_ROUTES
// (@genze/shared) — never hardcoded. Auth follows lib/auth (apiFetch with
// 401 -> refresh -> retry); the SSE endpoint reuses chat.ts's refresh-once
// pattern because apiFetch can't stream a Response body.

import {
  API_ROUTES,
  type ResearchEvent,
  type ResearchJob,
} from "@genze/shared";
import { API_BASE, ApiClientError, apiFetch, getTokens, setTokens } from "./auth";

export interface CitationText {
  n: number;
  text: string;
}

export async function createResearchJob(topic: string, threadId?: string): Promise<ResearchJob> {
  const body: { topic: string; threadId?: string } = { topic };
  if (threadId) body.threadId = threadId;
  const data = await apiFetch<{ job: ResearchJob }>(API_ROUTES.researchJobs, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.job;
}

export async function listResearchJobs(): Promise<ResearchJob[]> {
  const data = await apiFetch<{ jobs: ResearchJob[] }>(API_ROUTES.researchJobs);
  return data.jobs;
}

export async function getResearchJob(id: string): Promise<ResearchJob> {
  const data = await apiFetch<{ job: ResearchJob }>(API_ROUTES.researchJob(id));
  return data.job;
}

export async function startResearchJob(id: string): Promise<ResearchJob> {
  const data = await apiFetch<{ job: ResearchJob }>(API_ROUTES.researchJobStart(id), {
    method: "POST",
  });
  return data.job;
}

export async function cancelResearchJob(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.researchJob(id), { method: "DELETE" });
}

export async function getCitations(id: string, style: "apa" | "mla"): Promise<CitationText[]> {
  const data = await apiFetch<{ citations: CitationText[] }>(
    `${API_ROUTES.researchJobCitations(id)}?style=${style}`
  );
  return data.citations;
}

/** Download an export file (pdf/docx/md) via the authenticated GET route. */
export async function downloadResearchExport(
  id: string,
  format: "pdf" | "docx" | "md",
  filename: string
): Promise<void> {
  await downloadAuthed(`${API_ROUTES.researchJobExport(id)}?format=${format}`, filename);
}

async function downloadAuthed(path: string, filename: string): Promise<void> {
  const { access } = getTokens();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: access ? { Authorization: `Bearer ${access}` } : {},
  });
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  triggerDownload(URL.createObjectURL(blob), filename);
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

async function toApiError(res: Response): Promise<ApiClientError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null =
    null;
  try {
    body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
  } catch {
    /* not JSON */
  }
  const code = body?.error?.code ?? "UNKNOWN";
  const message = body?.error?.message ?? `Request failed (${res.status})`;
  return new ApiClientError(code, message, res.status, body?.error?.details);
}

/* ---------- SSE progress events (+ polling fallback) ---------- */

export interface ResearchEventsCallbacks {
  onProgress: (ev: Extract<ResearchEvent, { type: "progress" }>) => void;
  /** A terminal status arrived ("done" event or job status done/failed/cancelled). */
  onTerminal: (job: ResearchJob) => void;
  onError: (err: unknown) => void;
}

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

/**
 * Subscribes to a research job's progress. Tries the SSE /events endpoint
 * first; if it can't be established, falls back to polling GET
 * /research/jobs/:id every 2 s until a terminal status. Returns a stop
 * function the caller must run on unmount/job change.
 */
export function subscribeResearchJob(id: string, cb: ResearchEventsCallbacks): () => void {
  let stopped = false;
  const controller = new AbortController();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    stopped = true;
    controller.abort();
    if (pollTimer) clearInterval(pollTimer);
  };

  function startPolling() {
    if (stopped) return;
    const tick = async () => {
      if (stopped) return;
      try {
        const job = await getResearchJob(id);
        if (stopped) return;
        if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
          cb.onTerminal(job);
          stop();
        } else {
          cb.onProgress({
            type: "progress",
            phase: job.progress.phase,
            done: job.progress.done,
            total: job.progress.total,
            message: job.progress.message,
          });
        }
      } catch (err) {
        cb.onError(err);
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), 2000);
  }

  async function runSSE() {
    const url = `${API_BASE}${API_ROUTES.researchJobEvents(id)}`;
    const attempt = async (): Promise<Response> => {
      const { access } = getTokens();
      return fetch(url, {
        headers: access ? { Authorization: `Bearer ${access}` } : {},
        signal: controller.signal,
      });
    };
    let res: Response;
    try {
      res = await attempt();
    } catch {
      startPolling();
      return;
    }
    if (res.status === 401 && (await refreshOnce())) {
      try {
        res = await attempt();
      } catch {
        startPolling();
        return;
      }
    }
    if (!res.ok || !res.body) {
      startPolling();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawTerminal = false;

    const dispatch = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const text = line.trim();
        if (!text || text.startsWith(":")) continue;
        if (!text.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(text.slice(5).trim()) as ResearchEvent;
          if (ev.type === "progress") {
            cb.onProgress(ev);
          } else if (ev.type === "done") {
            sawTerminal = true;
            // The job row is the source of truth — re-read it once; if that
            // read fails, fall back to polling rather than hanging.
            getResearchJob(id)
              .then((job) => {
                if (!stopped) cb.onTerminal(job);
                stop();
              })
              .catch(() => {
                if (!stopped) startPolling();
              });
          } else if (ev.type === "error") {
            sawTerminal = true;
            cb.onError(new ApiClientError(ev.code, ev.message, 0));
            stop();
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
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      if (!sawTerminal && !stopped) startPolling();
      return;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    // Stream ended without a terminal event — the job may still be running.
    if (!sawTerminal && !stopped) startPolling();
  }

  void runSSE();
  return stop;
}
