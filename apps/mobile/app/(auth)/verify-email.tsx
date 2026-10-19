// Email verification. The verification email links to the web app; the
// token can also be pasted here (raw token or the full link — the token is
// extracted from a `token=` query parameter when a link is pasted).

import * as React from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { useLang } from "../../lib/i18n";
import { ApiClientError, verifyEmail } from "../../lib/api";
import { Btn, Err, Field, Screen } from "../../lib/components";

function extractToken(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/[?&]token=([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : trimmed;
}

export default function VerifyEmail(): React.JSX.Element {
  const { t, m, theme } = useLang();
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await verifyEmail(extractToken(token));
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text }}>{m("verify_title")}</Text>
      {done ? (
        <>
          <Text style={{ fontSize: 15, color: theme.muted }}>{t.verify_success}</Text>
          <Btn title={t.login_btn} onPress={() => router.replace("/(auth)/login")} />
        </>
      ) : (
        <>
          <Field label={t.f_code} value={token} onChangeText={setToken} placeholder={m("verify_hint")} />
          <Err message={error} />
          <Btn title={busy ? t.verify_working : m("verify_submit")} onPress={submit} disabled={busy} />
        </>
      )}
    </Screen>
  );
}
