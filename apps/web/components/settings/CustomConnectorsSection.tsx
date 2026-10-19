"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { CustomConnector, CustomConnectorAuthType } from "@genze/shared";
import {
  disconnectCustomConnector,
  getCustomConnectorAuthorizeUrl,
  listCustomConnectors,
  registerCustomConnector,
  removeCustomConnector,
} from "../../lib/connectors";
import { useLang } from "../../lib/lang";
import { friendlyErrText } from "../../lib/usage";
import { Button } from "../Button";

/* ---------- Add card: "Can't find your app?" ---------- */

export function CustomConnectCard({ onAdded }: { onAdded: () => void }) {
  const { lang, t } = useLang();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<CustomConnectorAuthType>("oauth");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    setOk(false);
    const n = name.trim();
    const u = url.trim();
    const tok = token.trim();
    if (!n) {
      setMsg(t.mc_err_name);
      return;
    }
    if (!/^https:\/\/\S+$/i.test(u)) {
      setMsg(t.mc_err_url);
      return;
    }
    if (authType === "token" && !tok) {
      setMsg(t.mc_err_token);
      return;
    }
    setBusy(true);
    try {
      await registerCustomConnector({
        name: n,
        mcpUrl: u,
        authType,
        ...(authType === "token" ? { token: tok } : {}),
      });
      setName("");
      setUrl("");
      setToken("");
      setAuthType("oauth");
      setOk(true);
      setMsg(t.mc_added);
      onAdded();
    } catch (err) {
      setMsg(friendlyErrText(lang, t, err));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500";

  return (
    <div className="rounded-xl border border-clay/40 bg-clay-soft/40 p-5 dark:border-stone-700 dark:bg-stone-900/60">
      <h3 className="text-base font-semibold text-stone-800 dark:text-stone-100">
        {t.mc_card_title}
      </h3>
      <p className="mt-1.5 max-w-prose text-sm text-stone-600 dark:text-stone-300">
        {t.mc_card_desc}
      </p>
      <form onSubmit={onSubmit} className="mt-4 max-w-lg space-y-4">
        <div>
          <label htmlFor="mc-name" className="text-sm font-medium text-stone-700 dark:text-stone-200">
            {t.mc_name}
          </label>
          <input
            id="mc-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.mc_name_ph}
            maxLength={80}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="mc-url" className="text-sm font-medium text-stone-700 dark:text-stone-200">
            {t.mc_url}
          </label>
          <input
            id="mc-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t.mc_url_ph}
            dir="ltr"
            className={inputClass}
          />
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t.mc_url_hint}</p>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-stone-700 dark:text-stone-200">
            {t.mc_auth}
          </legend>
          <div className="mt-2 space-y-2">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="mc-auth"
                checked={authType === "oauth"}
                onChange={() => setAuthType("oauth")}
                className="mt-1 accent-clay"
              />
              <span>
                <span className="block text-sm text-stone-700 dark:text-stone-200">
                  {t.mc_auth_oauth}
                </span>
                <span className="block text-xs text-stone-500 dark:text-stone-400">
                  {t.mc_auth_oauth_hint}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="mc-auth"
                checked={authType === "token"}
                onChange={() => setAuthType("token")}
                className="mt-1 accent-clay"
              />
              <span>
                <span className="block text-sm text-stone-700 dark:text-stone-200">
                  {t.mc_auth_token}
                </span>
                <span className="block text-xs text-stone-500 dark:text-stone-400">
                  {t.mc_auth_token_hint}
                </span>
              </span>
            </label>
          </div>
        </fieldset>
        {authType === "token" && (
          <div>
            <label htmlFor="mc-token" className="text-sm font-medium text-stone-700 dark:text-stone-200">
              {t.mc_token}
            </label>
            <input
              id="mc-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              dir="ltr"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t.mc_token_hint}</p>
          </div>
        )}
        {msg && (
          <p
            className={`text-sm ${ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
            role="status"
          >
            {msg}
          </p>
        )}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? t.mc_adding : t.mc_add}
          </Button>
        </div>
        <p className="text-xs text-stone-500 dark:text-stone-400">{t.mc_browser_note}</p>
      </form>
    </div>
  );
}

/* ---------- Custom connector list (below the built-ins) ---------- */

function CustomCard({
  c,
  busy,
  confirmingRemove,
  onConnect,
  onDisconnect,
  onRemove,
  onRemoveConfirm,
  onRemoveCancel,
}: {
  c: CustomConnector;
  busy: boolean;
  confirmingRemove: boolean;
  onConnect: (c: CustomConnector) => void;
  onDisconnect: (c: CustomConnector) => void;
  onRemove: (c: CustomConnector) => void;
  onRemoveConfirm: (c: CustomConnector) => void;
  onRemoveCancel: () => void;
}) {
  const { t } = useLang();
  return (
    <div className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">{c.name}</h3>
            <span className="inline-block rounded-full bg-clay-soft px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-clay-dark dark:bg-stone-800 dark:text-clay">
              {t.mc_badge}
            </span>
            {c.connected && (
              <span className="inline-block rounded-full bg-green-100 px-2.5 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-950 dark:text-green-300">
                {t.c_connected}
              </span>
            )}
          </div>
          <p className="mt-1.5 truncate text-xs text-stone-500 dark:text-stone-400" dir="ltr">
            {c.mcpUrl}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {c.connected ? (
          <Button variant="ghost" disabled={busy} onClick={() => onDisconnect(c)}>
            {busy ? t.c_disconnecting : t.c_disconnect}
          </Button>
        ) : c.authType === "oauth" ? (
          <Button variant="ghost" disabled={busy} onClick={() => onConnect(c)}>
            {busy ? t.c_connecting : t.c_connect}
          </Button>
        ) : (
          /* Token-auth connectors store the token once; after a disconnect
             the plain path back is remove + add again (no re-paste endpoint). */
          <span className="text-xs text-stone-500 dark:text-stone-400">{t.mc_reconnect_hint}</span>
        )}
        {confirmingRemove ? (
          <>
            <span className="text-xs text-stone-600 dark:text-stone-300">
              {t.mc_remove_confirm}
            </span>
            <Button variant="danger" disabled={busy} onClick={() => onRemoveConfirm(c)}>
              {busy ? t.mc_removing : t.mc_remove_yes}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onRemoveCancel}>
              {t.mc_remove_no}
            </Button>
          </>
        ) : (
          <Button variant="ghost" disabled={busy} onClick={() => onRemove(c)}>
            {t.mc_remove}
          </Button>
        )}
      </div>
    </div>
  );
}

export function CustomConnectorList({ refreshSignal }: { refreshSignal: number }) {
  const { lang, t } = useLang();
  const [items, setItems] = useState<CustomConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listCustomConnectors()
      .then((cs) => {
        if (!cancelled) setItems(cs);
      })
      .catch(() => {
        if (!cancelled) setMsg(t.err_generic);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  /** Connect leaves the page (no pop-up): the app returns the user to the
   *  custom OAuth callback page, which finishes the handshake. */
  async function onConnect(c: CustomConnector) {
    setMsg("");
    setBusyId(c.id);
    try {
      const url = await getCustomConnectorAuthorizeUrl(c.id);
      window.location.href = url;
    } catch (err) {
      setMsg(friendlyErrText(lang, t, err));
      setBusyId(null);
    }
  }

  async function onDisconnect(c: CustomConnector) {
    setMsg("");
    setBusyId(c.id);
    try {
      await disconnectCustomConnector(c.id);
      setItems((prev) => prev.map((x) => (x.id === c.id ? { ...x, connected: false } : x)));
    } catch (err) {
      setMsg(friendlyErrText(lang, t, err));
    } finally {
      setBusyId(null);
    }
  }

  async function onRemoveConfirm(c: CustomConnector) {
    setMsg("");
    setBusyId(c.id);
    try {
      await removeCustomConnector(c.id);
      setItems((prev) => prev.filter((x) => x.id !== c.id));
      setConfirmId(null);
    } catch (err) {
      setMsg(friendlyErrText(lang, t, err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">{t.mc_your}</h3>
      {msg && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{msg}</p>}
      <div className="mt-3">
        {loading ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.mc_empty}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {items.map((c) => (
              <li key={c.id}>
                <CustomCard
                  c={c}
                  busy={busyId === c.id}
                  confirmingRemove={confirmId === c.id}
                  onConnect={onConnect}
                  onDisconnect={onDisconnect}
                  onRemove={(x) => setConfirmId(x.id)}
                  onRemoveConfirm={onRemoveConfirm}
                  onRemoveCancel={() => setConfirmId(null)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
