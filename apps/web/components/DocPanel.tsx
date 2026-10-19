// DocPanel — the shared side panel for Step 4.
// mode "draft": editable title + content, revise bar, Save, fact-check
//   chips, export menu. Used by the Write tab.
// mode "report": read-only rendered report with clickable [n] citations,
//   numbered source list, refine input, export buttons, Copy APA/MLA.
//   Used by the Research tab.
// Responsive: the parent renders DocPanelFrame, which overlays the screen
// on mobile and sits side-by-side on desktop.

"use client";

import { useEffect, useState } from "react";
import type {
  ClaimVerdict,
  FactCheck,
  ResearchJob,
  ReviseAction,
  WriteDraft,
} from "@genze/shared";
import { ApiClientError } from "../lib/auth";
import { useLang } from "../lib/lang";
import { COMMON_LANGUAGES, LANGUAGE_NAMES } from "@genze/shared";
import { Button } from "./Button";
import { MarkdownView, SourceList } from "./MarkdownView";
import {
  createDraft,
  downloadDraftExport,
  getDraft,
  getFactCheck,
  reviseDraft,
  startFactCheck,
  updateDraft,
} from "../lib/write";
import {
  createResearchJob,
  downloadResearchExport,
  getCitations,
  getResearchJob,
} from "../lib/research";

export type DocPanelProps =
  | { mode: "draft"; draftId: string; onClose: () => void; onChanged?: () => void }
  | {
      mode: "report";
      jobId: string;
      onClose: () => void;
      /** A refine request created a follow-up job — let the parent open it. */
      onNewJob?: (job: ResearchJob) => void;
    };

/** Responsive frame: full-screen overlay on mobile, sticky side panel on desktop. */
export function DocPanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-white dark:bg-stone-950 md:sticky md:top-5 md:z-auto md:h-[calc(100dvh-7.5rem)] md:w-[27rem] md:shrink-0 md:rounded-2xl md:border md:border-stone-200 md:dark:border-stone-800">
      {children}
    </div>
  );
}

