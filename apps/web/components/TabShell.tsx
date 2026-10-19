"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { AiNotice } from "./AiNotice";

export function TabShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? "max-w-6xl" : "max-w-3xl";
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex flex-1 flex-col">
        <div className={`mx-auto w-full ${width} flex-1 px-6 py-10`}>{children}</div>
        <footer className="border-t border-stone-200 px-6 py-4 dark:border-stone-800">
          <div className={`mx-auto ${width}`}>
            <AiNotice />
          </div>
        </footer>
      </main>
    </div>
  );
}
