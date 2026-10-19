"use client";

import { useEffect, useState } from "react";
import type { BrowserSite, BrowserSiteStatus } from "@genze/shared";
import {
  addBrowserSite,
  beginSiteLogin,
  checkSiteLogin,
  completeSiteLogin,
  disconnectBrowserSite,
  listBrowserSites,
} from "../../lib/browserSites";
import { useLang } from "../../lib/lang";
import { Button } from "../Button";

function StatusBadge({ status }: { status: BrowserSiteStatus }) {
  const { t } = useLang();
  const label =
    status === "active" ? t.bs_st_active : status === "expired" ? t.bs_st_expired : t.bs_st_never;
  const cls =
    status === "active"
      ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
      : status === "expired"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        : "bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300";
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

/** The guided login panel: shown after the browser tab opens. */
function LoginPanel({
  site,
  loginSessionId,
  onDone,
  onCancel,
}: {
  site: BrowserSite;
  loginSessionId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useLang();
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  async function onSave() {
    setMsg("");
    setSaving(true);
    try {
      await completeSiteLogin(site.id, loginSessionId);
      onDone();
    } catch {
      setMsg(t.err_generic);
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-clay/40 bg-clay-soft/40 p-4 dark:border-stone-700 dark:bg-stone-800/60">
      <h4 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
        {t.bs_login_title} — {site.name}
      </h4>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{t.bs_login_desc}</p>
      {msg && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{msg}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={saving} onClick={onSave}>
          {saving ? t.bs_login_saving : t.bs_login_done}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          {t.s_cancel}
        </Button>
      </div>
    </div>
  );
}

function SiteCard({
  site,
  busy,
  loginState,
  onLogin,
  onCheck,
  onDisconnect,
  onLoginDone,
  onLoginCancel,
}: {
  site: BrowserSite;
  busy: boolean;
  loginState: { loginSessionId: string } | null;
  onLogin: (site: BrowserSite) => void;
  onCheck: (site: BrowserSite) => void;
  onDisconnect: (site: BrowserSite) => void;
  onLoginDone: () => void;
  onLoginCancel: () => void;
}) {
  const { t } = useLang();
  return (
    <div className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">{site.name}</h3>
        <StatusBadge status={site.status} />
      </div>
      <p className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400" dir="ltr">
        {site.url}
      </p>
      {site.status === "expired" && (
        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">{t.bs_relogin_note}</p>
      )}
      {!loginState && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => onLogin(site)}>
            {t.bs_login}
          </Button>
          {site.status !== "never" && (
            <Button variant="ghost" disabled={busy} onClick={() => onCheck(site)}>
              {busy ? t.bs_checking : t.bs_check}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => onDisconnect(site)}>
            {busy ? t.bs_disconnecting : t.bs_disconnect}
          </Button>
        </div>
      )}
      {loginState && (
        <LoginPanel
          site={site}
          loginSessionId={loginState.loginSessionId}
          onDone={onLoginDone}
          onCancel={onLoginCancel}
        />
      )}
    </div>
  );
}

export function BrowserSitesSection() {
  const { t } = useLang();
  const [sites, setSites] = useState<BrowserSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<{ siteId: string; loginSessionId: string } | null>(null);
  const [msg, setMsg] = useState("");

  async function reload() {
    try {
      setSites(await listBrowserSites());
    } catch {
      setMsg(t.err_generic);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await listBrowserSites();
        if (!cancelled) setSites(s);
      } catch {
        if (!cancelled) setMsg(t.err_generic);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onAdd() {
    if (!name.trim() || !url.trim() || adding) return;
    setMsg("");
    setAdding(true);
    try {
      const site = await addBrowserSite(name.trim(), url.trim());
      setSites((prev) => [site, ...prev]);
      setName("");
      setUrl("");
    } catch {
      setMsg(t.err_generic);
    } finally {
      setAdding(false);
    }
  }

  /** Opens the guided login: a new tab with the site, then the save panel. */
  async function onLogin(site: BrowserSite) {
    setMsg("");
    setBusyId(site.id);
    try {
      const session = await beginSiteLogin(site.id);
      if (session.liveViewUrl) window.open(session.liveViewUrl, "_blank", "noopener");
      setLoginFor({ siteId: site.id, loginSessionId: session.loginSessionId });
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  async function onCheck(site: BrowserSite) {
    setMsg("");
    setBusyId(site.id);
    try {
      const { status } = await checkSiteLogin(site.id);
      setSites((prev) => prev.map((s) => (s.id === site.id ? { ...s, status } : s)));
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  async function onDisconnect(site: BrowserSite) {
    setMsg("");
    setBusyId(site.id);
    try {
      await disconnectBrowserSite(site.id);
      setSites((prev) =>
        prev.map((s) => (s.id === site.id ? { ...s, status: "never" as const } : s)),
      );
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">{t.bs_title}</h3>
      <p className="mt-1 max-w-prose text-sm text-stone-500 dark:text-stone-400">{t.bs_desc}</p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.bs_name_ph}
          aria-label={t.bs_name}
          maxLength={80}
          className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t.bs_url_ph}
          aria-label={t.bs_url}
          dir="ltr"
          className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
        <Button disabled={adding || !name.trim() || !url.trim()} onClick={onAdd}>
          {adding ? t.bs_adding : t.bs_add}
        </Button>
      </div>
      {msg && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{msg}</p>}

      <div className="mt-4">
        {loading ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {sites.map((s) => (
              <li key={s.id}>
                <SiteCard
                  site={s}
                  busy={busyId === s.id}
                  loginState={loginFor?.siteId === s.id ? loginFor : null}
                  onLogin={onLogin}
                  onCheck={onCheck}
                  onDisconnect={onDisconnect}
                  onLoginDone={() => {
                    setLoginFor(null);
                    void reload();
                  }}
                  onLoginCancel={() => setLoginFor(null)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
