"use client";

import { useEffect, useRef, useState } from "react";
import type { LibraryGroup, LibraryItem, LibraryItemType } from "@genze/shared";
import { TabShell } from "../../components/TabShell";
import { ConsentGate } from "../../components/ConsentGate";
import { useLang } from "../../lib/lang";
import { ApiClientError } from "../../lib/auth";
import { friendlyErrText } from "../../lib/usage";
import { Button } from "../../components/Button";
import { deleteLibraryItem, searchLibrary } from "../../lib/library";
import { downloadUrl } from "../../lib/files";

const GROUP_ORDER: LibraryItemType[] = [
  "project",
  "chat",
  "file",
  "report",
  "video",
  "agent-task",
];

const STUB_GROUPS: LibraryItemType[] = ["video", "agent-task"];

function ItemRow({
  item,
  type,
  onDeleted,
  error,
}: {
  item: LibraryItem;
  type: LibraryItemType;
  onDeleted: (id: string) => void;
  error: (err: unknown) => string;
}) {
  const { t } = useLang();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function doDelete() {
    setBusy(true);
    setDeleteError("");
    try {
      await deleteLibraryItem(type, item.id);
      onDeleted(item.id);
    } catch (err) {
      setDeleteError(error(err));
    } finally {
      setBusy(false);
    }
  }

  async function openFile() {
    try {
      window.open(await downloadUrl(item.id), "_blank", "noopener,noreferrer");
    } catch (err) {
      setDeleteError(error(err));
    }
  }

  const date = new Date(item.updatedAt).toLocaleDateString();

  return (
    <li className="rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-700 dark:bg-stone-900">
      {confirming ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/20">
          <p className="text-sm text-stone-700 dark:text-stone-200">{t.lib_delete_confirm}</p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="danger"
              className="px-3 py-1.5 text-xs"
              onClick={doDelete}
              disabled={busy}
            >
              {t.chat_delete_yes}
            </Button>
            <Button
              variant="ghost"
              className="px-3 py-1.5 text-xs"
              onClick={() => setConfirming(false)}
            >
              {t.chat_cancel}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">
                {item.title}
              </p>
              <p className="mt-0.5 line-clamp-2 text-xs text-stone-500 dark:text-stone-400">
                {item.snippet ?? date}
                {item.snippet && <span className="text-stone-400 dark:text-stone-500"> · {date}</span>}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {type === "file" && (
                <>
                  <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={openFile}>
                    {t.lib_open}
                  </Button>
                  <FileDownloadButton
                    id={item.id}
                    label={t.lib_download}
                    filename={item.title}
                    onError={(err) => setDeleteError(error(err))}
                  />
                </>
              )}
              {type === "report" && (
                <a
                  href={`/research?job=${item.id}`}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200/60 dark:text-stone-300 dark:hover:bg-stone-800"
                >
                  {t.lib_open}
                </a>
              )}
              <Button
                variant="ghost"
                className="px-3 py-1.5 text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
                onClick={() => setConfirming(true)}
              >
                {t.lib_delete}
              </Button>
            </div>
          </div>
          {deleteError && (
            <p className="mt-2 text-sm text-red-700 dark:text-red-400">{deleteError}</p>
          )}
        </>
      )}
    </li>
  );
}

function FileDownloadButton({
  id,
  label,
  filename,
  onError,
}: {
  id: string;
  label: string;
  filename: string;
  onError: (err: unknown) => void;
}) {
  const [href, setHref] = useState<string | null>(null);
  const anchorRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (href && anchorRef.current) anchorRef.current.click();
  }, [href]);

  async function prepare() {
    try {
      setHref(await downloadUrl(id));
    } catch (err) {
      onError(err);
    }
  }

  if (href) {
    return (
      <a
        ref={anchorRef}
        href={href}
        download={filename}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200/60 dark:text-stone-300 dark:hover:bg-stone-800"
      >
        {label}
      </a>
    );
  }
  return (
    <button
      onClick={prepare}
      className="rounded-lg px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200/60 dark:text-stone-300 dark:hover:bg-stone-800"
    >
      {label}
    </button>
  );
}

export default function LibraryPage() {
  const { lang, t } = useLang();
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<LibraryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const errText = (err: unknown) => friendlyErrText(lang, t, err);

  /* debounced search */
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const res = await searchLibrary(query.trim() ? query.trim() : undefined);
        if (!cancelled) setGroups(res.groups);
      } catch (err) {
        if (!cancelled) setError(errText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const groupTitle = (type: LibraryItemType): string => {
    switch (type) {
      case "project":
        return t.lib_group_project;
      case "chat":
        return t.lib_group_chat;
      case "file":
        return t.lib_group_file;
      case "report":
        return t.lib_group_report;
      case "video":
        return t.lib_group_video;
      case "agent-task":
        return t.lib_group_agent_task;
      default: {
        // "image" | "audio" groups aren't rendered by this tab yet
        // (GROUP_ORDER/STUB_GROUPS don't include them); fall back to the raw
        // type name so noImplicitReturns is satisfied.
        const _unrendered: "image" | "audio" = type;
        return _unrendered;
      }
    }
  };

  const ordered = GROUP_ORDER.map((type) => ({
    type,
    items: groups.find((g) => g.type === type)?.items ?? [],
  }));

  function handleDeleted(type: LibraryItemType, id: string) {
    setGroups((prev) =>
      prev.map((g) => (g.type === type ? { ...g, items: g.items.filter((i) => i.id !== id) } : g))
    );
  }

  return (
    <TabShell>
      <ConsentGate>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
          {t.tab_library}
        </h1>

        <div className="mt-4">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.lib_search_placeholder}
            aria-label={t.lib_search_placeholder}
            className="w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500"
          />
        </div>

        {error && <p className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}

        {loading ? (
          <p className="mt-6 text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : (
          <div className="mt-8 space-y-8">
            {ordered.map(({ type, items }) => (
              <section key={type} aria-label={groupTitle(type)}>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  {groupTitle(type)}
                </h2>
                {STUB_GROUPS.includes(type) ? (
                  <div className="mt-3 rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center dark:border-stone-700">
                    <p className="text-sm text-stone-500 dark:text-stone-400">{t.lib_nothing_yet}</p>
                  </div>
                ) : items.length === 0 ? (
                  <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
                    {t.lib_nothing_yet}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2.5">
                    {items.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        type={type}
                        onDeleted={(id) => handleDeleted(type, id)}
                        error={errText}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </ConsentGate>
    </TabShell>
  );
}
