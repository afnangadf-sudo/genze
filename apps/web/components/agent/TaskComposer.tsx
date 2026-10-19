"use client";

import { useEffect, useState } from "react";
import type { Project } from "@genze/shared";
import { createAgentTask, friendlyAgentError, type AgentTask } from "../../lib/agent";
import { listProjects } from "../../lib/projects";
import { Button } from "../Button";
import { fieldInputClass } from "../Field";
import type { Strings } from "../../lib/lang";

/**
 * The "what should I do?" composer: a big textarea in plain language, an
 * optional project (folder) picker, and Start. Errors (browser not set up,
 * limits, credits…) show inline — never as pop-ups.
 */
export function TaskComposer({
  t,
  value,
  onChange,
  onCreated,
}: {
  t: Strings;
  value: string;
  onChange: (v: string) => void;
  onCreated: (task: AgentTask) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((ps) => {
        if (!cancelled) setProjects(ps);
      })
      .catch(() => {
        /* projects are optional — the composer still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    const task = value.trim();
    if (!task || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await createAgentTask({
        task,
        ...(projectId ? { projectId } : {}),
      });
      onChange("");
      onCreated(created);
    } catch (err) {
      setError(friendlyAgentError(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t.agent_new_task} className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
      <label htmlFor="agent-task-text" className="block text-sm font-medium text-stone-600 dark:text-stone-300">
        {t.agent_what}
      </label>
      <textarea
        id="agent-task-text"
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t.agent_what_ph}
        className={`${fieldInputClass} mt-2 resize-y`}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-xs">
          <span className="shrink-0 text-sm text-stone-500 dark:text-stone-400">{t.agent_folder}</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={`${fieldInputClass} min-w-0 flex-1`}
            aria-label={t.agent_folder}
          >
            <option value="">{t.agent_folder_none}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <span className="ms-auto" />
        <Button onClick={submit} disabled={busy || value.trim().length === 0}>
          {busy ? t.agent_create_busy : t.agent_create}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
