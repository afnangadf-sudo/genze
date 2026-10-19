"use client";

import type { AgentTask, AgentTaskStatus } from "../../lib/agent";
import type { Strings } from "../../lib/lang";

function badgeClasses(status: AgentTaskStatus): string {
  switch (status) {
    case "running":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
    case "planned":
    case "awaiting_approval":
    case "awaiting_confirmation":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
    case "paused_takeover":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300";
    case "failed":
    case "limit_stopped":
      return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
    default:
      return "bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300";
  }
}

export function statusLabel(status: AgentTaskStatus, t: Strings): string {
  switch (status) {
    case "planned":
      return t.agent_st_planned;
    case "awaiting_approval":
      return t.agent_st_awaiting_approval;
    case "running":
      return t.agent_st_running;
    case "paused_takeover":
      return t.agent_st_paused;
    case "awaiting_confirmation":
      return t.agent_st_awaiting_confirmation;
    case "done":
      return t.agent_st_done;
    case "failed":
      return t.agent_st_failed;
    case "cancelled":
      return t.agent_st_cancelled;
    case "limit_stopped":
      return t.agent_st_limit;
  }
}

export function StatusBadge({ status, t }: { status: AgentTaskStatus; t: Strings }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClasses(status)}`}
    >
      {statusLabel(status, t)}
    </span>
  );
}

function ClockIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/**
 * One row in the task list: the task text, a plain-word status badge, a
 * clock for scheduled tasks, and a "working in background" chip while it
 * runs. Clicking opens the detail view.
 */
export function TaskCard({
  task,
  t,
  selected,
  onSelect,
}: {
  task: AgentTask;
  t: Strings;
  selected: boolean;
  onSelect: () => void;
}) {
  const firstLine = task.task.split("\n")[0];
  return (
    <button
      onClick={onSelect}
      className={`block w-full rounded-xl border p-4 text-start transition-colors ${
        selected
          ? "border-clay bg-clay-soft/40 dark:border-clay dark:bg-stone-800"
          : "border-stone-200 bg-white hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700"
      }`}
    >
      <div className="flex items-start gap-2">
        {task.kind === "scheduled" && (
          <span className="mt-0.5 shrink-0 text-stone-400 dark:text-stone-500" title={t.agent_kind_scheduled} aria-label={t.agent_kind_scheduled}>
            <ClockIcon />
          </span>
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800 dark:text-stone-100">
          {firstLine}
        </p>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <StatusBadge status={task.status} t={t} />
        {task.status === "running" && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-0.5 text-xs text-stone-500 dark:bg-stone-800 dark:text-stone-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            {t.agent_bg}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-stone-400 dark:text-stone-500">
        {new Date(task.createdAt).toLocaleString()}
      </p>
    </button>
  );
}
