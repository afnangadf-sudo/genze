"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TabShell } from "../../components/TabShell";
import { ConsentGate } from "../../components/ConsentGate";
import { MarkdownView } from "../../components/MarkdownView";
import { Button } from "../../components/Button";
import { useLang } from "../../lib/lang";
import {
  ACTIVE_TASK_STATUSES,
  absoluteUrl,
  approveAgentTask,
  cancelAgentTask,
  decideApproval,
  friendlyAgentError,
  getAgentTask,
  listAgentTasks,
  subscribeAgentTask,
  takeoverAgentTask,
  type AgentApproval,
  type AgentTask,
} from "../../lib/agent";
import { TaskComposer } from "../../components/agent/TaskComposer";
import { StatusBadge, TaskCard } from "../../components/agent/TaskCard";
import { PlanCard } from "../../components/agent/PlanCard";
import { LiveView } from "../../components/agent/LiveView";
import { StepTimeline, type TimelineStep } from "../../components/agent/StepTimeline";
import { ApprovalCard } from "../../components/agent/ApprovalCard";
import { ScheduleManager } from "../../components/agent/ScheduleManager";
import { NotificationBell } from "../../components/agent/NotificationBell";

const POLL_MS = 5000;

function applyStepEvent(prev: TimelineStep[], n: number, total: number, title: string): TimelineStep[] {
  const next: TimelineStep[] = [];
  for (let i = 1; i <= total; i++) {
    const existing = prev.find((s) => s.n === i);
    next.push({
      n: i,
      title: i === n ? title : (existing?.title ?? ""),
      state: i < n ? "done" : "current",
    });
  }
  return next;
}

export default function AgentPage() {
  return (
    <TabShell>
      <ConsentGate>
        <Suspense fallback={null}>
          <AgentHome />
        </Suspense>
      </ConsentGate>
    </TabShell>
  );
}

