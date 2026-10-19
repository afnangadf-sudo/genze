"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { completeConnectorCallback, completeCustomConnectorCallback } from "../../../../lib/connectors";
import { getTokens } from "../../../../lib/auth";
import { useLang } from "../../../../lib/lang";
import { TabShell } from "../../../../components/TabShell";
import { Button } from "../../../../components/Button";

/**
 * Landing page after a connector's OAuth flow: finishes the handshake
 * (?connector=&code=&state=) and shows a plain result — no pop-ups.
 * Handles both built-in connector slugs and custom connector uuids.
 */
function CallbackContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useLang();
  const [state, setState] = useState<"working" | "ok" | "failed">("working");

  useEffect(() => {
    if (!getTokens().access) {
      router.replace("/login");
      return;
    }
    const connector = params.get("connector") ?? "";
    const code = params.get("code") ?? "";
    const st = params.get("state") ?? "";
    if (!connector || !code || !st) {
      setState("failed");
      return;
    }
    let cancelled = false;
    // Custom (user-registered) connectors carry a uuid id; built-ins carry a
    // short slug. Both finish here so the vendor needs only one redirect URI.
    const finish =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connector)
        ? completeCustomConnectorCallback
        : completeConnectorCallback;
    finish(connector, code, st)
      .then((ok) => {
        if (!cancelled) setState(ok ? "ok" : "failed");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, router]);

  return (
    <div className="mx-auto max-w-md text-center">
      <h1 className="text-xl font-semibold text-stone-800 dark:text-stone-100">{t.c_cb_title}</h1>
      {state === "working" && (
        <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
      )}
      {state === "ok" && <p className="mt-4 text-sm text-stone-600 dark:text-stone-300">{t.c_cb_success}</p>}
      {state === "failed" && (
        <p className="mt-4 text-sm text-red-700 dark:text-red-400">{t.c_cb_failed}</p>
      )}
      {state !== "working" && (
        <div className="mt-6">
          <Button onClick={() => router.push("/settings")}>{t.c_back_settings}</Button>
        </div>
      )}
    </div>
  );
}

export default function ConnectorCallbackPage() {
  return (
    <TabShell>
      <Suspense fallback={null}>
        <CallbackContent />
      </Suspense>
    </TabShell>
  );
}
