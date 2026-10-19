"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_ROUTES, type AuthTokens, type PublicUser } from "@genze/shared";
import { API_BASE, apiFetch, setTokens, ApiClientError } from "../../lib/auth";
import { useLang } from "../../lib/lang";
import { Field } from "../../components/Field";
import { Button } from "../../components/Button";
import { LangSwitch } from "../../components/LangSwitch";
import { ThemeToggle } from "../../components/ThemeToggle";

const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === "true";

function errorText(code: string, fallback: string, t: { err_invalid_credentials: string; err_not_verified: string; err_rate_limited: string; err_generic: string }): string {
  if (code === "INVALID_CREDENTIALS") return t.err_invalid_credentials;
  if (code === "EMAIL_NOT_VERIFIED") return t.err_not_verified;
  if (code === "RATE_LIMITED") return t.err_rate_limited;
  return fallback;
}

export default function LoginPage() {
  const router = useRouter();
  const { t } = useLang();
  const [step, setStep] = useState<"form" | "2fa">("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingToken, setPendingToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function finishLogin(data: { tokens: AuthTokens; user: PublicUser }) {
    setTokens(data.tokens.accessToken, data.tokens.refreshToken);
    // Honor a safe post-login destination (e.g. a gem share link that
    // bounced an unauthenticated visitor here). Only relative paths.
    let next = "/chat";
    try {
      const want = new URLSearchParams(window.location.search).get("next") ?? "";
      if (want.startsWith("/") && !want.startsWith("//")) next = want;
    } catch {
      /* keep default */
    }
    router.replace(next);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await apiFetch<
        { tokens: AuthTokens; user: PublicUser } | { twoFactorRequired: true; pendingToken: string }
      >(API_ROUTES.login, {
        method: "POST",
        skipRefresh: true,
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if ("twoFactorRequired" in data && data.twoFactorRequired) {
        setPendingToken(data.pendingToken);
        setStep("2fa");
      } else {
        await finishLogin(data as { tokens: AuthTokens; user: PublicUser });
      }
    } catch (err) {
      const code = err instanceof ApiClientError ? err.code : "UNKNOWN";
      setError(errorText(code, t.err_generic, t));
    } finally {
      setBusy(false);
    }
  }

  async function handle2fa(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await apiFetch<{ tokens: AuthTokens; user: PublicUser }>(API_ROUTES.login2fa, {
        method: "POST",
        skipRefresh: true,
        body: JSON.stringify({ pendingToken, code: code.trim() }),
      });
      await finishLogin(data);
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
          <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">{t.login_title}</h1>

          {step === "form" ? (
            <form onSubmit={handleLogin} className="mt-6 space-y-4">
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
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full">
                {t.login_submit}
              </Button>
              <div className="text-center">
                <Link href="/forgot-password" className="text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400">
                  {t.login_forgot}
                </Link>
              </div>
            </form>
          ) : (
            <form onSubmit={handle2fa} className="mt-6 space-y-4">
              <p className="text-sm text-stone-500 dark:text-stone-400">{t.login_2fa_prompt}</p>
              <Field
                id="code"
                label={t.f_code}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full">
                {t.login_2fa_submit}
              </Button>
            </form>
          )}

          {GOOGLE_ENABLED && step === "form" && (
            <div className="mt-6">
              <a
                href={`${API_BASE}${API_ROUTES.oauthGoogle}`}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-200/50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                  <path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h6c-.3 1.4-1.1 2.5-2.4 3.3v2.8h3.9c2.3-2.1 3.1-5 3.1-8.1z" />
                  <path fill="#34A853" d="M12 23c3.2 0 6-1.1 7.9-2.9l-3.9-2.8c-1.1.7-2.5 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v2.9C3.3 20.5 7.4 23 12 23z" />
                  <path fill="#FBBC05" d="M5.4 13.6c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.1H1.4C.5 7.6 0 9.3 0 11.3s.5 3.7 1.4 5.2l4-2.9z" />
                  <path fill="#EA4335" d="M12 5.5c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 2.1 15.2 1 12 1 7.4 1 3.3 3.5 1.4 7.4l4 2.9c.9-2.7 3.5-4.8 6.6-4.8z" />
                </svg>
                {t.login_google}
              </a>
            </div>
          )}

          <p className="mt-8 text-center text-sm text-stone-500 dark:text-stone-400">
            {t.login_no_account}{" "}
            <Link href="/signup" className="font-medium text-clay hover:text-clay-dark">
              {t.login_create_account}
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
