"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { API_ROUTES } from "@genze/shared";
import { apiFetch } from "../../lib/auth";
import { useLang } from "../../lib/lang";
import { LangSwitch } from "../../components/LangSwitch";
import { ThemeToggle } from "../../components/ThemeToggle";

function VerifyInner() {
  const params = useSearchParams();
  const { t } = useLang();
  const [state, setState] = useState<"working" | "ok" | "fail">("working");

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setState("fail");
      return;
    }
    apiFetch(API_ROUTES.verifyEmail, {
      method: "POST",
      skipRefresh: true,
      body: JSON.stringify({ token }),
    })
      .then(() => setState("ok"))
      .catch(() => setState("fail"));
  }, [params]);

  return (
    <div className="text-center">
      {state === "working" && <p className="text-stone-500 dark:text-stone-400">{t.verify_working}</p>}
      {state === "ok" && (
        <>
          <p className="text-stone-700 dark:text-stone-200">{t.verify_success}</p>
          <Link
            href="/login"
            className="mt-8 inline-block rounded-lg bg-clay px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-clay-dark"
          >
            {t.back_to_login}
          </Link>
        </>
      )}
      {state === "fail" && <p className="text-stone-700 dark:text-stone-200">{t.verify_failure}</p>}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-end gap-2 px-6 py-4">
        <LangSwitch />
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-sm">
          <Suspense>
            <VerifyInner />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
