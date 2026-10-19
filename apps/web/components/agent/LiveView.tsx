"use client";

import { useState } from "react";
import type { AgentTask } from "../../lib/agent";
import { Button } from "../Button";
import type { Strings } from "../../lib/lang";

/**
 * The agent's live browser view: an embedded iframe of the cloud browser
 * session, with Take over / Hand back controls. If the frame refuses to
 * load (e.g. X-Frame-Options on the session URL), we fall back to a plain
 * "open in a new tab" link instead of a broken frame.
 */
export function LiveView({
  task,
  t,
  busy,
  onTake,
  onRelease,
}: {
  task: AgentTask;
  t: Strings;
  busy: boolean;
  onTake: () => void;
  onRelease: () => void;
}) {
  const [blocked, setBlocked] = useState(false);
  if (!task.liveViewUrl) return null;
  const takenOver = task.status === "paused_takeover";

  return (
    <section
      aria-label={t.agent_live}
      className="overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-5 py-3 dark:border-stone-800">
        <h2 className="text-base font-semibold text-stone-800 dark:text-stone-100">{t.agent_live}</h2>
        <div className="flex items-center gap-2">
          <a
            href={task.liveViewUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg px-3 py-2 text-sm font-medium text-clay-dark hover:bg-clay-soft/60 dark:text-clay dark:hover:bg-stone-800"
          >
            {t.agent_live_open}
          </a>
          {takenOver ? (
            <Button onClick={onRelease} disabled={busy}>
              {t.agent_release}
            </Button>
          ) : (
            <Button onClick={onTake} disabled={busy}>
              {t.agent_take}
            </Button>
          )}
        </div>
      </div>
      {takenOver && (
        <p className="border-b border-sky-200 bg-sky-50 px-5 py-2.5 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
          {t.agent_st_paused}
        </p>
      )}
      {blocked ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.agent_live_blocked}</p>
          <a
            href={task.liveViewUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block rounded-lg bg-clay px-4 py-2.5 text-sm font-medium text-white hover:bg-clay-dark"
          >
            {t.agent_live_open}
          </a>
        </div>
      ) : (
        <div className="relative aspect-video w-full bg-stone-100 dark:bg-stone-950">
          <iframe
            key={task.liveViewUrl}
            src={task.liveViewUrl}
            title={t.agent_live}
            sandbox="allow-scripts allow-same-origin"
            allow="clipboard-read; clipboard-write"
            className="absolute inset-0 h-full w-full border-0"
            onError={() => setBlocked(true)}
          />
        </div>
      )}
    </section>
  );
}