function PanelHeader({
  title,
  onClose,
  closeLabel,
  action,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3.5 dark:border-stone-800">
      <h2 className="truncate text-base font-semibold tracking-tight text-stone-800 dark:text-stone-100">
        {title}
      </h2>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        <button
          onClick={onClose}
          aria-label={closeLabel}
          className="rounded-lg p-2 text-stone-500 hover:bg-stone-200/60 dark:text-stone-400 dark:hover:bg-stone-800"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500";

/* ================= draft mode ================= */

const REVISE_ACTIONS: { action: ReviseAction; labelKey: "w_revise_shorter" | "w_revise_simpler" | "w_revise_formal" | "w_revise_ur" | "w_revise_en" }[] = [
  { action: "shorter", labelKey: "w_revise_shorter" },
  { action: "simpler", labelKey: "w_revise_simpler" },
  { action: "formal", labelKey: "w_revise_formal" },
  { action: "translate-ur", labelKey: "w_revise_ur" },
  { action: "translate-en", labelKey: "w_revise_en" },
];

const VERDICT_STYLE: Record<ClaimVerdict, string> = {
  supported:
    "border-green-200 bg-green-50 dark:border-green-900/60 dark:bg-green-950/30",
  disputed:
    "border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30",
  unverified:
    "border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900",
};

const VERDICT_DOT: Record<ClaimVerdict, string> = {
  supported: "bg-green-500",
  disputed: "bg-amber-500",
  unverified: "bg-stone-400",
};

/** Datalist options for the free-text "translate to any language" input. */
const TRANSLATE_LANG_OPTIONS: { code: string; name: string }[] = Object.entries({
  ...(LANGUAGE_NAMES as Record<string, string>),
  ...COMMON_LANGUAGES,
})
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

function DraftPanel({
  draftId,
  onClose,
  onChanged,
}: {
  draftId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t } = useLang();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<WriteDraft | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);

  // revise
  const [revising, setRevising] = useState<ReviseAction | null>(null);
  const [revised, setRevised] = useState<string | null>(null);
  const [reviseError, setReviseError] = useState("");
  // free-text "translate to any language" input
  const [translateLang, setTranslateLang] = useState("");

  // fact-check
  const [check, setCheck] = useState<FactCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");

  // export
  const [exporting, setExporting] = useState<string | null>(null);

  const dirty = draft !== null && (title !== draft.title || content !== draft.content);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDraft(draftId)
      .then((d) => {
        if (cancelled) return;
        setDraft(d);
        setTitle(d.title);
        setContent(d.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiClientError ? err.message : t.err_generic);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  /* poll a running fact-check every 2 s */
  useEffect(() => {
    if (!check || check.status === "done" || check.status === "failed" || check.status === "cancelled") {
      return;
    }
    const timer = setInterval(async () => {
      try {
        const next = await getFactCheck(check.id);
        setCheck(next);
        if (next.status === "done" || next.status === "failed" || next.status === "cancelled") {
          setChecking(false);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [check]);

  async function save() {
    if (!draft || saving || !dirty) return;
    setSaving(true);
    setSavedMsg(false);
    setError("");
    try {
      const updated = await updateDraft(draft.id, { title: title.trim() || draft.title, content });
      setDraft(updated);
      setTitle(updated.title);
      setContent(updated.content);
      setSavedMsg(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setSaving(false);
    }
  }

  async function doRevise(action: ReviseAction) {
    if (!draft || revising) return;
    setRevising(action);
    setRevised(null);
    setReviseError("");
    try {
      setRevised(await reviseDraft(draft.id, action));
    } catch (err) {
      setReviseError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setRevising(null);
    }
  }

  async function applyRevised(asCopy: boolean) {
    if (!draft || revised === null) return;
    setSaving(true);
    try {
      if (asCopy) {
        const copy = await createDraft({ template: draft.template, brief: `Copy of ${draft.title}` });
        const updated = await updateDraft(copy.id, {
          title: `${draft.title} (2)`,
          content: revised,
        });
        setDraft(updated);
        setTitle(updated.title);
        setContent(updated.content);
      } else {
        const updated = await updateDraft(draft.id, { content: revised });
        setDraft(updated);
        setContent(updated.content);
      }
      setRevised(null);
      setSavedMsg(true);
      onChanged?.();
    } catch (err) {
      setReviseError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setSaving(false);
    }
  }

  async function doFactCheck() {
    if (!draft || checking) return;
    setChecking(true);
    setCheckError("");
    setCheck(null);
    try {
      setCheck(await startFactCheck(draft.id));
    } catch (err) {
      setChecking(false);
      const code = err instanceof ApiClientError ? err.code : "UNKNOWN";
      setCheckError(code === "SEARCH_NOT_CONFIGURED" ? t.r_not_setup : err instanceof ApiClientError ? err.message : t.err_generic);
    }
  }

  async function doExport(format: "docx" | "pdf" | "xlsx" | "pptx") {
    if (!draft || exporting) return;
    setExporting(format);
    setError("");
    try {
      await downloadDraftExport(draft.id, format, `${draft.title || "draft"}.${format}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setExporting(null);
    }
  }

  const verdictLabel = (v: ClaimVerdict) =>
    v === "supported" ? t.w_claim_supported : v === "disputed" ? t.w_claim_disputed : t.w_claim_unverified;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t.doc_draft}
        onClose={onClose}
        closeLabel={t.w_close}
        action={
          <Button className="px-3 py-1.5 text-xs" onClick={save} disabled={!dirty || saving}>
            {saving ? t.s_loading : t.w_save}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : !draft ? (
          <p className="text-sm text-red-700 dark:text-red-400">{error || t.err_generic}</p>
        ) : (
          <div className="space-y-5">
            {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}

            <div>
              <label htmlFor="doc-title" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                {t.w_title}
              </label>
              <input
                id="doc-title"
                value={title}
                maxLength={120}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setSavedMsg(false);
                }}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="doc-content" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                {t.w_content}
              </label>
              <textarea
                id="doc-content"
                value={content}
                rows={16}
                onChange={(e) => {
                  setContent(e.target.value);
                  setSavedMsg(false);
                }}
                className={`${inputCls} min-h-[20rem] resize-y leading-relaxed`}
              />
              {savedMsg && !dirty && (
                <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">{t.w_saved}</p>
              )}
            </div>

            {/* revise bar */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                {t.w_revise}
              </p>
              <div className="flex flex-wrap gap-2">
                {REVISE_ACTIONS.map(({ action, labelKey }) => (
                  <button
                    key={action}
                    onClick={() => doRevise(action)}
                    disabled={revising !== null}
                    className="rounded-full border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-clay hover:text-clay-dark disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                  >
                    {revising === action ? t.w_revising : t[labelKey]}
                  </button>
                ))}
              </div>
              {/* translate to any language — free input, any BCP-47 code works */}
              <div className="mt-2 flex max-w-xs gap-2">
                <input
                  list="docpanel-translate-list"
                  value={translateLang}
                  disabled={revising !== null}
                  onChange={(e) => setTranslateLang(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const code = translateLang.trim().toLowerCase();
                      if (code) doRevise(`translate-${code}` as ReviseAction);
                    }
                  }}
                  placeholder={t.s_chat_language_ph}
                  autoComplete="off"
                  aria-label={t.w_translate_any}
                  className="w-full rounded-full border border-stone-300 bg-white px-3.5 py-1.5 text-xs text-stone-800 outline-none placeholder:text-stone-400 focus:border-clay disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
                />
                <datalist id="docpanel-translate-list">
                  {TRANSLATE_LANG_OPTIONS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.name}
                    </option>
                  ))}
                </datalist>
                <button
                  onClick={() => {
                    const code = translateLang.trim().toLowerCase();
                    if (code) doRevise(`translate-${code}` as ReviseAction);
                  }}
                  disabled={revising !== null || !translateLang.trim()}
                  className="shrink-0 rounded-full border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-clay hover:text-clay-dark disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                >
                  {t.w_translate_any}
                </button>
              </div>
              {reviseError && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400">{reviseError}</p>
              )}
              {revised !== null && (
                <div className="mt-3 rounded-xl border border-clay/40 bg-clay-soft/40 p-4 dark:bg-stone-800/60">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-200">
                    {revised}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button className="px-3 py-1.5 text-xs" onClick={() => applyRevised(false)} disabled={saving}>
                      {t.w_replace}
                    </Button>
                    <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => applyRevised(true)} disabled={saving}>
                      {t.w_save_copy}
                    </Button>
                    <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setRevised(null)}>
                      {t.w_discard}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* fact-check */}
            <div className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                  {t.w_claims}
                </h3>
                <Button
                  variant="ghost"
                  className="px-3 py-1.5 text-xs"
                  onClick={doFactCheck}
                  disabled={checking}
                >
                  {checking ? t.w_fact_checking : t.w_fact_check}
                </Button>
              </div>
              {checkError && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400">{checkError}</p>
              )}
              {check && check.status === "done" && (
                <ul className="mt-3 space-y-2.5">
                  {check.claims.length === 0 && (
                    <li className="text-sm text-stone-500 dark:text-stone-400">{t.lib_nothing_yet}</li>
                  )}
                  {check.claims.map((claim, i) => (
                    <li
                      key={i}
                      className={`rounded-lg border px-3.5 py-3 ${VERDICT_STYLE[claim.verdict]}`}
                    >
                      <p className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-200">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${VERDICT_DOT[claim.verdict]}`} aria-hidden />
                        <span>{claim.claim}</span>
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 ps-4">
                        <span className="text-xs font-medium uppercase tracking-wider text-stone-500 dark:text-stone-400">
                          {verdictLabel(claim.verdict)}
                        </span>
                        {claim.sources.map((s) => (
                          <a
                            key={s.n}
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-clay-dark underline decoration-clay/40 underline-offset-2 hover:decoration-clay dark:text-clay"
                          >
                            [{s.n}] {s.title}
                          </a>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {check && check.status === "failed" && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400">{t.w_fact_failed}</p>
              )}
            </div>

            {/* export */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                {t.w_export}
              </p>
              <div className="flex flex-wrap gap-2">
                {(["docx", "pdf", "xlsx", "pptx"] as const).map((format) => (
                  <button
                    key={format}
                    onClick={() => doExport(format)}
                    disabled={exporting !== null}
                    className="rounded-lg border border-stone-300 px-3.5 py-1.5 text-xs font-medium uppercase text-stone-600 transition-colors hover:border-clay hover:text-clay-dark disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                  >
                    {exporting === format ? t.s_loading : format.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= report mode ================= */

function ReportPanel({
  jobId,
  onClose,
  onNewJob,
}: {
  jobId: string;
  onClose: () => void;
  onNewJob?: (job: ResearchJob) => void;
}) {
  const { t } = useLang();
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState<string | null>(null);
  const [copied, setCopied] = useState<"apa" | "mla" | null>(null);
  const [refine, setRefine] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getResearchJob(jobId)
      .then((j) => {
        if (!cancelled) setJob(j);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiClientError ? err.message : t.err_generic);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  async function doExport(format: "pdf" | "docx" | "md") {
    if (!job || exporting) return;
    setExporting(format);
    setError("");
    try {
      const ext = format === "docx" ? "docx" : format;
      await downloadResearchExport(job.id, format, `${job.topic.slice(0, 60) || "report"}.${ext}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setExporting(null);
    }
  }

  async function copyCitations(style: "apa" | "mla") {
    if (!job) return;
    setCopied(null);
    try {
      const cites = await getCitations(job.id, style);
      await navigator.clipboard.writeText(cites.map((c) => c.text).join("\n"));
      setCopied(style);
      setTimeout(() => setCopied((cur) => (cur === style ? null : cur)), 2500);
    } catch {
      /* clipboard unavailable — stay silent */
    }
  }

  /** Refine starts a fresh research job carrying the refine instruction plus
   *  the original topic as context (the API has no in-place report revise). */
  async function doRefine() {
    const text = refine.trim();
    if (!job || !text || refining) return;
    setRefining(true);
    setRefineError("");
    try {
      const next = await createResearchJob(`${text}\n\nContext — original research topic: ${job.topic}`);
      setRefine("");
      onNewJob?.(next);
    } catch (err) {
      setRefineError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setRefining(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={t.doc_report} onClose={onClose} closeLabel={t.w_close} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : !job ? (
          <p className="text-sm text-red-700 dark:text-red-400">{error || t.err_generic}</p>
        ) : (
          <div className="space-y-5">
            <h3 className="text-lg font-semibold tracking-tight text-stone-800 dark:text-stone-100">
              {job.topic}
            </h3>
            {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
            {job.reportMarkdown ? (
              <MarkdownView markdown={job.reportMarkdown} />
            ) : (
              <p className="text-sm text-stone-500 dark:text-stone-400">{t.r_failed}</p>
            )}

            {job.sources.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                  {t.r_sources}
                </h4>
                <SourceList sources={job.sources} />
              </div>
            )}

            {/* export + citations */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
                {t.r_export}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => doExport("pdf")}
                  disabled={exporting !== null}
                  className="rounded-lg border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-clay hover:text-clay-dark disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                >
                  {exporting === "pdf" ? t.s_loading : "PDF"}
                </button>
                <button
                  onClick={() => doExport("docx")}
                  disabled={exporting !== null}
                  className="rounded-lg border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-clay hover:text-clay-dark disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                >
                  {exporting === "docx" ? t.s_loading : "Word"}
                </button>
                <button
                  onClick={() => doExport("md")}
                  disabled={exporting !== null}
                  className="rounded-lg border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-clay hover:text-clay-dark disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                >
                  {exporting === "md" ? t.s_loading : "Markdown"}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => copyCitations("apa")}
                  className="rounded-lg border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-clay hover:text-clay-dark dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                >
                  {copied === "apa" ? t.s_copied : t.r_copy_apa}
                </button>
                <button
                  onClick={() => copyCitations("mla")}
                  className="rounded-lg border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-clay hover:text-clay-dark dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                >
                  {copied === "mla" ? t.s_copied : t.r_copy_mla}
                </button>
              </div>
            </div>

            {/* refine */}
            <div>
              <label
                htmlFor="report-refine"
                className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500"
              >
                {t.r_refine_label}
              </label>
              <div className="flex gap-2">
                <input
                  id="report-refine"
                  value={refine}
                  onChange={(e) => setRefine(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doRefine();
                  }}
                  placeholder={t.r_refine_placeholder}
                  className={`${inputCls} min-w-0 flex-1`}
                />
                <Button className="shrink-0 px-3 py-2 text-xs" onClick={doRefine} disabled={!refine.trim() || refining}>
                  {refining ? t.s_loading : t.r_refine_btn}
                </Button>
              </div>
              {refineError && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400">{refineError}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= entry ================= */

export function DocPanel(props: DocPanelProps) {
  if (props.mode === "draft") {
    return (
      <DraftPanel draftId={props.draftId} onClose={props.onClose} onChanged={props.onChanged} />
    );
  }
  return (
    <ReportPanel jobId={props.jobId} onClose={props.onClose} onNewJob={props.onNewJob} />
  );
}
