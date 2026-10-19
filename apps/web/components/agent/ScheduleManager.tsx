"use client";

import { useEffect, useState } from "react";
import {
  approveFirstRun,
  createSchedule,
  deleteSchedule,
  friendlyAgentError,
  listSchedules,
  updateSchedule,
  type AgentSchedule,
  type AgentScheduleSpec,
  type AgentTask,
} from "../../lib/agent";
import { Button } from "../Button";
import { Field, fieldInputClass } from "../Field";
import type { Strings } from "../../lib/lang";

type FreqKind = "daily" | "weekly" | "interval_hours";

function weekdayName(weekday: number, t: Strings): string {
  const names = [
    t.agent_wd_0,
    t.agent_wd_1,
    t.agent_wd_2,
    t.agent_wd_3,
    t.agent_wd_4,
    t.agent_wd_5,
    t.agent_wd_6,
  ];
  return names[weekday] ?? String(weekday);
}

function two(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Plain-words description of a schedule spec, e.g. "Every day at 09:00". */
function describeSchedule(spec: AgentScheduleSpec, t: Strings): string {
  if (spec.kind === "daily") {
    return `${t.agent_sched_daily} ${t.agent_sched_at} ${two(spec.hour)}:${two(spec.minute)}`;
  }
  if (spec.kind === "weekly") {
    return `${t.agent_sched_weekly} ${weekdayName(spec.weekday, t)} ${t.agent_sched_at} ${two(spec.hour)}:${two(spec.minute)}`;
  }
  return `${t.agent_sched_interval} ${spec.hours} ${t.agent_sched_hours}`;
}

/**
 * "Do this regularly": a plain-words schedule form (every day at / every
 * weekday at / every N hours + "ask me before each run") and the schedule
 * list with Pause / Resume / Delete. A schedule whose first run is still
 * waiting for approval shows an "OK — run it" button; the waiting task is
 * found by correlating task.scheduleId with the schedule id.
 */
export function ScheduleManager({
  t,
  tasks,
  onTasksChanged,
}: {
  t: Strings;
  tasks: AgentTask[];
  onTasksChanged: () => void;
}) {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [freq, setFreq] = useState<FreqKind>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [hours, setHours] = useState(6);
  const [askFirst, setAskFirst] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setSchedules(await listSchedules());
    } catch {
      /* keep the old list on failure */
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const buildSpec = (): AgentScheduleSpec => {
    const [h, m] = time.split(":").map((x) => parseInt(x, 10));
    const hour = Number.isFinite(h) ? h : 9;
    const minute = Number.isFinite(m) ? m : 0;
    if (freq === "weekly") return { kind: "weekly", weekday, hour, minute };
    if (freq === "interval_hours") return { kind: "interval_hours", hours: Math.max(1, hours) };
    return { kind: "daily", hour, minute };
  };

  const save = async () => {
    if (!title.trim() || !task.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await createSchedule({
        title: title.trim(),
        task: task.trim(),
        schedule: buildSpec(),
        autoApprove: !askFirst,
      });
      setTitle("");
      setTask("");
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(friendlyAgentError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: AgentSchedule) => {
    try {
      await updateSchedule(s.id, { enabled: !s.enabled });
      await refresh();
    } catch (err) {
      setError(friendlyAgentError(err, t));
    }
  };

  const remove = async (s: AgentSchedule) => {
    try {
      await deleteSchedule(s.id);
      await refresh();
    } catch (err) {
      setError(friendlyAgentError(err, t));
    }
  };

  const approveFirst = async (s: AgentSchedule) => {
    try {
      await approveFirstRun(s.id);
      onTasksChanged();
    } catch (err) {
      setError(friendlyAgentError(err, t));
    }
  };

  const waitingFirstRun = (s: AgentSchedule) =>
    s.enabled &&
    tasks.some((task) => task.scheduleId === s.id && task.status === "planned");

  return (
    <section aria-label={t.agent_sched} className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
        {t.agent_sched}
      </h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t.agent_sched_desc}</p>

      {!showForm ? (
        <Button className="mt-4" variant="ghost" onClick={() => setShowForm(true)}>
          {t.agent_sched_new}
        </Button>
      ) : (
        <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.agent_sched_title} id="sched-title">
              <input
                id="sched-title"
                className={fieldInputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t.agent_sched_title_ph}
              />
            </Field>
            <div className="sm:col-span-2">
              <label htmlFor="sched-task" className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300">
                {t.agent_sched_task}
              </label>
              <textarea
                id="sched-task"
                rows={2}
                className={`${fieldInputClass} resize-y`}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={t.agent_sched_task_ph}
              />
            </div>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300">
                {t.agent_sched_how_often}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={freq}
                  onChange={(e) => setFreq(e.target.value as FreqKind)}
                  className={fieldInputClass}
                  aria-label={t.agent_sched_how_often}
                >
                  <option value="daily">{t.agent_sched_daily}</option>
                  <option value="weekly">{t.agent_sched_weekly}</option>
                  <option value="interval_hours">{t.agent_sched_interval}</option>
                </select>
                {freq === "daily" && (
                  <>
                    <span className="text-sm text-stone-500 dark:text-stone-400">{t.agent_sched_at}</span>
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      className={fieldInputClass}
                      aria-label={t.agent_sched_at}
                    />
                  </>
                )}
                {freq === "weekly" && (
                  <>
                    <select
                      value={weekday}
                      onChange={(e) => setWeekday(parseInt(e.target.value, 10))}
                      className={fieldInputClass}
                      aria-label={t.agent_sched_weekly}
                    >
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <option key={d} value={d}>
                          {weekdayName(d, t)}
                        </option>
                      ))}
                    </select>
                    <span className="text-sm text-stone-500 dark:text-stone-400">{t.agent_sched_at}</span>
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      className={fieldInputClass}
                      aria-label={t.agent_sched_at}
                    />
                  </>
                )}
                {freq === "interval_hours" && (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={hours}
                      onChange={(e) => setHours(parseInt(e.target.value, 10) || 1)}
                      className={`${fieldInputClass} w-20`}
                      aria-label={t.agent_sched_hours}
                    />
                    <span className="text-sm text-stone-500 dark:text-stone-400">{t.agent_sched_hours}</span>
                  </>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 self-end pb-1">
              <input
                type="checkbox"
                checked={askFirst}
                onChange={(e) => setAskFirst(e.target.checked)}
                className="h-4 w-4 accent-[#b3552e]"
              />
              <span className="text-sm text-stone-600 dark:text-stone-300">{t.agent_sched_ask_first}</span>
            </label>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button onClick={save} disabled={busy || !title.trim() || !task.trim()}>
              {t.agent_sched_save}
            </Button>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={busy}>
              {t.agent_cancel_task}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {schedules.length === 0 && !showForm && (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.agent_sched_empty}</p>
        )}
        {schedules.map((s) => {
          const waiting = waitingFirstRun(s);
          return (
            <div
              key={s.id}
              className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{s.title}</p>
                  <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                    {describeSchedule(s.schedule, t)}
                    {!s.enabled && ` · ${t.agent_sched_paused}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {waiting && (
                    <>
                      <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        {t.agent_sched_waiting_first}
                      </span>
                      <Button onClick={() => void approveFirst(s)}>{t.agent_sched_approve_first}</Button>
                    </>
                  )}
                  <Button variant="ghost" onClick={() => void toggle(s)}>
                    {s.enabled ? t.agent_sched_pause : t.agent_sched_resume}
                  </Button>
                  <Button variant="ghost" onClick={() => void remove(s)}>
                    {t.agent_sched_delete}
                  </Button>
                </div>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-stone-600 dark:text-stone-300">{s.task}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
