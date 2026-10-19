"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_ROUTES, type Device, type FeatureUsage, type PublicUser, type UsageSummary } from "@genze/shared";
import {
  COMMON_LANGUAGES,
  LANGUAGE_NAMES,
  languageDisplayName,
} from "@genze/shared";
import { API_BASE, apiFetch, clearTokens, getTokens, ApiClientError } from "../../lib/auth";
import { LANGS, isLang, useLang, type Lang, type Strings } from "../../lib/lang";
import { featureName, fmt, getUsageSummary } from "../../lib/usage";
import { TabShell } from "../../components/TabShell";
import { Field } from "../../components/Field";
import { Button } from "../../components/Button";
import { ConnectorsSection } from "../../components/settings/ConnectorsSection";
import { BrowserSitesSection } from "../../components/settings/BrowserSitesSection";
import { AuditLogSection } from "../../components/settings/AuditLogSection";
import { SkillsSection } from "../../components/settings/SkillsSection";
import { GemsSection } from "../../components/settings/GemsSection";

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-4 first:mt-6">
      <h2 className="text-lg font-medium text-stone-800 dark:text-stone-100">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/* ---------- Step 5: today's usage for this account ---------- */

function UsageRow({ usage, t }: { usage: FeatureUsage; t: Strings }) {
  const pct = usage.cap && usage.cap > 0 ? Math.min(100, (usage.used / usage.cap) * 100) : 100;
  const unit = usage.feature === "files" ? " MB" : "";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-stone-700 dark:text-stone-200">
          {featureName(t, usage.feature)}
        </span>
        <span className="text-stone-500 dark:text-stone-400">
          {usage.used}
          {unit} / {usage.cap === null ? t.u_unlimited : `${usage.cap}${unit}`}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-clay" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        {t.u_resets} {formatDate(usage.resetAt)}
      </p>
    </div>
  );
}

function UsagePanel({ t }: { t: Strings }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getUsageSummary()
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">{t.err_generic}</p>;
  }
  if (!summary) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>;
  }

  const planLabel = summary.plan === "paid" ? t.u_paid : t.u_free;
  return (
    <div className="space-y-5">
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-stone-500 dark:text-stone-400">{t.u_plan}: </span>
          <span className="text-stone-800 dark:text-stone-100">{planLabel}</span>
        </p>
        <p className="text-stone-500 dark:text-stone-400">{t.u_coming_soon}</p>
      </div>
      {summary.features.map((f) => (
        <UsageRow key={f.feature} usage={f} t={t} />
      ))}
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-stone-500 dark:text-stone-400">{t.u_credits}: </span>
          <span className="text-stone-800 dark:text-stone-100">{summary.credits.balance}</span>
          <span className="text-stone-500 dark:text-stone-400">
            {" · "}
            {fmt(t.u_granted_today, { n: String(summary.credits.grantedToday) })}
          </span>
        </p>
        <p>
          <span className="text-stone-500 dark:text-stone-400">{t.u_today_cost}: </span>
          <span className="text-stone-800 dark:text-stone-100">
            ${summary.costUsdToday.toFixed(2)}
          </span>
        </p>
      </div>
    </div>
  );
}

/** Datalist options for the free-text chat-language input: the five UI
 *  languages plus the common-languages table (free text still accepted). */
