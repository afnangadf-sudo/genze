"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { API_ROUTES } from "@genze/shared";
import { apiFetch, ApiClientError } from "../../lib/auth";
import { useLang } from "../../lib/lang";
import { Field } from "../../components/Field";
import { Button } from "../../components/Button";
import { LangSwitch } from "../../components/LangSwitch";
import { ThemeToggle } from "../../components/ThemeToggle";

function ResetInner() {
  const params = useSearchParams();
  const { t } = useLang();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const token = params.get("token");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError(t.err_password_short);
      return;
    }
    setBusy(true);
    try {
      await apiFetch(API_ROUTES.resetPassword, {
        method: "POST",
        skipRefresh: true,
        body: JSON.stringify({ token, newPassword: password }),
      });
      setDone(true);
    } catch (err) {
      const code = err instanceof ApiClientError ? err.code : "UNKNOWN";
      setError(code === "RATE_LIMITED" ? t.err_rate_limited : t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return <p className="text-center text-stone-600 dark:text-stone-300">{t.verify_failure}</p>;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">{t.reset_title}</h1>
      {done ? (
        <>
          <p className="mt-6 text-stone-600 dark:text-stone-300">{t.reset_success}</p>
          <Link
            href="/login"
            className="mt-8 inline-block rounded-lg bg-clay px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-clay-dark"
          >
            {t.back_to_login}
          </Link>
        </>
      ) : (
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <Field
            id="new-password"
            label={t.f_new_password}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {t.reset_submit}
          </Button>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-end gap-2 px-6 py-4">
        <LangSwitch />
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-sm">
          <Suspense>
            <ResetInner />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
