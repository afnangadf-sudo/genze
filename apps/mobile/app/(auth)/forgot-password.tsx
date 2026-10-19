import * as React from "react";
import { Text } from "react-native";
import { useLang } from "../../lib/i18n";
import { ApiClientError, forgotPassword } from "../../lib/api";
import { Btn, Err, Field, Screen } from "../../lib/components";

export default function ForgotPassword(): React.JSX.Element {
  const { t, theme } = useLang();
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await forgotPassword(email.trim());
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text }}>{t.forgot_title}</Text>
      {done ? (
        <Text style={{ fontSize: 15, color: theme.muted }}>{t.forgot_sent}</Text>
      ) : (
        <>
          <Field label={t.f_email} value={email} onChangeText={setEmail} keyboard="email-address" />
          <Err message={error} />
          <Btn title={busy ? t.s_loading : t.forgot_submit} onPress={submit} disabled={busy} />
        </>
      )}
    </Screen>
  );
}
