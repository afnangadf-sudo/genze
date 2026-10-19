"use client";

import { useEffect, useState } from "react";
import type { Gem } from "@genze/shared";
import {
  createGem,
  deleteGem,
  listGems,
  revokeGemShare,
  shareGem,
  updateGem,
  type GemInput,
} from "../../lib/gems";
import { useLang, type Strings } from "../../lib/lang";
import { Button } from "../Button";
import { Field, fieldInputClass } from "../Field";

const MAX_STARTERS = 4;

const EMPTY_FORM: GemInput = {
  name: "",
  description: "",
  instructions: "",
  starterPrompts: [],
  modelPreference: null,
};

function toInput(g: Gem): GemInput {
  return {
    name: g.name,
    description: g.description,
    instructions: g.instructions,
    starterPrompts: g.starterPrompts ?? [],
    modelPreference: g.modelPreference,
  };
}

function GemForm({
  initial,
  busy,
  submitLabel,
  t,
  onSubmit,
  onCancel,
}: {
  initial: GemInput;
  busy: boolean;
  submitLabel: string;
  t: Strings;
  onSubmit: (input: GemInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [starters, setStarters] = useState(initial.starterPrompts.join("\n"));
  const [modelPreference, setModelPreference] = useState(initial.modelPreference ?? "");
  const [error, setError] = useState("");

  function submit() {
    const input: GemInput = {
      name: name.trim().slice(0, 80),
      description: description.trim().slice(0, 500),
      instructions: instructions.trim(),
      starterPrompts: starters
        .split("\n")
        .map((s) => s.trim().slice(0, 200))
        .filter((s) => s.length > 0)
        .slice(0, MAX_STARTERS),
      modelPreference: modelPreference.trim() ? modelPreference.trim() : null,
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
      <Field
        id="gem-name"
        label={t.gm_name}
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t.gm_name_ph}
      />
      <Field
        id="gem-description"
        label={t.gm_description}
        maxLength={500}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t.gm_description_ph}
      />
      <label htmlFor="gem-instructions" className="block">
        <span className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300">
          {t.gm_instructions}
        </span>
        <textarea
          id="gem-instructions"
          rows={5}
          maxLength={8000}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t.gm_instructions_ph}
          className={fieldInputClass}
        />
      </label>
      <label htmlFor="gem-starters" className="block">
        <span className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300">
          {t.gm_starters}
        </span>
        <textarea
          id="gem-starters"
          rows={3}
          value={starters}
          onChange={(e) => setStarters(e.target.value)}
          className={fieldInputClass}
        />
      </label>
      <div>
        <Field
          id="gem-model-preference"
          label={t.gm_model_pref}
          value={modelPreference}
          onChange={(e) => setModelPreference(e.target.value)}
        />
        <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
          {t.gm_model_pref_hint}
        </p>
      </div>
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

function Badge({ label }: { label: string }) {
  return (
    <span className="inline-block rounded-full bg-stone-200 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-stone-600 dark:bg-stone-700 dark:text-stone-300">
      {label}
    </span>
  );
}

export function GemsSection() {
  const { t } = useLang();
  const [gems, setGems] = useState<Gem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listGems()
      .then((g) => {
        if (!cancelled) setGems(g);
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

  async function reload() {
    setLoading(true);
    setFailed(false);
    try {
      setGems(await listGems());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  function resetEditing() {
    setCreating(false);
    setEditingId(null);
    setDeletingId(null);
    setSharingId(null);
    setShareLink("");
    setCopied(false);
  }

  async function submitCreate(input: GemInput) {
    setMsg("");
    setBusy(true);
    try {
      const created = await createGem(input);
      // The list comes back built-ins first — just reload to keep the order.
      setGems(await listGems());
      setCreating(false);
      setMsg(t.k_saved);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(id: string, input: GemInput) {
    setMsg("");
    setBusy(true);
    try {
      const updated = await updateGem(id, input);
      setGems((prev) => prev.map((g) => (g.id === id ? updated : g)));
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
      await deleteGem(id);
      setGems((prev) => prev.filter((g) => g.id !== id));
      setDeletingId(null);
      setMsg(t.k_deleted);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  /** "Make a copy" — clones via POST /gems with the same fields (works for
   *  built-ins and for own gems; attached skills/files are the owner's and
   *  are not copied). */
  async function makeCopy(g: Gem) {
    setMsg("");
    setBusy(true);
    try {
      const created = await createGem({
        ...toInput(g),
        name: g.name,
      });
      setGems(await listGems());
      setMsg(t.gm_copied);
      setEditingId(created.id);
      setCreating(false);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  async function openShare(g: Gem) {
    resetEditing();
    setMsg("");
    setSharingId(g.id);
    setShareLink(g.shareUrl ?? "");
    if (!g.shareUrl) {
      setShareBusy(true);
      try {
        const url = await shareGem(g.id);
        setShareLink(url);
        setGems((prev) => prev.map((x) => (x.id === g.id ? { ...x, shareUrl: url } : x)));
      } catch {
        setMsg(t.err_generic);
        setSharingId(null);
      } finally {
        setShareBusy(false);
      }
    }
  }

  async function revokeShare(g: Gem) {
    setMsg("");
    setShareBusy(true);
    try {
      await revokeGemShare(g.id);
      setGems((prev) => prev.map((x) => (x.id === g.id ? { ...x, shareUrl: null } : x)));
      setShareLink("");
      setMsg(t.gm_revoked);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setShareBusy(false);
    }
  }

  async function copyLink() {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the link is selectable above */
    }
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
      <p className="max-w-prose text-sm text-stone-500 dark:text-stone-400">{t.gm_desc}</p>
      {msg && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{msg}</p>}

      <ul className="mt-4 space-y-3">
        {gems.map((g) => {
          const isEditing = editingId === g.id;
          const isDeleting = deletingId === g.id;
          const isSharing = sharingId === g.id;
          const showActions = !isEditing && !isDeleting && !isSharing;
          return (
            <li
              key={g.id}
              className="rounded-xl border border-stone-200 p-4 dark:border-stone-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                      {g.name}
                    </h3>
                    {g.builtin && <Badge label={t.k_builtin} />}
                    {!g.builtin && g.copiedFrom && <Badge label={t.gm_shared_with_you} />}
                  </div>
                  {g.description && (
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                      {g.description}
                    </p>
                  )}
                </div>
                {showActions && (
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {g.builtin ? (
                      <Button
                        variant="ghost"
                        className="px-3 py-1.5 text-xs"
                        disabled={busy}
                        onClick={() => makeCopy(g)}
                      >
                        {t.gm_copy}
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-xs"
                          onClick={() => {
                            resetEditing();
                            setEditingId(g.id);
                            setMsg("");
                          }}
                        >
                          {t.k_edit}
                        </Button>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-xs"
                          disabled={busy}
                          onClick={() => makeCopy(g)}
                        >
                          {t.gm_copy}
                        </Button>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-xs"
                          disabled={busy}
                          onClick={() => openShare(g)}
                        >
                          {t.gm_share}
                        </Button>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-xs"
                          onClick={() => {
                            resetEditing();
                            setDeletingId(g.id);
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

              {isEditing && !g.builtin && (
                <div className="mt-3">
                  <GemForm
                    initial={toInput(g)}
                    busy={busy}
                    submitLabel={t.k_saved}
                    t={t}
                    onSubmit={(input) => submitEdit(g.id, input)}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              )}

              {isSharing && !g.builtin && (
                <div className="mt-3 rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                  <p className="text-sm font-medium text-stone-700 dark:text-stone-200">
                    {t.gm_share_title}
                  </p>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    {t.gm_share_hint}
                  </p>
                  {shareBusy ? (
                    <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
                      {t.s_loading}
                    </p>
                  ) : (
                    shareLink && (
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <input
                          readOnly
                          value={shareLink}
                          onFocus={(e) => e.target.select()}
                          aria-label={t.gm_share_title}
                          dir="ltr"
                          className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
                        />
                        <div className="flex shrink-0 gap-2">
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={copyLink}
                          >
                            {copied ? t.gm_link_copied : t.gm_copy_link}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            disabled={shareBusy}
                            onClick={() => revokeShare(g)}
                          >
                            {t.gm_revoke}
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-xs"
                            onClick={() => setSharingId(null)}
                          >
                            {t.chat_cancel}
                          </Button>
                        </div>
                      </div>
                    )
                  )}
                </div>
              )}

              {isDeleting && !g.builtin && (
                <div className="mt-3 rounded-lg border border-red-200 p-3 dark:border-red-900/50">
                  <p className="text-sm text-stone-700 dark:text-stone-200">
                    {t.gm_delete_confirm}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="danger"
                      className="px-3 py-1.5 text-xs"
                      disabled={busy}
                      onClick={() => confirmDelete(g.id)}
                    >
                      {t.gm_delete_yes}
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

      {gems.length === 0 && (
        <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">{t.gm_empty}</p>
      )}

      <div className="mt-5">
        {!creating ? (
          <Button
            variant="ghost"
            onClick={() => {
              resetEditing();
              setCreating(true);
              setMsg("");
            }}
          >
            {t.gm_new}
          </Button>
        ) : (
          <GemForm
            initial={EMPTY_FORM}
            busy={busy}
            submitLabel={t.gm_create}
            t={t}
            onSubmit={submitCreate}
            onCancel={() => setCreating(false)}
          />
        )}
      </div>
    </div>
  );
}
