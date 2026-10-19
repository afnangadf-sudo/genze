"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLang } from "../lib/lang";
import { ThemeToggle } from "./ThemeToggle";
import { LangSwitch } from "./LangSwitch";

function Icon({ path }: { path: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}

const ICONS: Record<string, string> = {
  chat: "M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z",
  research: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  write: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z",
  agent: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z",
  studio: "M4 16l4-11 4 7 4-7 4 11H4zM4 20h16",
  library: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
};

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useLang();

  const tabs = [
    { href: "/chat", label: t.tab_chat, icon: ICONS.chat },
    { href: "/research", label: t.tab_research, icon: ICONS.research },
    { href: "/write", label: t.tab_write, icon: ICONS.write },
    { href: "/agent", label: t.tab_agent, icon: ICONS.agent },
    { href: "/studio", label: t.tab_studio, icon: ICONS.studio },
    { href: "/library", label: t.tab_library, icon: ICONS.library },
  ];

  return (
    <aside className="flex w-60 shrink-0 flex-col border-e border-stone-200 bg-white/60 dark:border-stone-800 dark:bg-stone-900/40">
      <div className="flex items-center px-5 pt-6 pb-4">
        <Link href="/" className="text-lg font-semibold tracking-tight text-stone-800 dark:text-stone-100">
          {t.app_name}
        </Link>
      </div>
      <nav className="flex-1 space-y-1 px-3" aria-label={t.app_name}>
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                active
                  ? "bg-clay-soft font-medium text-clay-dark dark:bg-stone-800 dark:text-clay"
                  : "text-stone-600 hover:bg-stone-200/50 dark:text-stone-300 dark:hover:bg-stone-800/60"
              }`}
            >
              <Icon path={tab.icon} />
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="flex items-center justify-between gap-2 border-t border-stone-200 px-4 py-3 dark:border-stone-800">
        <Link
          href="/settings"
          className="rounded-lg px-2 py-1.5 text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
        >
          {t.settings_title}
        </Link>
        <div className="flex items-center gap-1">
          <LangSwitch />
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
