"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ResearchJob } from "@genze/shared";
import { TabShell } from "../../components/TabShell";
import { ConsentGate } from "../../components/ConsentGate";
import { DocPanel, DocPanelFrame } from "../../components/DocPanel";
import { Button } from "../../components/Button";
import { useLang } from "../../lib/lang";
import { ApiClientError } from "../../lib/auth";
import { LIMIT_EXCEEDED } from "@genze/shared";
import { friendlyErrText } from "../../lib/usage";
import {
  cancelResearchJob,
  createResearchJob,
  getResearchJob,
  listResearchJobs,
  startResearchJob,
  subscribeResearchJob,
} from "../../lib/research";

const inputCls =
  "w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function statusBadge(status: ResearchJob["status"]): string {
  switch (status) {
    case "planned":
      return "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300";
    case "running":
      return "bg-clay-soft text-clay-dark dark:bg-stone-800 dark:text-clay";
    case "done":
      return "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300";
    default:
      return "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300";
  }
}

export default function ResearchPage() {
  const { lang, t } = useLang();
  const router = useRouter();

  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notSetup, setNotSetup] = useState(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const stopSubRef = useRef<(() => void) | null>(null);

  /** Gate errors: search not set up, consent needed, daily limit reached,
   *  or a plain API message. All shown inline. */
  function gateError(err: unknown): boolean {
    const code = err instanceof ApiClientError ? err.code : "UNKNOWN";
    if (code === "SEARCH_NOT_CONFIGURED") {
      setNotSetup(true);
      return true;
    }
    if (code === "CONSENT_REQUIRED") {
      router.push("/consent");
      return true;
    }
    if (code === LIMIT_EXCEEDED) {
      setError(friendlyErrText(lang, t, err));
      return true;
    }
    setError(err instanceof ApiClientError ? err.message : t.err_generic);
    return false;
  }

  function refreshJobs() {
    listResearchJobs()
      .then(setJobs)
      .catch(() => {
        /* the active job view carries its own errors */
      });
  }

  /* initial load: job list + deep link (?job= from the Library) */
  useEffect(() => {
    let cancelled = false;
    let initialJob: string | null = null;
    try {
      initialJob = new URLSearchParams(window.location.search).get("job");
    } catch {
      /* no URL access */
    }
    (async () => {
      try {
        const list = await listResearchJobs();
        if (cancelled) return;
        setJobs(list);
        if (initialJob && list.some((j) => j.id === initialJob)) {
          openJob(initialJob);
        }
      } catch (err) {
        if (!cancelled && !gateError(err)) setError(t.err_generic);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* keep the plan fresh while the background plan step runs */
  useEffect(() => {
    if (!job || job.status !== "planned" || job.plan) return;
    const timer = setInterval(async () => {
      try {
        const next = await getResearchJob(job.id);
        setJob(next);
      } catch {
        /* keep trying until the user leaves */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [job]);

  /* stop the SSE/poll subscription whenever the active job changes */
  useEffect(() => {
    return () => {
      stopSubRef.current?.();
      stopSubRef.current = null;
    };
  }, [activeId]);

  function openJob(id: string) {
    stopSubRef.current?.();
    stopSubRef.current = null;
    setReportOpen(false);
    setActiveId(id);
    setError("");
    setNotSetup(false);
    getResearchJob(id)
      .then((j) => {
        setJob(j);
        if (j.status === "running") watchJob(j.id);
        else if (j.status === "done") setReportOpen(true);
      })
      .catch((err) => {
        gateError(err);
      });
  }

  function watchJob(id: string) {
    stopSubRef.current?.();
    stopSubRef.current = subscribeResearchJob(id, {
      onProgress: (ev) =>
        setJob((prev) =>
          prev && prev.id === id
            ? { ...prev, status: "running", progress: { ...prev.progress, phase: ev.phase, done: ev.done, total: ev.total, message: ev.message } }
            : prev
        ),
      onTerminal: (done) => {
        setJob(done);
        refreshJobs();
        if (done.status === "done") setReportOpen(true);
      },
      onError: (err) => {
        gateError(err);
      },
    });
  }

  async function create() {
    const value = topic.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    setNotSetup(false);
    try {
      const created = await createResearchJob(value);
      setTopic("");
      setJobs((prev) => [created, ...prev]);
      setActiveId(created.id);
      setJob(created);
      setReportOpen(false);
    } catch (err) {
      gateError(err);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!job || starting) return;
    setStarting(true);
    setError("");
    try {
      const started = await startResearchJob(job.id);
      setJob(started);
      refreshJobs();
      watchJob(started.id);
    } catch (err) {
      gateError(err);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!job || stopping) return;
    setStopping(true);
    try {
      await cancelResearchJob(job.id);
      stopSubRef.current?.();
      stopSubRef.current = null;
      setJob(null);
      setActiveId(null);
      setReportOpen(false);
      refreshJobs();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setStopping(false);
    }
  }

  function backToList() {
    stopSubRef.current?.();
    stopSubRef.current = null;
    setActiveId(null);
    setJob(null);
    setReportOpen(false);
    setError("");
  }

  function phaseLabel(phase: string, message?: string): string {
    if (message) return message;
    switch (phase) {
      case "queued":
        return t.r_phase_queued;
      case "plan":
        return t.r_plan_title;
      case "search":
        return t.r_phase_search;
      case "fetch":
        return t.r_phase_fetch;
      case "synthesize":
        return t.r_phase_synthesize;
      default:
        return t.r_working;
    }
  }

  return (
    <TabShell wide>
      <ConsentGate>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
          {t.tab_research}
        </h1>

        <div className="mt-6 flex items-start gap-6">
          <div className="min-w-0 flex-1">
            {/* topic form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
              className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900"
            >
              <label
                htmlFor="research-topic"
                className="mb-2 block text-sm font-medium text-stone-700 dark:text-stone-200"
              >
                {t.r_topic_label}
              </label>
              <div className="flex gap-2">
                <input
                  id="research-topic"
                  value={topic}
                  maxLength={200}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder={t.r_topic_placeholder}
                  className={`${inputCls} min-w-0 flex-1`}
                />
                <Button type="submit" disabled={!topic.trim() || busy} className="shrink-0">
                  {busy ? t.s_loading : t.r_new}
                </Button>
              </div>
            </form>

            {notSetup && (
              <div className="mt-4 rounded-2xl border border-dashed border-stone-300 px-5 py-6 text-center dark:border-stone-700">
                <p className="text-sm text-stone-600 dark:text-stone-300">{t.r_not_setup}</p>
              </div>
            )}
            {error && <p className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}

            {/* active job: plan / progress / failed */}
            {job && (
              <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-stone-800 dark:text-stone-100">
                      {job.topic}
                    </p>
                    <span
                      className={`mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge(job.status)}`}
                    >
                      {job.status}
                    </span>
                  </div>
                  <button
                    onClick={backToList}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs text-stone-500 hover:bg-stone-200/60 dark:text-stone-400 dark:hover:bg-stone-800"
                  >
                    {t.r_back}
                  </button>
                </div>

                {job.status === "planned" && (
                  <div className="mt-4">
                    <h2 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                      {t.r_plan_title}
                    </h2>
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t.r_plan_sub}</p>
                    {!job.plan ? (
                      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
                        {t.r_plan_loading}
                      </p>
                    ) : (
                      <ol className="mt-3 space-y-2">
                        {job.plan.steps.map((step, i) => (
                          <li key={i} className="flex items-start gap-3 text-sm text-stone-700 dark:text-stone-200">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-clay-soft text-xs font-semibold text-clay-dark dark:bg-stone-800 dark:text-clay">
                              {i + 1}
                            </span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    <div className="mt-4 flex gap-2">
                      <Button onClick={start} disabled={starting || !job.plan}>
                        {starting ? t.s_loading : t.r_start_research}
                      </Button>
                      <Button variant="ghost" onClick={stop} disabled={stopping}>
                        {t.r_stop}
                      </Button>
                    </div>
                  </div>
                )}

                {job.status === "running" && (
                  <div className="mt-4">
                    <p className="text-sm font-medium text-stone-800 dark:text-stone-100">
                      {phaseLabel(job.progress.phase, job.progress.message)}
                    </p>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                      <div
                        className="h-full rounded-full bg-clay transition-all duration-500"
                        style={{
                          width: `${Math.min(100, Math.max(4, (job.progress.done / Math.max(1, job.progress.total)) * 100))}%`,
                        }}
                      />
                    </div>
                    <div className="mt-4">
                      <Button variant="ghost" onClick={stop} disabled={stopping}>
                        {stopping ? t.s_loading : t.r_stop}
                      </Button>
                    </div>
                  </div>
                )}

                {job.status === "done" && (
                  <div className="mt-4">
                    <p className="text-sm text-stone-600 dark:text-stone-300">{t.r_report_ready}</p>
                    <div className="mt-3">
                      <Button onClick={() => setReportOpen(true)}>{t.r_open_report}</Button>
                    </div>
                  </div>
                )}

                {(job.status === "failed" || job.status === "cancelled") && (
                  <div className="mt-4">
                    <p className="text-sm text-stone-600 dark:text-stone-300">
                      {job.status === "failed" ? t.r_failed : t.r_stop_confirm}
                    </p>
                    {job.error && (
                      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{job.error}</p>
                    )}
                    <div className="mt-3">
                      <Button variant="ghost" onClick={backToList}>
                        {t.r_try_again}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* past research */}
            {!job && (
              <div className="mt-8">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  {t.r_past}
                </h2>
                {loading ? (
                  <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
                ) : jobs.length === 0 ? (
                  <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t.r_no_jobs}</p>
                ) : (
                  <ul className="mt-3 space-y-2.5">
                    {jobs.map((j) => (
                      <li key={j.id}>
                        <button
                          onClick={() => openJob(j.id)}
                          className="flex w-full items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-start transition-colors hover:border-clay dark:border-stone-800 dark:bg-stone-900 dark:hover:border-clay"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-stone-800 dark:text-stone-100">
                              {j.topic}
                            </span>
                            <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">
                              {formatDate(j.updatedAt)}
                            </span>
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge(j.status)}`}
                          >
                            {j.status}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* report side panel */}
          {reportOpen && job && job.status === "done" && (
            <DocPanelFrame>
              <DocPanel
                mode="report"
                jobId={job.id}
                onClose={() => setReportOpen(false)}
                onNewJob={(next) => {
                  setJobs((prev) => [next, ...prev]);
                  openJob(next.id);
                }}
              />
            </DocPanelFrame>
          )}
        </div>
      </ConsentGate>
    </TabShell>
  );
}
