// Agent API client (Step 7): tasks, approvals, takeover, schedules,
// notifications, and the task SSE event stream. Every route comes from
// API_ROUTES (@genze/shared) — never hardcoded.

import {
  API_ROUTES,
  type AgentNotification as SharedAgentNotification,
  type AgentSchedule as SharedAgentSchedule,
  type AgentScheduleShape,
} from "@genze/shared";
import { API_BASE, ApiClientError, apiFetch, getTokens, setTokens } from "./auth";
import type { Strings } from "./lang";

/* ---------- route table (Step 7 agent routes from @genze/shared) ---------- */

const ROUTES = {
  tasks: API_ROUTES.agentTasks,
  task: API_ROUTES.agentTask,
  approve: API_ROUTES.agentTaskApprove,
  cancel: API_ROUTES.agentTaskCancel,
  events: API_ROUTES.agentTaskEvents,
  decideApproval: API_ROUTES.agentApprovalDecide,
  takeover: API_ROUTES.agentTaskTakeover,
  schedules: API_ROUTES.agentSchedules,
  schedule: API_ROUTES.agentSchedule,
  approveFirstRun: API_ROUTES.agentScheduleApproveFirstRun,
  notifications: API_ROUTES.agentNotifications,
  notificationRead: API_ROUTES.agentNotificationRead,
} as const;

/* ---------- types (contract shapes + local scheduleId) ---------- */

export interface AgentPlanStep {
  title: string;
  detail?: string;
}

export interface AgentPlan {
  steps: AgentPlanStep[];
  estimatedMinutes: number;
  estimatedCostUsd: number;
  requiresBrowser: boolean;
}

export type AgentTaskStatus =
  | "planned"
  | "awaiting_approval"
  | "running"
  | "paused_takeover"
  | "awaiting_confirmation"
  | "done"
  | "failed"
  | "cancelled"
  | "limit_stopped";

export interface AgentTask {
  id: string;
  kind: "task" | "scheduled";
  task: string;
  status: AgentTaskStatus;
  plan: AgentPlan | null;
  projectId: string | null;
  threadId: string | null;
  /** Local type carries scheduleId so the schedules UI can correlate
      waiting first runs — remove if the shared type ever adds it. */
  scheduleId?: string | null;
  stepsUsed: number;
  liveViewUrl: string | null;
  reportMarkdown: string | null;
  resultFiles: Array<{ name?: string; url?: string }>;
  screenshots: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentApprovalKind = "payment" | "deletion" | "send" | "public_post" | "form_submit";

export interface AgentApproval {
  id: string;
  taskId: string;
  kind: AgentApprovalKind;
  summary: string;
  status: string;
  expiresAt: string;
}

/** Shared schedule/notification types — single source of truth in @genze/shared. */
export type AgentNotification = SharedAgentNotification;
export type AgentScheduleSpec = AgentScheduleShape;
export type AgentSchedule = SharedAgentSchedule;

/** Statuses that keep a task "live": the tab polls while any of these exist. */
export const ACTIVE_TASK_STATUSES: AgentTaskStatus[] = [
  "running",
  "paused_takeover",
  "awaiting_approval",
  "awaiting_confirmation",
];

/* ---------- plain-language error mapping ---------- */

/** Maps API error codes from the agent contract to plain-language copy. */
export function friendlyAgentError(err: unknown, t: Strings): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case "BROWSER_NOT_CONFIGURED":
        return t.agent_err_browser;
      case "CREDITS_EXHAUSTED":
        return err.message || t.agent_err_credits;
      case "NO_PROVIDER_AVAILABLE":
        return t.agent_err_no_provider;
      case "CONSENT_REQUIRED":
        return t.agent_err_consent;
      case "LOCKDOWN":
        return t.agent_err_lockdown;
      case "LIMIT_EXCEEDED":
      case "LIMIT_STOPPED": {
        const resetAt = err.details?.resetAt;
        const base = err.message || t.err_rate_limited;
        if (typeof resetAt === "string") {
          const when = new Date(resetAt).toLocaleString();
          return `${base} ${t.agent_try_later.replace("{time}", when)}`;
        }
        return base;
      }
      default:
        return err.message;
    }
  }
  return t.err_generic;
}

/* ---------- REST calls ---------- */

export interface CreateTaskInput {
  task?: string;
  projectId?: string;
  threadId?: string;
}

