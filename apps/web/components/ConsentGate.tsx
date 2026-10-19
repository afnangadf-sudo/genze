"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ConsentProviderStatus } from "@genze/shared";
import { getConsent, grantConsent } from "../lib/chat";
import { ApiClientError } from "../lib/auth";
import { useLang } from "../lib/lang";
import { Button } from "./Button";

// Session-only dismissal: the gate won't ask again until the tab is closed.
// API 403s (CONSENT_REQUIRED) still surface inline in the chat if the user
// tries a real AI answer after dismissing.
const DISMISSED_KEY = "genze_consent_dismissed";

type Phase = "loading" | "gate" | "open";

export function ConsentGate({ children }: { children: ReactNode }) {
  const { t } = useLang();
  const [phase, setPhase] = useState<Phase>("loading");
  const [needed, setNeeded] = useState<ConsentProviderStatus[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    try {
      if (sessionStorage.getItem(DISMISSED_KEY) === "1") {
        setPhase("open");
        return;
      }
    } catch {
      /* storage unavailable */
    }
    getConsent()
      .then((all) => {
        if (cancelled) return;
        const missing = all.filter((p) => p.required && !p.granted);
        if (missing.length === 0) {
          setPhase("open");
        } else {
          setNeeded(missing);
          setPhase("gate");
        }
      })
      .catch(() => {
        // Fail open: children render and the chat surfaces real errors inline.
        if (!cancelled) setPhase("open");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function allow(ids: string[]) {
    if (busyId) return;
    setError("");
    setBusyId(ids.length === 1 ? ids[0] : "all");
    try {
      await grantConsent(ids);
      const rest = needed.filter((p) => !ids.includes(p.id));
      if (rest.length === 0) {
        setPhase("open");
      } else {
        setNeeded(rest);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  function notNow() {
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* storage unavailable */
    }
    setPhase("open");
  }

  if (phase === "open") return <>{children}</>;

  if (phase === "loading") {
    return (
      <p className="py-16 text-center text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-8">
      <div className="rounded-2xl border border-stone-200 bg-white p-6 sm:p-8 dark:border-stone-800 dark:bg-stone-900">
        <h1 className="text-xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
          {t.consent_title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          {t.consent_text}
        </p>

        <div className="mt-6 space-y-3">
          {needed.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-stone-200 px-4 py-3 dark:border-stone-700"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-800 dark:text-stone-100">{p.name}</p>
                <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{p.whatSees}</p>
              </div>
              <Button
                className="shrink-0"
                disabled={busyId !== null}
                onClick={() => allow([p.id])}
              >
                {busyId === p.id ? t.s_loading : t.consent_allow}
              </Button>
            </div>
          ))}
        </div>

        {error && <p className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={notNow}
            className="text-sm text-stone-500 underline decoration-stone-300 underline-offset-4 hover:text-stone-700 dark:text-stone-400 dark:decoration-stone-600 dark:hover:text-stone-200"
          >
            {t.consent_not_now}
          </button>
          <Button disabled={busyId !== null} onClick={() => allow(needed.map((p) => p.id))}>
            {busyId === "all" ? t.s_loading : t.consent_allow_all}
          </Button>
        </div>
      </div>
    </div>
  );
}
