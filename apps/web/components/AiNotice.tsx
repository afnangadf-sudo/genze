"use client";

import { useLang } from "../lib/lang";

export function AiNotice() {
  const { t } = useLang();
  return <p className="text-xs text-stone-500 dark:text-stone-400">{t.ai_notice}</p>;
}
