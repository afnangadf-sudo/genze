"use client";

import { useTheme } from "../lib/theme";
import { useLang } from "../lib/lang";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const { t } = useLang();
  const label = theme === "dark" ? t.theme_light : t.theme_dark;
  return (
    <button
      onClick={toggle}
      title={t.theme_label}
      aria-label={t.theme_label}
      className="rounded-lg p-2 text-stone-500 transition-colors hover:bg-stone-200/60 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
    >
      {theme === "dark" ? (
        // sun
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // moon
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
        </svg>
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}
