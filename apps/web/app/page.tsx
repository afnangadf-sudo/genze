"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isLoggedIn } from "../lib/auth";
import { useLang } from "../lib/lang";
import { LangSwitch } from "../components/LangSwitch";
import { ThemeToggle } from "../components/ThemeToggle";

export default function HomePage() {
  const router = useRouter();
  const { t } = useLang();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) {
      router.replace("/chat");
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) return null;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-end gap-2 px-6 py-4">
        <LangSwitch />
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
            {t.welcome_title}
          </h1>
          <p className="mt-3 text-stone-500 dark:text-stone-400">{t.welcome_sub}</p>
          <div className="mt-8 flex flex-col gap-3">
            <Link
              href="/login"
              className="rounded-lg bg-clay px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-clay-dark"
            >
              {t.login_btn}
            </Link>
            <Link
              href="/signup"
              className="rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-200/50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              {t.signup_btn}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
