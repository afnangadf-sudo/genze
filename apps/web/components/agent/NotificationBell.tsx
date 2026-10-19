"use client";

import { useEffect, useState } from "react";
import { listNotifications, markNotificationRead, type AgentNotification } from "../../lib/agent";
import type { Strings } from "../../lib/lang";

function BellIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

/**
 * The agent updates bell: an unread count badge and a small dropdown.
 * Clicking an item marks it read and opens the task. The exactly-one-
 * notification-per-event semantics live on the API.
 */
export function NotificationBell({
  t,
  onOpenTask,
}: {
  t: Strings;
  onOpenTask: (taskId: string) => void;
}) {
  const [notifications, setNotifications] = useState<AgentNotification[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = async () => {
    try {
      setNotifications(await listNotifications());
    } catch {
      /* bell stays quiet on failure */
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, []);

  const unread = notifications.filter((n) => !n.read).length;

  const openNotification = async (n: AgentNotification) => {
    try {
      if (!n.read) await markNotificationRead(n.id);
    } catch {
      /* still navigate — the read marker is best-effort */
    }
    setOpen(false);
    onOpenTask(n.taskId);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={t.agent_notif}
        title={t.agent_notif}
        className="relative rounded-lg p-2 text-stone-500 hover:bg-stone-200/60 dark:text-stone-400 dark:hover:bg-stone-800"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -top-0.5 -end-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-clay px-1 text-[11px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 z-20 mt-2 w-80 max-w-[calc(100vw-3rem)] rounded-2xl border border-stone-200 bg-white p-2 shadow-lg dark:border-stone-700 dark:bg-stone-900">
          {notifications.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-stone-500 dark:text-stone-400">
              {t.agent_notif_empty}
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => void openNotification(n)}
                    className="flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-start hover:bg-stone-100 dark:hover:bg-stone-800"
                  >
                    {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-clay" aria-hidden />}
                    <span className="min-w-0">
                      <span className={`block truncate text-sm ${n.read ? "text-stone-500 dark:text-stone-400" : "font-medium text-stone-800 dark:text-stone-100"}`}>
                        {n.title}
                      </span>
                      <span className="block text-xs text-stone-400 dark:text-stone-500">
                        {new Date(n.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
