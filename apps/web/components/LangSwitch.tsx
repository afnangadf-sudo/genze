"use client";

import { LANGS, useLang, type Lang } from "../lib/lang";

export function LangSwitch() {
  const { lang, setLang, t } = useLang();
  return (
    <label className="inline-flex items-center">
      <span className="sr-only">{t.lang_label}</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        aria-label={t.lang_label}
        className="cursor-pointer rounded-lg border border-stone-300 bg-transparent px-2 py-1.5 text-xs font-medium text-stone-600 outline-none transition-colors hover:text-stone-800 focus:border-clay dark:border-stone-700 dark:text-stone-300 dark:hover:text-stone-100"
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}
