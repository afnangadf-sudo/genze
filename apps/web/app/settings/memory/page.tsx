"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserMemory } from "@genze/shared";
import { TabShell } from "../../../components/TabShell";
import { Button } from "../../../components/Button";
import { useLang } from "../../../lib/lang";
import { ApiClientError, getTokens } from "../../../lib/auth";
import {
  addMemory,
  deleteMemory,
  forgetAllMemories,
  listMemories,
  updateMemory,
} from "../../../lib/memory";

const inputCls =
  "w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export default function MemoryPage() {
  const router = useRouter();
  const { t } = useLang();

  const [loading, setLoading] = useState(true);
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [error, setError] = useState("");

  const [newContent, setNewContent] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [confirmingForget, setConfirmingForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  const errText = (err: unknown) =>
    err instanceof ApiClientError ? err.message : t.err_generic;

  useEffect(() => {
    if (!getTokens().access) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        setMemories(await listMemories());
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function add() {
    const content = newContent.trim();
    if (!content || adding) return;
    setAdding(true);
    setError("");
    try {
      const created = await addMemory(content.slice(0, 500));
      setMemories((prev) => [created, ...prev]);
      setNewContent("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setAdding(false);
    }
  }

  function beginEdit(m: UserMemory) {
    setEditingId(m.id);
    setEditContent(m.content);
  }

  async function saveEdit() {
    if (!editingId) return;
    const content = editContent.trim();
    if (!content) return;
    setError("");
    try {
      const updated = await updateMemory(editingId, content.slice(0, 500));
      setMemories((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      setEditingId(null);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    try {
      await deleteMemory(deletingId);
      setMemories((prev) => prev.filter((m) => m.id !== deletingId));
    } catch (err) {
      setError(errText(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function forgetEverything() {
    if (forgetting) return;
    setForgetting(true);
    setError("");
    try {
      await forgetAllMemories();
      setMemories([]);
      setConfirmingForget(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setForgetting(false);
    }
  }

  if (loading) {
    return (
      <TabShell>
        <p className="text-stone-500 dark:text-stone-400">{t.s_loading}</p>
      </TabShell>
    );
  }

  return (
    <TabShell>
      <button
        onClick={() => router.push("/settings")}
        className="mb-4 flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-stone-500 hover:bg-stone-200/60 dark:text-stone-400 dark:hover:bg-stone-800"
      >
        <svg
          className="h-4 w-4 rtl:rotate-180"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        {t.settings_title}
      </button>

      <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
        {t.m_title}
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-stone-500 dark:text-stone-400">
        {t.m_desc}
      </p>

      {error && <p className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}

      {/* add box */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="mt-6 flex gap-2"
      >
        <input
          value={newContent}
          maxLength={500}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder={t.m_add_placeholder}
          aria-label={t.m_add_placeholder}
          className={`${inputCls} min-w-0 flex-1`}
        />
        <Button type="submit" disabled={!newContent.trim() || adding} className="shrink-0">
          {adding ? t.s_loading : t.m_add}
        </Button>
      </form>

      {/* list */}
      <div className="mt-8">
        {memories.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.m_empty}</p>
        ) : (
          <ul className="space-y-2.5">
            {memories.map((m) =>
              deletingId === m.id ? (
                <li
                  key={m.id}
                  className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20"
                >
                  <p className="text-sm text-stone-700 dark:text-stone-200">
                    {t.lib_delete_confirm}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="danger"
                      className="px-3 py-1.5 text-xs"
                      onClick={confirmDelete}
                    >
                      {t.chat_delete_yes}
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-xs"
                      onClick={() => setDeletingId(null)}
                    >
                      {t.chat_cancel}
                    </Button>
                  </div>
                </li>
              ) : editingId === m.id ? (
                <li
                  key={m.id}
                  className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
                >
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className={`${inputCls} resize-y`}
                    aria-label={t.m_title}
                  />
                  <div className="flex gap-2">
                    <Button
                      className="px-3 py-1.5 text-xs"
                      onClick={saveEdit}
                      disabled={!editContent.trim()}
                    >
                      {t.m_save}
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-xs"
                      onClick={() => setEditingId(null)}
                    >
                      {t.chat_cancel}
                    </Button>
                  </div>
                </li>
              ) : (
                <li
                  key={m.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-stone-800 dark:text-stone-100">{m.content}</p>
                    <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                      {formatDate(m.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-xs"
                      onClick={() => beginEdit(m)}
                    >
                      {t.chat_rename}
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
                      onClick={() => setDeletingId(m.id)}
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

      {/* forget everything */}
      {memories.length > 0 && (
        <div className="mt-10">
          {!confirmingForget ? (
            <Button variant="danger" onClick={() => setConfirmingForget(true)}>
              {t.m_forget}
            </Button>
          ) : (
            <div className="max-w-sm rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
              <p className="text-sm text-stone-700 dark:text-stone-200">{t.m_forget_confirm}</p>
              <div className="mt-3 flex gap-2">
                <Button variant="danger" onClick={forgetEverything} disabled={forgetting}>
                  {forgetting ? t.s_loading : t.m_forget_yes}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingForget(false)}>
                  {t.s_cancel}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </TabShell>
  );
}
