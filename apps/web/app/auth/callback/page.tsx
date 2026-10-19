"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setTokens } from "../../../lib/auth";
import { useLang } from "../../../lib/lang";

function CallbackInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { t } = useLang();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const accessToken = params.get("accessToken");
    const refreshToken = params.get("refreshToken");
    if (accessToken && refreshToken) {
      setTokens(accessToken, refreshToken);
      router.replace("/chat");
    } else {
      setFailed(true);
    }
  }, [params, router]);

  return (
    <p className="text-center text-stone-500 dark:text-stone-400">
      {failed ? t.callback_failure : t.callback_working}
    </p>
  );
}

export default function AuthCallbackPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <Suspense>
        <CallbackInner />
      </Suspense>
    </main>
  );
}