export async function createAgentTask(input: CreateTaskInput): Promise<AgentTask> {
  const data = await apiFetch<{ task: AgentTask }>(ROUTES.tasks, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.task;
}

export async function listAgentTasks(): Promise<AgentTask[]> {
  const data = await apiFetch<{ tasks: AgentTask[] }>(ROUTES.tasks);
  return data.tasks;
}

export async function getAgentTask(id: string): Promise<AgentTask> {
  const data = await apiFetch<{ task: AgentTask }>(ROUTES.task(id));
  return data.task;
}

export async function approveAgentTask(id: string): Promise<AgentTask> {
  const data = await apiFetch<{ task: AgentTask }>(ROUTES.approve(id), { method: "POST" });
  return data.task;
}

export async function cancelAgentTask(id: string): Promise<AgentTask> {
  const data = await apiFetch<{ task: AgentTask }>(ROUTES.cancel(id), { method: "POST" });
  return data.task;
}

export async function decideApproval(id: string, approve: boolean): Promise<unknown> {
  const data = await apiFetch<{ result: unknown }>(ROUTES.decideApproval(id), {
    method: "POST",
    body: JSON.stringify({ approve }),
  });
  return data.result;
}

export async function takeoverAgentTask(id: string, action: "take" | "release"): Promise<AgentTask> {
  const data = await apiFetch<{ task: AgentTask }>(ROUTES.takeover(id), {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  return data.task;
}

export async function listSchedules(): Promise<AgentSchedule[]> {
  const data = await apiFetch<{ schedules: AgentSchedule[] }>(ROUTES.schedules);
  return data.schedules;
}

export async function createSchedule(input: {
  title: string;
  task: string;
  schedule: AgentScheduleSpec;
  autoApprove?: boolean;
}): Promise<AgentSchedule> {
  const data = await apiFetch<{ schedule: AgentSchedule }>(ROUTES.schedules, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.schedule;
}

export async function updateSchedule(
  id: string,
  patch: Partial<Pick<AgentSchedule, "title" | "task" | "schedule" | "enabled" | "autoApprove">>
): Promise<AgentSchedule> {
  const data = await apiFetch<{ schedule: AgentSchedule }>(ROUTES.schedule(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.schedule;
}

export async function deleteSchedule(id: string): Promise<void> {
  await apiFetch<unknown>(ROUTES.schedule(id), { method: "DELETE" });
}

export async function approveFirstRun(id: string): Promise<void> {
  await apiFetch<unknown>(ROUTES.approveFirstRun(id), { method: "POST" });
}

export async function listNotifications(): Promise<AgentNotification[]> {
  const data = await apiFetch<{ notifications: AgentNotification[] }>(ROUTES.notifications);
  return data.notifications;
}

export async function markNotificationRead(id: string): Promise<void> {
  await apiFetch<unknown>(ROUTES.notificationRead(id), { method: "POST" });
}

/* ---------- SSE task events (+ polling fallback) ---------- */

export type AgentStreamEvent =
  | { type: "plan"; plan: AgentPlan }
  | { type: "step"; n: number; total: number; title: string }
  | { type: "progress"; message: string }
  | { type: "approval_required"; approval: AgentApproval }
  | { type: "done"; task: AgentTask }
  | { type: "error"; code: string; message: string };

export interface AgentEventsCallbacks {
  onPlan: (plan: AgentPlan) => void;
  onStep: (n: number, total: number, title: string) => void;
  onProgress: (message: string) => void;
  onApproval: (approval: AgentApproval) => void;
  /** A terminal event arrived (or polling saw a terminal status). */
  onDone: (task: AgentTask) => void;
  onError: (err: unknown) => void;
}

const TERMINAL_STATUSES: AgentTaskStatus[] = ["done", "failed", "cancelled", "limit_stopped"];

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
 * Subscribes to an agent task's SSE events. Falls back to polling
 * GET /agent/tasks/:id every 3 s when the stream can't be established.
 * Returns a stop function the caller must run on unmount/task change.
 */
export function subscribeAgentTask(id: string, cb: AgentEventsCallbacks): () => void {
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
        const task = await getAgentTask(id);
        if (stopped) return;
        if (TERMINAL_STATUSES.includes(task.status)) {
          cb.onDone(task);
          stop();
        }
      } catch (err) {
        cb.onError(err);
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), 3000);
  }

  async function runSSE() {
    const url = `${API_BASE}${ROUTES.events(id)}`;
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
        if (!text || text.startsWith(":") || !text.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(text.slice(5).trim()) as AgentStreamEvent;
          switch (ev.type) {
            case "plan":
              cb.onPlan(ev.plan);
              break;
            case "step":
              cb.onStep(ev.n, ev.total, ev.title);
              break;
            case "progress":
              cb.onProgress(ev.message);
              break;
            case "approval_required":
              cb.onApproval(ev.approval);
              break;
            case "done":
              sawTerminal = true;
              // The task row is the source of truth — re-read it once.
              getAgentTask(id)
                .then((task) => {
                  if (!stopped) cb.onDone(task);
                  stop();
                })
                .catch(() => {
                  if (!stopped) startPolling();
                });
              break;
            case "error":
              sawTerminal = true;
              cb.onError(new ApiClientError(ev.code, ev.message, 0));
              stop();
              break;
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
    if (!sawTerminal && !stopped) startPolling();
  }

  void runSSE();
  return stop;
}

/** Make a possibly-relative API URL absolute for <img>/<a> tags. */
export function absoluteUrl(url: string): string {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${API_BASE}${url}`;
}
