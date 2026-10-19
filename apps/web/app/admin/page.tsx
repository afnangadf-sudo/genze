"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_ROUTES, type ProviderAdminStatus, type PublicUser } from "@genze/shared";
import { apiFetch, getTokens, ApiClientError } from "../../lib/auth";
import { useLang } from "../../lib/lang";
import { TabShell } from "../../components/TabShell";
import { getProviderAdmin, setProviderKilled } from "../../lib/usage";
import { AdminView } from "./AdminView";

export default function AdminPage() {
  const router = useRouter();
  const { t } = useLang();

  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const [providers, setProviders] = useState<ProviderAdminStatus[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!getTokens().access) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const me = await apiFetch<PublicUser>(API_ROUTES.me);
        // Fail closed: anything but an explicit true keeps the board hidden.
        const owner = me.isOwner === true;
        setIsOwner(owner);
        if (owner) setProviders(await getProviderAdmin());
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 403) {
          // Not the owner — the plain "not available" note covers this.
          setIsOwner(false);
        } else {
          setError(err instanceof ApiClientError ? err.message : t.err_generic);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [router, t]);

  /** Flip one provider's kill switch. Instantly reversible, so no confirm. */
  async function toggle(p: ProviderAdminStatus) {
    if (p.killedBy === "env" || busyId) return;
    setBusyId(p.id);
    setError("");
    try {
      const updated = await setProviderKilled(p.id, p.enabled);
      setProviders((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <TabShell>
      <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
        {t.a_title}
      </h1>
      <div className="mt-6">
        {loading ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
        ) : error ? (
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        ) : (
          <AdminView
            t={t}
            isOwner={isOwner}
            providers={providers}
            busyId={busyId}
            onToggle={toggle}
          />
        )}
      </div>
    </TabShell>
  );
}
