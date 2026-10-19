"use client";

import { useEffect, useState } from "react";
import type { ConnectorAvailability, ConnectorStatus } from "@genze/shared";
import {
  disconnectConnector,
  getConnectorAuthorizeUrl,
  listConnectors,
} from "../../lib/connectors";
import { useLang } from "../../lib/lang";
import { Button } from "../Button";
import { CustomConnectCard, CustomConnectorList } from "./CustomConnectorsSection";

function availabilityLabel(t: ReturnType<typeof useLang>["t"], a: ConnectorAvailability): string {
  switch (a) {
    case "available":
      return t.c_available;
    case "beta":
      return t.c_beta;
    case "not_available_yet":
      return t.c_not_available_yet;
    case "coming_later":
      return t.c_coming_later;
  }
}

function AvailabilityBadge({ c }: { c: ConnectorStatus }) {
  const { t } = useLang();
  const ready = c.availability === "available" || c.availability === "beta";
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${
        ready
          ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
          : "bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300"
      }`}
    >
      {availabilityLabel(t, c.availability)}
    </span>
  );
}

function ConnectorCard({
  c,
  busy,
  onConnect,
  onDisconnect,
}: {
  c: ConnectorStatus;
  busy: boolean;
  onConnect: (c: ConnectorStatus) => void;
  onDisconnect: (c: ConnectorStatus) => void;
}) {
  const { t } = useLang();
  const usable = c.availability === "available" || c.availability === "beta";
  return (
    <div className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">{c.name}</h3>
            <AvailabilityBadge c={c} />
            {c.connected && (
              <span className="inline-block rounded-full bg-clay-soft px-2.5 py-0.5 text-[11px] font-medium text-clay-dark dark:bg-stone-800 dark:text-clay">
                {t.c_connected}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-stone-600 dark:text-stone-300">{c.blurb}</p>
          {!usable && c.availabilityNote && (
            <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
              {c.availabilityNote}
            </p>
          )}
          {usable && c.scopes.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={c.name}>
              {c.scopes.map((s) => (
                <li
                  key={s.id}
                  className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300"
                >
                  {s.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-3">
        {c.connected ? (
          <Button variant="ghost" disabled={busy} onClick={() => onDisconnect(c)}>
            {busy ? t.c_disconnecting : t.c_disconnect}
          </Button>
        ) : (
          <Button variant="ghost" disabled={busy || !usable} onClick={() => onConnect(c)}>
            {busy ? t.c_connecting : t.c_connect}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ConnectorsSection() {
  const { t } = useLang();
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  /** Bumped whenever a custom connector is added, so the custom list reloads. */
  const [customSignal, setCustomSignal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listConnectors()
      .then((cs) => {
        if (!cancelled) setConnectors(cs);
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
  }, []);

  /** Connect leaves the page (no pop-up): the vendor returns the user to the
   *  app's OAuth callback page, which finishes the handshake. */
  async function onConnect(c: ConnectorStatus) {
    setMsg("");
    setBusyId(c.id);
    try {
      const url = await getConnectorAuthorizeUrl(c.id);
      window.location.href = url;
    } catch {
      setMsg(t.err_generic);
      setBusyId(null);
    }
  }

  async function onDisconnect(c: ConnectorStatus) {
    setMsg("");
    setBusyId(c.id);
    try {
      await disconnectConnector(c.id);
      setConnectors((prev) => prev.map((x) => (x.id === c.id ? { ...x, connected: false } : x)));
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <p className="max-w-prose text-sm text-stone-500 dark:text-stone-400">{t.c_desc}</p>
      <div className="mt-4">
        <CustomConnectCard onAdded={() => setCustomSignal((n) => n + 1)} />
      </div>
      {msg && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{msg}</p>}
      <div className="mt-4">
        {loading ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {connectors.map((c) => (
              <li key={c.id}>
                <ConnectorCard
                  c={c}
                  busy={busyId === c.id}
                  onConnect={onConnect}
                  onDisconnect={onDisconnect}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <CustomConnectorList refreshSignal={customSignal} />
    </div>
  );
}
