"use client";

import { useState } from "react";
import Link from "next/link";
import { API_ROUTES } from "@genze/shared";
import { apiFetch, ApiClientError } from "../../lib/auth";
import { useLang } from "../../lib/lang";
import { COUNTRIES } from "../../lib/countries";
import { Field, fieldInputClass } from "../../components/Field";
import { Button } from "../../components/Button";
import { LangSwitch } from "../../components/LangSwitch";
import { ThemeToggle } from "../../components/ThemeToggle";

export default function SignupPage() {
  const { t } = useLang();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState("PK");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError(t.err_password_short);
      return;
    }
    setBusy(true);
    try {
      await apiFetch(API_ROUTES.signup, {
        method: "POST",
        skipRefresh: true,
        body: JSON.stringify({ email: email.trim(), password, country }),
      });
      setDone(true);
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
          {done ? (
            <div className="text-center">
              <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
                {t.signup_done_title}
              </h1>
              <p className="mt-3 text-stone-500 dark:text-stone-400">{t.signup_done_text}</p>
              <Link
                href="/login"
                className="mt-8 inline-block rounded-lg bg-clay px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-clay-dark"
              >
                {t.back_to_login}
              </Link>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
                {t.signup_title}
              </h1>
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
                <Field
                  id="password"
                  label={t.f_password}
                  type="password"
                  autoComplete="new-password"
                  required
                  hint={t.signup_password_hint}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Field id="country" label={t.f_country}>
                  <select
                    id="country"
                    className={fieldInputClass}
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                <Button type="submit" disabled={busy} className="w-full">
                  {t.signup_submit}
                </Button>
              </form>
              <p className="mt-8 text-center text-sm text-stone-500 dark:text-stone-400">
                {t.signup_have_account}{" "}
                <Link href="/login" className="font-medium text-clay hover:text-clay-dark">
                  {t.signup_login}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