function AgentHome() {
  const { t } = useLang();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("task");

  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [task, setTask] = useState<AgentTask | null>(null);
  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [progressMessage, setProgressMessage] = useState("");
  const [approval, setApproval] = useState<AgentApproval | null>(null);
  const [decidedNote, setDecidedNote] = useState("");
  const [composerText, setComposerText] = useState("");
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);

  const tasksRef = useRef<AgentTask[]>([]);
  tasksRef.current = tasks;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    try {
      const list = await listAgentTasks();
      setTasks(list);
      setTasksLoaded(true);
    } catch {
      setTasksLoaded(true);
    }
  }, []);

  const refreshSelected = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) {
      setTask(null);
      return;
    }
    try {
      setTask(await getAgentTask(id));
      setDetailError("");
    } catch (err) {
      setDetailError(friendlyAgentError(err, t));
    }
  }, [t]);

  /* boot + selection changes */
  useEffect(() => {
    void refreshList();
    setSteps([]);
    setProgressMessage("");
    setApproval(null);
    setDecidedNote("");
    setDetailError("");
    void refreshSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /* background polling: every 5 s while any task is live, nothing otherwise */
  useEffect(() => {
    const tick = async () => {
      const anyActive = tasksRef.current.some((x) => ACTIVE_TASK_STATUSES.includes(x.status));
      if (!anyActive) return;
      await refreshList();
      const id = selectedRef.current;
      if (id) {
        try {
          const fresh = await getAgentTask(id);
          setTask(fresh);
        } catch {
          /* keep the last good detail */
        }
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshList]);

  /* live SSE stream for the selected task while it isn't terminal */
  useEffect(() => {
    if (!selectedId) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    getAgentTask(selectedId)
      .then((current) => {
        if (cancelled) return;
        if (["done", "failed", "cancelled", "limit_stopped"].includes(current.status)) return;
        stop = subscribeAgentTask(selectedId, {
          onPlan: (plan) => setTask((prev) => (prev ? { ...prev, plan } : prev)),
          onStep: (n, total, title) => setSteps((prev) => applyStepEvent(prev, n, total, title)),
          onProgress: (message) => setProgressMessage(message),
          onApproval: (a) => setApproval(a),
          onDone: (done) => {
            setTask(done);
            setApproval(null);
            void refreshList();
          },
          onError: (err) => setDetailError(friendlyAgentError(err, t)),
        });
      })
      .catch(() => {
        /* the polling loop covers failures */
      });
    return () => {
      cancelled = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selectTask = (id: string) => router.push(`/agent?task=${id}`);
  const clearSelection = () => router.push("/agent");

  const runAction = async (fn: () => Promise<AgentTask>) => {
    setBusy(true);
    setDetailError("");
    try {
      const updated = await fn();
      setTask(updated);
      await refreshList();
    } catch (err) {
      setDetailError(friendlyAgentError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const onApprove = () => task && void runAction(() => approveAgentTask(task.id));
  const onCancel = () => task && void runAction(() => cancelAgentTask(task.id));
  const onTake = () => task && void runAction(() => takeoverAgentTask(task.id, "take"));
  const onRelease = () => task && void runAction(() => takeoverAgentTask(task.id, "release"));

  /** Edit = cancel this task and prefill the composer with its text. */
  const onEdit = async () => {
    if (!task) return;
    const text = task.task;
    await runAction(() => cancelAgentTask(task.id));
    setComposerText(text);
    clearSelection();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onDecide = async (allow: boolean) => {
    if (!approval) return;
    setBusy(true);
    try {
      await decideApproval(approval.id, allow);
      setApproval(null);
      setDecidedNote(t.agent_decided);
      await refreshSelected();
      await refreshList();
    } catch (err) {
      setDetailError(friendlyAgentError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const awaiting = task && (task.status === "awaiting_approval" || task.status === "awaiting_confirmation");
  const live = task && (task.status === "running" || task.status === "paused_takeover");

  return (
    <div>
      {/* header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
            {t.tab_agent}
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t.agent_sub}</p>
        </div>
        <NotificationBell t={t} onOpenTask={selectTask} />
      </div>

      {/* composer */}
      <div className="mt-6">
        <TaskComposer
          t={t}
          value={composerText}
          onChange={setComposerText}
          onCreated={(created) => selectTask(created.id)}
        />
      </div>

      {/* tasks: list + detail */}
      <div className="mt-8 grid gap-6 md:grid-cols-[320px_1fr]">
        <section aria-label={t.agent_tasks}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            {t.agent_tasks}
          </h2>
          {!tasksLoaded ? (
            <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-stone-500 dark:text-stone-400">{t.agent_no_tasks}</p>
          ) : (
            <div className="space-y-3">
              {tasks.map((item) => (
                <TaskCard
                  key={item.id}
                  task={item}
                  t={t}
                  selected={item.id === selectedId}
                  onSelect={() => selectTask(item.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section aria-label={t.agent_report} className="min-w-0">
          {!selectedId || !task ? (
            <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center dark:border-stone-700">
              <p className="text-sm text-stone-500 dark:text-stone-400">{t.agent_select_task}</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" onClick={clearSelection} className="flex items-center gap-1 px-2">
                  <svg
                    className="h-4 w-4 rtl:rotate-180"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                  {t.agent_back}
                </Button>
                <StatusBadge status={task.status} t={t} />
                {task.kind === "scheduled" && (
                  <span className="rounded-full bg-stone-200 px-2.5 py-0.5 text-xs font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                    {t.agent_kind_scheduled}
                  </span>
                )}
              </div>
              <p className="text-lg font-medium text-stone-800 dark:text-stone-100">{task.task}</p>
              {detailError && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                  {detailError}
                </p>
              )}
              {decidedNote && (
                <p className="text-sm text-stone-500 dark:text-stone-400">{decidedNote}</p>
              )}

              {task.status === "planned" && (
                <PlanCard
                  task={task}
                  t={t}
                  busy={busy}
                  onApprove={onApprove}
                  onCancel={onCancel}
                  onEdit={onEdit}
                />
              )}

              {awaiting && (
                <div className="space-y-5">
                  {approval ? (
                    <ApprovalCard approval={approval} t={t} busy={busy} onDecide={onDecide} />
                  ) : (
                    <p className="text-sm text-stone-500 dark:text-stone-400">
                      {t.agent_waiting_approval}
                    </p>
                  )}
                  {task.plan && (
                    <PlanCard
                      task={task}
                      t={t}
                      busy={busy}
                      onApprove={onApprove}
                      onCancel={onCancel}
                      onEdit={onEdit}
                    />
                  )}
                </div>
              )}

              {live && (
                <div className="space-y-5">
                  <LiveView task={task} t={t} busy={busy} onTake={onTake} onRelease={onRelease} />
                  <StepTimeline steps={steps} message={progressMessage} t={t} />
                </div>
              )}

              {task.status === "done" && (
                <div className="space-y-5">
                  {task.reportMarkdown ? (
                    <div className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
                      <h2 className="mb-2 text-base font-semibold text-stone-800 dark:text-stone-100">
                        {t.agent_report}
                      </h2>
                      <MarkdownView markdown={task.reportMarkdown} />
                    </div>
                  ) : (
                    <p className="text-sm text-stone-500 dark:text-stone-400">{t.agent_st_done}</p>
                  )}
                  {task.screenshots.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-sm font-semibold text-stone-700 dark:text-stone-200">
                        {t.agent_screenshots}
                      </h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {task.screenshots.map((src, i) => (
                          <a key={i} href={absoluteUrl(src)} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={absoluteUrl(src)}
                              alt={`${t.agent_screenshots} ${i + 1}`}
                              className="aspect-video w-full rounded-xl border border-stone-200 object-cover dark:border-stone-800"
                              loading="lazy"
                            />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {task.resultFiles.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-sm font-semibold text-stone-700 dark:text-stone-200">
                        {t.agent_files}
                      </h3>
                      <ul className="space-y-2">
                        {task.resultFiles.map((f, i) => (
                          <li key={i}>
                            <a
                              href={f.url ? absoluteUrl(f.url) : "#"}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm text-clay-dark underline decoration-clay/40 underline-offset-2 hover:decoration-clay dark:text-clay"
                            >
                              {f.name || f.url || `${t.agent_files} ${i + 1}`}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {(task.status === "failed" || task.status === "limit_stopped") && (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/30">
                  <h2 className="text-base font-semibold text-red-800 dark:text-red-300">
                    {t.agent_error_label}
                  </h2>
                  <p className="mt-2 text-sm text-red-700 dark:text-red-400">
                    {task.error || t.agent_st_failed}
                  </p>
                </div>
              )}
              {task.status === "cancelled" && (
                <p className="text-sm text-stone-500 dark:text-stone-400">{t.agent_st_cancelled}</p>
              )}
            </div>
          )}
        </section>
      </div>

      {/* schedules */}
      <ScheduleManager t={t} tasks={tasks} onTasksChanged={() => void refreshList()} />
    </div>
  );
}
