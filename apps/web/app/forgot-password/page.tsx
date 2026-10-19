"use client";

import { useState } from "react";
import Link from "next/link";
import { API_ROUTES } from "@genze/shared";
import { apiFetch, ApiClientError } from "../../lib/auth";
import { useLang } from "../../lib/lang";
import { Field } from "../../components/Field";
import { Button } from "../../components/Button";
import { LangSwitch } from "../../components/LangSwitch";
import { ThemeToggle } from "../../components/ThemeToggle";

export default function ForgotPasswordPage() {
  const { t } = useLang();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiFetch(API_ROUTES.forgotPassword, {
        method: "POST",
        skipRefresh: true,
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
    } catch (err) {
      const code = err instanceof ApiClientError ? err.code : "UNKNOWN";
      setError(code === "RATE_LIMITED" ? t.err_rate_limited : t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-end gap-2 px-6 py-4">
        <LangSwitch />
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
            {t.forgot_title}
          </h1>
          {sent ? (
            <p className="mt-6 text-stone-600 dark:text-stone-300">{t.forgot_sent}</p>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <Field
                id="email"
                label={t.f_email}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full">
                {t.forgot_submit}
              </Button>
            </form>
          )}
          <p className="mt-8 text-center text-sm text-stone-500 dark:text-stone-400">
            <Link href="/login" className="font-medium text-clay hover:text-clay-dark">
              {t.back_to_login}
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
