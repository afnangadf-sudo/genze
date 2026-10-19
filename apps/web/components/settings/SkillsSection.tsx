"use client";

import { useEffect, useState } from "react";
import type { Skill } from "@genze/shared";
import {
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
  type SkillInput,
} from "../../lib/skills";
import { useLang, type Strings } from "../../lib/lang";
import { Button } from "../Button";
import { Field, fieldInputClass } from "../Field";

const EMPTY_FORM: SkillInput = { name: "", description: "", instructions: "", scripts: [] };

function SkillForm({
  initial,
  busy,
  submitLabel,
  t,
  onSubmit,
  onCancel,
}: {
  initial: SkillInput;
  busy: boolean;
  submitLabel: string;
  t: Strings;
  onSubmit: (input: SkillInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [scripts, setScripts] = useState(initial.scripts.join("\n"));
  const [error, setError] = useState("");

  function submit() {
    const input: SkillInput = {
      name: name.trim().slice(0, 80),
      description: description.trim().slice(0, 500),
      instructions: instructions.trim(),
      scripts: scripts
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };
    if (!input.name || !input.instructions) {
      setError(t.err_generic);
      return;
    }
    setError("");
    onSubmit(input);
  }

  return (
    <div className="max-w-lg space-y-4 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <Field id="skill-name" label={t.k_name} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={t.k_name_ph} />
      <Field
        id="skill-description"
        label={t.k_description}
        maxLength={500}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t.k_description_ph}
      />
      <label htmlFor="skill-instructions" className="block">
        <span className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300">
          {t.k_instructions}
        </span>
        <textarea
          id="skill-instructions"
          rows={5}
          maxLength={8000}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t.k_instructions_ph}
          className={fieldInputClass}
        />
      </label>
      <label htmlFor="skill-scripts" className="block">
        <span className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300">
          {t.k_scripts}
        </span>
        <textarea
          id="skill-scripts"
          rows={3}
          value={scripts}
          onChange={(e) => setScripts(e.target.value)}
          className={fieldInputClass}
        />
      </label>
      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={busy}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t.chat_cancel}
        </Button>
      </div>
    </div>
  );
}

function toInput(s: Skill): SkillInput {
  return {
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    scripts: s.scripts ?? [],
  };
}

export function SkillsSection() {
  const { t } = useLang();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [createSeed, setCreateSeed] = useState<SkillInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setFailed(false);
    try {
      setSkills(await listSkills());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    listSkills()
      .then((s) => {
        if (!cancelled) setSkills(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitCreate(input: SkillInput) {
    setMsg("");
    setBusy(true);
    try {
      const created = await createSkill(input);
      setSkills((prev) => [...prev, created]);
      setCreating(false);
      setCreateSeed(EMPTY_FORM);
      setMsg(t.k_saved);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(id: string, input: SkillInput) {
    setMsg("");
    setBusy(true);
    try {
      const updated = await updateSkill(id, input);
      setSkills((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setEditingId(null);
      setMsg(t.k_saved);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(id: string) {
    setMsg("");
    setBusy(true);
    try {
      await deleteSkill(id);
      setSkills((prev) => prev.filter((s) => s.id !== id));
      setDeletingId(null);
      setMsg(t.k_deleted);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  /** Built-ins are read-only templates: clone opens the create form pre-filled. */
  function cloneSkill(s: Skill) {
    setCreateSeed({ ...toInput(s), name: s.name });
    setEditingId(null);
    setDeletingId(null);
    setMsg(t.k_cloned);
    setCreating(true);
  }

  if (loading) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>;
  }
  if (failed) {
    return (
      <div>
        <p className="text-sm text-stone-500 dark:text-stone-400">{t.err_generic}</p>
        <div className="mt-3">
          <Button variant="ghost" onClick={reload}>
            {t.chat_retry}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="max-w-prose text-sm text-stone-500 dark:text-stone-400">{t.k_desc}</p>
      {msg && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{msg}</p>}

      <ul className="mt-4 space-y-3">
        {skills.map((s) => {
          const isEditing = editingId === s.id;
          const isDeleting = deletingId === s.id;
          return (
            <li
              key={s.id}
              className="rounded-xl border border-stone-200 p-4 dark:border-stone-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                      {s.name}
                    </h3>
                    {s.builtin && (
                      <span className="inline-block rounded-full bg-stone-200 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                        {t.k_builtin}
                      </span>
                    )}
                  </div>
                  {s.description && (
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                      {s.description}
                    </p>
                  )}
                </div>
                {!isEditing && !isDeleting && (
                  <div className="flex shrink-0 gap-1.5">
                    {s.builtin ? (
                      <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => cloneSkill(s)}>
                        {t.k_clone}
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-xs"
                          onClick={() => {
                            setEditingId(s.id);
                            setCreating(false);
                            setDeletingId(null);
                            setMsg("");
                          }}
                        >
                          {t.k_edit}
                        </Button>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-xs"
                          onClick={() => {
                            setDeletingId(s.id);
                            setEditingId(null);
                            setCreating(false);
                            setMsg("");
                          }}
                        >
                          {t.k_delete}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {isEditing && !s.builtin && (
                <div className="mt-3">
                  <SkillForm
                    initial={toInput(s)}
                    busy={busy}
                    submitLabel={t.w_save}
                    t={t}
                    onSubmit={(input) => submitEdit(s.id, input)}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              )}
              {isDeleting && !s.builtin && (
                <div className="mt-3 rounded-lg border border-red-200 p-3 dark:border-red-900/50">
                  <p className="text-sm text-stone-700 dark:text-stone-200">{t.k_delete_confirm}</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="danger"
                      className="px-3 py-1.5 text-xs"
                      disabled={busy}
                      onClick={() => confirmDelete(s.id)}
                    >
                      {t.k_delete_yes}
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-xs"
                      disabled={busy}
                      onClick={() => setDeletingId(null)}
                    >
                      {t.chat_cancel}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {skills.length === 0 && <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">{t.k_empty}</p>}

      <div className="mt-5">
        {!creating ? (
          <Button
            variant="ghost"
            onClick={() => {
              setCreating(true);
              setCreateSeed(EMPTY_FORM);
              setEditingId(null);
              setDeletingId(null);
              setMsg("");
            }}
          >
            {t.k_new}
          </Button>
        ) : (
          <SkillForm
            initial={createSeed}
            busy={busy}
            submitLabel={t.k_create}
            t={t}
            onSubmit={submitCreate}
            onCancel={() => setCreating(false)}
          />
        )}
      </div>
    </div>
  );
}
