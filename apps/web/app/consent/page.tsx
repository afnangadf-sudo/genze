"use client";

import { useEffect, useState } from "react";
import type { ConsentProviderStatus } from "@genze/shared";
import { TabShell } from "../../components/TabShell";
import { Button } from "../../components/Button";
import { getConsent, grantConsent, revokeConsent } from "../../lib/chat";
import { ApiClientError } from "../../lib/auth";
import { useLang } from "../../lib/lang";

export default function ConsentPage() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ConsentProviderStatus[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getConsent()
      .then((all) => {
        if (!cancelled) setProviders(all);
      })
      .catch((err) => {
        if (!cancelled) {
          setProviders([]);
          setError(err instanceof ApiClientError ? err.message : t.err_generic);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setProviders(await getConsent());
  }

  async function allow(id: string) {
    setError("");
    setBusyId(id);
    try {
      await grantConsent([id]);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  async function withdraw(id: string) {
    setError("");
    setBusyId(id);
    try {
      await revokeConsent(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  const required = (providers ?? []).filter((p) => p.required);

  return (
    <TabShell>
      <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
        {t.consent_title}
      </h1>
      <p className="mt-3 max-w-xl text-stone-600 dark:text-stone-300">{t.consent_manage_sub}</p>

      <div className="mt-8 max-w-xl">
        {providers === null ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : required.length === 0 ? (
          <div className="rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
            <p className="text-sm text-stone-600 dark:text-stone-300">{t.consent_none_needed}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {required.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-4 rounded-2xl border border-stone-200 bg-white px-4 py-4 dark:border-stone-800 dark:bg-stone-900"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-stone-800 dark:text-stone-100">{p.name}</p>
                    {p.granted && (
                      <span className="rounded-full bg-green-600/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400">
                        {t.consent_allowed}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{p.whatSees}</p>
                </div>
                {p.granted ? (
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    disabled={busyId !== null}
                    onClick={() => withdraw(p.id)}
                  >
                    {busyId === p.id ? t.s_loading : t.consent_withdraw}
                  </Button>
                ) : (
                  <Button
                    className="shrink-0"
                    disabled={busyId !== null}
                    onClick={() => allow(p.id)}
                  >
                    {busyId === p.id ? t.s_loading : t.consent_allow}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {error && <p className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}
      </div>
    </TabShell>
  );
}
