"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { API_ROUTES, type PublicUser } from "@genze/shared";
import { apiFetch, getTokens } from "./auth";
import { STRINGS, isLang, langDir, type Lang, type Strings } from "./i18n";

// Re-exported so components import everything language-related from one place.
export { LANGS, isLang, langDir, type Lang, type Strings } from "./i18n";

const STORAGE_KEY = "genze_lang";

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: Strings }>({
  lang: "en",
  setLang: () => {},
  t: STRINGS.en,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  // Boot order: a saved per-session choice wins; otherwise, when logged in,
  // the UI language defaults to the user's server-side preferredLanguage.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    if (isLang(saved)) {
      setLangState(saved);
      return;
    }
    if (!getTokens().access) return;
    let cancelled = false;
    apiFetch<PublicUser>(API_ROUTES.me)
      .then((me) => {
        if (!cancelled && isLang(me.preferredLanguage)) setLangState(me.preferredLanguage);
      })
      .catch(() => {
        /* backend may not have the route yet — stay on the default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = langDir(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* storage unavailable */
    }
  }, [lang]);

  return (
    <LangContext.Provider value={{ lang, setLang: setLangState, t: STRINGS[lang] }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}