const CHAT_LANG_OPTIONS: { code: string; name: string }[] = Object.entries({
  ...(LANGUAGE_NAMES as Record<string, string>),
  ...COMMON_LANGUAGES,
})
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export default function SettingsPage() {
  const router = useRouter();
  const { lang, setLang, t } = useLang();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);

  // App language: the five fully-translated UI languages (client-side session
  // choice; never a broken screen — untranslated codes fall back to English).
  const [prefLang, setPrefLang] = useState<Lang>(lang);
  const [langMsg, setLangMsg] = useState("");
  // Chat language: ANY language code, saved server-side (preferredLanguage).
  const [chatLang, setChatLang] = useState("en");
  const [chatLangMsg, setChatLangMsg] = useState("");
  const [chatLangBusy, setChatLangBusy] = useState(false);

  // 2FA setup state
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [twoFaMsg, setTwoFaMsg] = useState("");
  const [twoFaBusy, setTwoFaBusy] = useState(false);

  // Delete-account state
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");

  const [exportMsg, setExportMsg] = useState("");

  useEffect(() => {
    if (!getTokens().access) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const [me, devs] = await Promise.all([
          apiFetch<PublicUser>(API_ROUTES.me),
          apiFetch<{ devices: Device[] }>(API_ROUTES.devices),
        ]);
        setUser(me);
        setDevices(devs.devices);
        if (isLang(me.preferredLanguage)) setPrefLang(me.preferredLanguage);
        if (typeof me.preferredLanguage === "string" && me.preferredLanguage)
          setChatLang(me.preferredLanguage);
      } catch {
        router.replace("/login");
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function refreshUser() {
    const me = await apiFetch<PublicUser>(API_ROUTES.me);
    setUser(me);
  }

  // App language is a client-side session choice (LangProvider persists it in
  // localStorage). A failure just shows a plain inline message — never a pop-up.
  async function saveAppLanguage(l: Lang) {
    setPrefLang(l);
    setLang(l);
    setLangMsg(t.s_chat_language_saved);
  }

  // Chat language accepts ANY language code — saved server-side. The input
  // offers a datalist of common languages but free text is always allowed.
  async function saveChatLanguage() {
    const code = chatLang.trim().toLowerCase();
    setChatLangMsg("");
    if (!code) {
      setChatLangMsg(t.s_chat_language_error);
      return;
    }
    setChatLangBusy(true);
    try {
      await apiFetch(API_ROUTES.me, {
        method: "PATCH",
        body: JSON.stringify({ preferredLanguage: code }),
      });
      setChatLang(code);
      setChatLangMsg(t.s_chat_language_saved);
    } catch {
      setChatLangMsg(t.s_chat_language_error);
    } finally {
      setChatLangBusy(false);
    }
  }

  async function signOutCurrent() {
    try {
      await apiFetch(API_ROUTES.logout, { method: "POST" });
    } catch {
      /* session already gone */
    }
    clearTokens();
    router.replace("/login");
  }

  async function signOutEverywhere() {
    try {
      await apiFetch(API_ROUTES.logoutAll, { method: "POST" });
    } catch {
      /* ignore */
    }
    clearTokens();
    router.replace("/login");
  }

  async function startTwoFaSetup() {
    setTwoFaMsg("");
    setTwoFaBusy(true);
    try {
      const data = await apiFetch<{ otpauthUrl: string; secret: string }>(API_ROUTES.twoFaSetup, { method: "POST" });
      setSetup(data);
    } catch (err) {
      setTwoFaMsg(t.err_generic);
    } finally {
      setTwoFaBusy(false);
    }
  }

  async function enableTwoFa() {
    setTwoFaMsg("");
    setTwoFaBusy(true);
    try {
      await apiFetch(API_ROUTES.twoFaEnable, { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      setSetup(null);
      setCode("");
      await refreshUser();
    } catch {
      setTwoFaMsg(t.err_generic);
    } finally {
      setTwoFaBusy(false);
    }
  }

  async function disableTwoFa() {
    setTwoFaMsg("");
    setTwoFaBusy(true);
    try {
      await apiFetch(API_ROUTES.twoFaDisable, { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      setCode("");
      await refreshUser();
    } catch {
      setTwoFaMsg(t.err_generic);
    } finally {
      setTwoFaBusy(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setTwoFaMsg(t.s_copied);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function exportData() {
    setExportMsg("");
    const { access } = getTokens();
    try {
      const res = await fetch(`${API_BASE}${API_ROUTES.export}`, {
        headers: access ? { Authorization: `Bearer ${access}` } : {},
      });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "genze-data.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportMsg(t.s_export_done);
    } catch {
      setExportMsg(t.err_generic);
    }
  }

  async function deleteAccount() {
    setDeleteError("");
    if (!user || deleteEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      setDeleteError(t.err_invalid_credentials);
      return;
    }
    try {
      await apiFetch(API_ROUTES.deleteAccount, {
        method: "DELETE",
        body: JSON.stringify({ password: deletePassword }),
      });
      clearTokens();
      router.replace("/");
    } catch (err) {
      const code = err instanceof ApiClientError ? err.code : "UNKNOWN";
      setDeleteError(code === "INVALID_CREDENTIALS" ? t.err_invalid_credentials : t.err_generic);
    }
  }

  if (loading) {
    return (
      <TabShell>
        <p className="text-stone-500 dark:text-stone-400">{t.s_loading}</p>
      </TabShell>
    );
  }

  return (
    <TabShell>
      <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">{t.settings_title}</h1>

      <Section title={t.s_profile}>
        <div className="space-y-2 text-sm">
          <p>
            <span className="text-stone-500 dark:text-stone-400">{t.s_email}: </span>
            <span className="text-stone-800 dark:text-stone-100">{user?.email}</span>
          </p>
          <p>
            <span className="text-stone-500 dark:text-stone-400">{t.s_country}: </span>
            <span className="text-stone-800 dark:text-stone-100">{user?.country}</span>
          </p>
        </div>
      </Section>

      <Section title={t.s_app_language}>
        <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_app_language_desc}</p>
        <div className="max-w-xs">
          <label className="sr-only" htmlFor="app-language">
            {t.s_app_language}
          </label>
          <select
            id="app-language"
            value={prefLang}
            onChange={(e) => saveAppLanguage(e.target.value as Lang)}
            className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none focus:border-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.nativeName}
              </option>
            ))}
          </select>
          {langMsg && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{langMsg}</p>}
        </div>
      </Section>

      <Section title={t.s_chat_language}>
        <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_chat_language_desc}</p>
        <div className="max-w-xs">
          <label className="sr-only" htmlFor="chat-language">
            {t.s_chat_language}
          </label>
          <div className="flex gap-2">
            <input
              id="chat-language"
              list="chat-language-list"
              value={chatLang}
              disabled={chatLangBusy}
              onChange={(e) => setChatLang(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveChatLanguage();
              }}
              placeholder={t.s_chat_language_ph}
              autoComplete="off"
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-800 outline-none focus:border-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
            />
            <datalist id="chat-language-list">
              {CHAT_LANG_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </datalist>
            <Button disabled={chatLangBusy} onClick={saveChatLanguage}>
              {t.w_save}
            </Button>
          </div>
          {chatLangMsg && (
            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{chatLangMsg}</p>
          )}
        </div>
      </Section>

      <Section title={t.c_title}>
        <ConnectorsSection />
        <BrowserSitesSection />
      </Section>

      <Section title={t.c_audit_title}>
        <AuditLogSection />
      </Section>

      <Section title={t.k_title}>
        <SkillsSection />
      </Section>

      <Section title={t.gm_title} id="gems">
        <GemsSection />
      </Section>

      <Section title={t.u_title}>
        <UsagePanel t={t} />
      </Section>

      <Section title={t.s_memory}>
        <p className="text-sm text-stone-500 dark:text-stone-400">{t.m_desc}</p>
        <Button variant="ghost" onClick={() => router.push("/settings/memory")}>
          {t.m_title}
        </Button>
      </Section>

      <Section title={t.s_devices}>
        <ul className="space-y-3">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800"
            >
              <div className="text-sm">
                <p className="font-medium text-stone-800 dark:text-stone-100">
                  {d.deviceName || "—"}
                  {d.current && (
                    <span className="ms-2 rounded-full bg-clay-soft px-2 py-0.5 text-xs text-clay-dark dark:bg-stone-800 dark:text-clay">
                      {t.s_this_device}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{formatDate(d.lastActiveAt)}</p>
              </div>
              {d.current && (
                <Button variant="ghost" onClick={signOutCurrent}>
                  {t.s_sign_out}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <Button variant="ghost" onClick={signOutEverywhere}>
          {t.s_sign_out_all}
        </Button>
      </Section>

      <Section title={t.s_security}>
        <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_2fa_desc}</p>
        {user?.totpEnabled ? (
          <div className="max-w-sm space-y-3">
            <Field
              id="2fa-disable-code"
              label={t.f_code}
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button variant="ghost" onClick={disableTwoFa} disabled={twoFaBusy}>
              {t.s_disable}
            </Button>
          </div>
        ) : setup ? (
          <div className="max-w-sm space-y-3">
            <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
              <p className="text-sm font-medium text-stone-700 dark:text-stone-200">{t.s_secret}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-stone-100 px-2 py-1 text-xs dark:bg-stone-800">
                  {setup.secret}
                </code>
                <Button variant="ghost" onClick={() => copyText(setup.secret)}>
                  {t.s_copied}
                </Button>
              </div>
              <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">{t.s_otpauth_note}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-stone-100 px-2 py-1 text-xs dark:bg-stone-800">
                  {setup.otpauthUrl}
                </code>
                <Button variant="ghost" onClick={() => copyText(setup.otpauthUrl)}>
                  {t.s_copied}
                </Button>
              </div>
            </div>
            <Field
              id="2fa-enable-code"
              label={t.f_code}
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button onClick={enableTwoFa} disabled={twoFaBusy}>
              {t.s_enable}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" onClick={startTwoFaSetup} disabled={twoFaBusy}>
            {t.s_setup}
          </Button>
        )}
        {twoFaMsg && <p className="text-sm text-stone-500 dark:text-stone-400">{twoFaMsg}</p>}
      </Section>

      <Section title={t.s_data}>
        <div>
          <Button variant="ghost" onClick={exportData}>
            {t.s_export}
          </Button>
          {exportMsg && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{exportMsg}</p>}
        </div>
        <div>
          {!confirmingDelete ? (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
              {t.s_delete}
            </Button>
          ) : (
            <div className="max-w-sm space-y-3 rounded-lg border border-red-200 p-4 dark:border-red-900">
              <p className="text-sm text-stone-600 dark:text-stone-300">{t.s_delete_warn}</p>
              <Field
                id="delete-confirm"
                label={t.s_type_confirm}
                value={deleteEmail}
                onChange={(e) => setDeleteEmail(e.target.value)}
              />
              <Field
                id="delete-password"
                label={t.f_password}
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
              />
              {deleteError && <p className="text-sm text-red-600 dark:text-red-400">{deleteError}</p>}
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  onClick={deleteAccount}
                  disabled={!deleteEmail || !deletePassword}
                >
                  {t.s_confirm_delete}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                  {t.s_cancel}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Section>
    </TabShell>
  );
}
