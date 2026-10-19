"use client";

import { useEffect, useState } from "react";
import type { Project, WriteDraft, WriteTemplate, WritingStyle } from "@genze/shared";
import { TabShell } from "../../components/TabShell";
import { ConsentGate } from "../../components/ConsentGate";
import { DocPanel, DocPanelFrame } from "../../components/DocPanel";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { ProjectSkillsEditor } from "../../components/settings/ProjectSkillsEditor";
import { useLang } from "../../lib/lang";
import { ApiClientError } from "../../lib/auth";
import { friendlyErrText } from "../../lib/usage";
import { listProjects, updateProject } from "../../lib/projects";
import {
  createDraft,
  createStyle,
  deleteDraft,
  deleteStyle,
  listDrafts,
  listStyles,
  updateStyle,
} from "../../lib/write";

const inputCls =
  "w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500";

const TEMPLATES: { template: WriteTemplate; titleKey: "w_t_article" | "w_t_essay" | "w_t_summary" | "w_t_youtube" | "w_t_podcast" | "w_t_email"; descKey: "w_d_article" | "w_d_essay" | "w_d_summary" | "w_d_youtube" | "w_d_podcast" | "w_d_email" }[] = [
  { template: "article", titleKey: "w_t_article", descKey: "w_d_article" },
  { template: "essay", titleKey: "w_t_essay", descKey: "w_d_essay" },
  { template: "summary", titleKey: "w_t_summary", descKey: "w_d_summary" },
  { template: "youtube-script", titleKey: "w_t_youtube", descKey: "w_d_youtube" },
  { template: "podcast-outline", titleKey: "w_t_podcast", descKey: "w_d_podcast" },
  { template: "email", titleKey: "w_t_email", descKey: "w_d_email" },
];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export default function WritePage() {
  const { lang, t } = useLang();

  const [drafts, setDrafts] = useState<WriteDraft[]>([]);
  const [loading, setLoading] = useState(true);

  // template + brief form
  const [template, setTemplate] = useState<WriteTemplate | null>(null);
  const [brief, setBrief] = useState("");
  const [projectId, setProjectId] = useState("");
  const [styleId, setStyleId] = useState("");
  const [generating, setGenerating] = useState(false);

  // side panel
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);

  // styles manager
  const [styles, setStyles] = useState<WritingStyle[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [newStyleName, setNewStyleName] = useState("");
  const [newStyleDesc, setNewStyleDesc] = useState("");
  const [addingStyle, setAddingStyle] = useState(false);
  const [editingStyleId, setEditingStyleId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [deletingStyleId, setDeletingStyleId] = useState<string | null>(null);

  // per-project default style
  const [styleProjectId, setStyleProjectId] = useState("");
  const [styleProjectStyle, setStyleProjectStyle] = useState("");
  const [savingProjectStyle, setSavingProjectStyle] = useState(false);
  const [projectStyleSaved, setProjectStyleSaved] = useState(false);

  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  /** API errors keep the server's plain-language message; a 429
   *  LIMIT_EXCEEDED becomes the friendly "your daily limit" line with the
   *  reset time. Shown inline, never a pop-up. */
  const errText = (err: unknown) => friendlyErrText(lang, t, err);

  function refreshDrafts() {
    listDrafts()
      .then(setDrafts)
      .catch((err) => setError(errText(err)));
  }

  useEffect(() => {
    (async () => {
      try {
        const [ds, ss, ps] = await Promise.all([listDrafts(), listStyles(), listProjects()]);
        setDrafts(ds);
        setStyles(ss);
        setProjects(ps);
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    const value = brief.trim();
    if (!template || !value || generating) return;
    setGenerating(true);
    setError("");
    try {
      const draft = await createDraft({
        template,
        brief: value,
        projectId: projectId || undefined,
        styleId: styleId || undefined,
      });
      setDrafts((prev) => [draft, ...prev]);
      setBrief("");
      setTemplate(null);
      setOpenDraftId(draft.id);
    } catch (err) {
      const code = err instanceof ApiClientError ? err.code : "UNKNOWN";
      if (code === "CONSENT_REQUIRED") {
        window.location.href = "/consent";
        return;
      }
      setError(errText(err));
    } finally {
      setGenerating(false);
    }
  }

  async function confirmDeleteDraft() {
    if (!deleteId) return;
    try {
      await deleteDraft(deleteId);
      setDrafts((prev) => prev.filter((d) => d.id !== deleteId));
      if (openDraftId === deleteId) setOpenDraftId(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setDeleteId(null);
    }
  }

  /* ---------- styles ---------- */

  async function addStyle() {
    const name = newStyleName.trim();
    const desc = newStyleDesc.trim();
    if (!name || !desc || addingStyle) return;
    setAddingStyle(true);
    try {
      const created = await createStyle(name, desc);
      setStyles((prev) => [...prev, created]);
      setNewStyleName("");
      setNewStyleDesc("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setAddingStyle(false);
    }
  }

  function beginEditStyle(s: WritingStyle) {
    setEditingStyleId(s.id);
    setEditName(s.name);
    setEditDesc(s.description);
  }

  async function saveEditStyle() {
    if (!editingStyleId) return;
    const name = editName.trim();
    const desc = editDesc.trim();
    if (!name || !desc) return;
    try {
      const updated = await updateStyle(editingStyleId, { name, description: desc });
      setStyles((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditingStyleId(null);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function confirmDeleteStyle() {
    if (!deletingStyleId) return;
    try {
      await deleteStyle(deletingStyleId);
      setStyles((prev) => prev.filter((s) => s.id !== deletingStyleId));
    } catch (err) {
      setError(errText(err));
    } finally {
      setDeletingStyleId(null);
    }
  }

  /* per-project default style */
  useEffect(() => {
    const p = projects.find((x) => x.id === styleProjectId);
    setStyleProjectStyle(p?.defaultStyleId ?? "");
    setProjectStyleSaved(false);
  }, [styleProjectId, projects]);

  async function saveProjectStyle() {
    if (!styleProjectId || savingProjectStyle) return;
    setSavingProjectStyle(true);
    try {
      const updated = await updateProject(styleProjectId, {
        defaultStyleId: styleProjectStyle || null,
      });
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setProjectStyleSaved(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSavingProjectStyle(false);
    }
  }

  return (
    <TabShell wide>
      <ConsentGate>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
          {t.tab_write}
        </h1>

        <div className="mt-6 flex items-start gap-6">
          <div className="min-w-0 flex-1">
            {/* template cards */}
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
              {t.w_choose}
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {TEMPLATES.map(({ template: tpl, titleKey, descKey }) => (
                <button
                  key={tpl}
                  onClick={() => setTemplate(template === tpl ? null : tpl)}
                  aria-pressed={template === tpl}
                  className={`rounded-2xl border p-4 text-start transition-colors ${
                    template === tpl
                      ? "border-clay bg-clay-soft/50 dark:bg-stone-800"
                      : "border-stone-200 bg-white hover:border-clay/60 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-clay/60"
                  }`}
                >
                  <p className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                    {t[titleKey]}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
                    {t[descKey]}
                  </p>
                </button>
              ))}
            </div>

            {/* guided brief form */}
            {template && (
              <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
                <label
                  htmlFor="write-brief"
                  className="mb-2 block text-sm font-medium text-stone-700 dark:text-stone-200"
                >
                  {t.w_brief_label}
                </label>
                <textarea
                  id="write-brief"
                  rows={4}
                  maxLength={2000}
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder={t.w_brief_placeholder}
                  className={`${inputCls} resize-y`}
                />
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="write-project"
                      className="mb-1 block text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500"
                    >
                      {t.w_project}
                    </label>
                    <select
                      id="write-project"
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">{t.w_pick_project}</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="write-style"
                      className="mb-1 block text-xs font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500"
                    >
                      {t.w_style}
                    </label>
                    <select
                      id="write-style"
                      value={styleId}
                      onChange={(e) => setStyleId(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">{t.w_pick_style}</option>
                      {styles.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="mt-4">
                  <Button onClick={generate} disabled={!brief.trim() || generating}>
                    {generating ? t.w_generating : t.w_generate}
                  </Button>
                </div>
              </div>
            )}

            {error && <p className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}

            {/* drafts */}
            <div className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                {t.w_drafts}
              </h2>
              {loading ? (
                <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
              ) : drafts.length === 0 ? (
                <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t.w_no_drafts}</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {drafts.map((d) =>
                    deleteId === d.id ? (
                      <li
                        key={d.id}
                        className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20"
                      >
                        <p className="text-sm text-stone-700 dark:text-stone-200">
                          {t.lib_delete_confirm}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button
                            variant="danger"
                            className="px-3 py-1.5 text-xs"
                            onClick={confirmDeleteDraft}
                          >
                            {t.chat_delete_yes}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => setDeleteId(null)}
                          >
                            {t.chat_cancel}
                          </Button>
                        </div>
                      </li>
                    ) : (
                      <li
                        key={d.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900"
                      >
                        <button
                          onClick={() => setOpenDraftId(d.id)}
                          className="min-w-0 flex-1 text-start"
                        >
                          <span className="block truncate text-sm font-medium text-stone-800 dark:text-stone-100">
                            {d.title}
                          </span>
                          <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">
                            {formatDate(d.updatedAt)}
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => setOpenDraftId(d.id)}
                          >
                            {t.w_open}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
                            onClick={() => setDeleteId(d.id)}
                          >
                            {t.chat_delete}
                          </Button>
                        </div>
                      </li>
                    )
                  )}
                </ul>
              )}
            </div>

            {/* styles manager */}
            <div className="mt-10">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                {t.w_styles}
              </h2>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t.w_styles_desc}</p>

              {styles.length === 0 ? (
                <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t.w_style_empty}</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {styles.map((s) =>
                    editingStyleId === s.id ? (
                      <li
                        key={s.id}
                        className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
                      >
                        <Field
                          id={`style-name-${s.id}`}
                          label={t.w_style_name}
                          value={editName}
                          maxLength={60}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                        <div>
                          <label
                            htmlFor={`style-desc-${s.id}`}
                            className="mb-1 block text-sm text-stone-600 dark:text-stone-300"
                          >
                            {t.w_style_desc}
                          </label>
                          <textarea
                            id={`style-desc-${s.id}`}
                            rows={2}
                            maxLength={2000}
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            className={`${inputCls} resize-y`}
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            className="px-3 py-1.5 text-xs"
                            onClick={saveEditStyle}
                            disabled={!editName.trim() || !editDesc.trim()}
                          >
                            {t.m_save}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => setEditingStyleId(null)}
                          >
                            {t.chat_cancel}
                          </Button>
                        </div>
                      </li>
                    ) : deletingStyleId === s.id ? (
                      <li
                        key={s.id}
                        className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20"
                      >
                        <p className="text-sm text-stone-700 dark:text-stone-200">
                          {t.lib_delete_confirm}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button
                            variant="danger"
                            className="px-3 py-1.5 text-xs"
                            onClick={confirmDeleteStyle}
                          >
                            {t.chat_delete_yes}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => setDeletingStyleId(null)}
                          >
                            {t.chat_cancel}
                          </Button>
                        </div>
                      </li>
                    ) : (
                      <li
                        key={s.id}
                        className="flex items-start justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-stone-800 dark:text-stone-100">
                            {s.name}
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-xs text-stone-500 dark:text-stone-400">
                            {s.description}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => beginEditStyle(s)}
                          >
                            {t.chat_rename}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
                            onClick={() => setDeletingStyleId(s.id)}
                          >
                            {t.chat_delete}
                          </Button>
                        </div>
                      </li>
                    )
                  )}
                </ul>
              )}

              {/* add a style */}
              <div className="mt-4 space-y-3 rounded-xl border border-dashed border-stone-300 p-4 dark:border-stone-700">
                <Field
                  id="style-new-name"
                  label={t.w_style_name}
                  value={newStyleName}
                  maxLength={60}
                  onChange={(e) => setNewStyleName(e.target.value)}
                />
                <div>
                  <label
                    htmlFor="style-new-desc"
                    className="mb-1 block text-sm text-stone-600 dark:text-stone-300"
                  >
                    {t.w_style_desc}
                  </label>
                  <textarea
                    id="style-new-desc"
                    rows={2}
                    maxLength={2000}
                    value={newStyleDesc}
                    onChange={(e) => setNewStyleDesc(e.target.value)}
                    className={`${inputCls} resize-y`}
                  />
                </div>
                <Button
                  variant="ghost"
                  onClick={addStyle}
                  disabled={!newStyleName.trim() || !newStyleDesc.trim() || addingStyle}
                >
                  {addingStyle ? t.s_loading : t.w_style_add}
                </Button>
              </div>

              {/* per-project default style */}
              <div className="mt-6 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                  {t.w_project_style}
                </h3>
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                  {t.w_project_style_desc}
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <select
                    aria-label={t.w_project}
                    value={styleProjectId}
                    onChange={(e) => setStyleProjectId(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">{t.w_pick_project}</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t.w_style}
                    value={styleProjectStyle}
                    onChange={(e) => {
                      setStyleProjectStyle(e.target.value);
                      setProjectStyleSaved(false);
                    }}
                    disabled={!styleProjectId}
                    className={inputCls}
                  >
                    <option value="">{t.w_pick_style}</option>
                    {styles.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                {styleProjectId && (
                  <div className="mt-3 flex items-center gap-3">
                    <Button
                      className="px-3 py-1.5 text-xs"
                      onClick={saveProjectStyle}
                      disabled={savingProjectStyle}
                    >
                      {savingProjectStyle ? t.s_loading : t.w_save}
                    </Button>
                    {projectStyleSaved && (
                      <p className="text-xs text-stone-500 dark:text-stone-400">{t.w_saved}</p>
                    )}
                  </div>
                )}
                {/* attach skills to the same project */}
                {styleProjectId && (
                  <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-800">
                    <ProjectSkillsEditor projectId={styleProjectId} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* draft side panel */}
          {openDraftId && (
            <DocPanelFrame>
              <DocPanel
                mode="draft"
                draftId={openDraftId}
                onClose={() => setOpenDraftId(null)}
                onChanged={refreshDrafts}
              />
            </DocPanelFrame>
          )}
        </div>
      </ConsentGate>
    </TabShell>
  );
}
