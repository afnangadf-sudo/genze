"use client";

import type { ProviderAdminStatus } from "@genze/shared";
import type { Strings } from "../../lib/i18n";
import { Button } from "../../components/Button";

/** "anthropic" -> "Anthropic". Provider ids are lowercase by contract. */
function providerName(id: string): string {
  return id.length > 0 ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

/**
 * Presentational owner-admin board. Pure render from props so the
 * visibility rules are unit-testable without a browser session.
 */
export function AdminView({
  t,
  isOwner,
  providers,
  busyId,
  onToggle,
}: {
  t: Strings;
  isOwner: boolean;
  providers: ProviderAdminStatus[];
  busyId: string | null;
  onToggle: (p: ProviderAdminStatus) => void;
}) {
  if (!isOwner) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">{t.a_not_available}</p>;
  }
  return (
    <ul className="space-y-3">
      {providers.map((p) => {
        const envLocked = p.killedBy === "env";
        return (
          <li
            key={p.id}
            className="rounded-xl border border-stone-200 px-4 py-3 dark:border-stone-800"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-stone-800 dark:text-stone-100">
                  {providerName(p.id)}
                </p>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  {p.configured ? t.a_configured : t.a_not_configured}
                  {" · "}
                  {p.enabled ? t.a_on : t.a_off}
                  {p.killedBy !== null && (
                    <>
                      {" "}
                      ({t.a_stopped_by}{" "}
                      {p.killedBy === "env" ? t.a_by_server : t.a_by_page})
                    </>
                  )}
                </p>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  {t.a_regions}: {p.regions.length > 0 ? p.regions.join(", ") : "—"}
                </p>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  {t.a_can_do}: {p.capabilities.length > 0 ? p.capabilities.join(", ") : "—"}
                </p>
              </div>
              <div className="shrink-0 text-end">
                <Button
                  variant="ghost"
                  disabled={envLocked || busyId === p.id}
                  onClick={() => onToggle(p)}
                >
                  {p.enabled ? t.s_disable : t.s_enable}
                </Button>
                {envLocked && (
                  <p className="mt-1 max-w-[10rem] text-xs text-stone-500 dark:text-stone-400">
                    {t.a_env_locked}
                  </p>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
