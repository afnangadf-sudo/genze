"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { Gem } from "@genze/shared";
import { cloneSharedGem } from "../../../../lib/gems";
import { getTokens } from "../../../../lib/auth";
import { useLang } from "../../../../lib/lang";
import { friendlyErrText } from "../../../../lib/usage";
import { TabShell } from "../../../../components/TabShell";
import { Button } from "../../../../components/Button";

/**
 * A share-link landing page. The contract has no read-only preview endpoint —
 * the only route is POST /gems/shared/:token, which clones into the caller's
 * account — so the gem's name + description are shown from the clone
 * response, after the user explicitly taps "Add to my Gems".
 */
export default function SharedGemPage() {
  const { lang, t } = useLang();
  const router = useRouter();
  const params = useParams();
  const token = typeof params?.token === "string" ? params.token : "";

  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Gem | null>(null);
  const [dead, setDead] = useState(false);
  const [error, setError] = useState("");

  const loggedIn = !!getTokens().access;
  useEffect(() => {
    if (!loggedIn && token) router.replace(`/login?next=${encodeURIComponent(`/gems/shared/${token}`)}`);
  }, [loggedIn, router, token]);

  async function addToMyGems() {
    if (!token || busy) return;
    setBusy(true);
    setError("");
    setDead(false);
    try {
      const gem = await cloneSharedGem(token);
      setAdded(gem);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "NOT_FOUND") {
        setDead(true);
      } else {
        setError(friendlyErrText(lang, t, err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <TabShell>
      <div className="mx-auto max-w-lg py-10">
        {dead ? (
          <p className="text-center text-[15px] text-stone-600 dark:text-stone-300">
            {t.gm_shared_dead}
          </p>
        ) : added ? (
          <div className="text-center">
            <p className="text-sm text-stone-500 dark:text-stone-400">{t.gm_shared_added}</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
              {added.name}
            </h1>
            {added.description && (
              <p className="mt-2 text-[15px] text-stone-500 dark:text-stone-400">
                {added.description}
              </p>
            )}
            <div className="mt-6">
              <Link href="/settings#gems">
                <Button>{t.gm_shared_go}</Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
              {t.gm_shared_heading}
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-[15px] text-stone-500 dark:text-stone-400">
              {t.gm_share_hint}
            </p>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="mt-6">
              <Button onClick={addToMyGems} disabled={busy || !token}>
                {busy ? t.gm_shared_adding : t.gm_shared_add}
              </Button>
            </div>
          </div>
        )}
      </div>
    </TabShell>
  );
}
