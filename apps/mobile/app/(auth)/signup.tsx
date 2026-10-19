import * as React from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { useLang } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { ApiClientError } from "../../lib/api";
import { Btn, Err, Field, Screen } from "../../lib/components";

export default function Signup(): React.JSX.Element {
  const { t, m, theme } = useLang();
  const { signUp } = useSession();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [country, setCountry] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState(false);

  async function submit() {
    setError("");
    if (password.length < 8) {
      setError(t.err_password_short);
      return;
    }
    setBusy(true);
    try {
      await signUp(email, password, country);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.text }}>{t.signup_done_title}</Text>
        <Text style={{ fontSize: 15, color: theme.muted }}>{t.signup_done_text}</Text>
        <Btn title={m("verify_title")} variant="ghost" onPress={() => router.push("/(auth)/verify-email")} />
        <Text style={{ color: theme.accent }} onPress={() => router.replace("/(auth)/login")}>
          {t.signup_login}
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text }}>{t.signup_title}</Text>
      <Field label={t.f_email} value={email} onChangeText={setEmail} keyboard="email-address" />
      <Field
        label={t.f_password}
        value={password}
        onChangeText={setPassword}
        secure
        placeholder={t.signup_password_hint}
      />
      <Field
        label={t.f_country}
        value={country}
        onChangeText={setCountry}
        autoCapitalize="characters"
        placeholder="PK"
      />
      <Err message={error} />
      <Btn title={busy ? t.s_loading : t.signup_submit} onPress={submit} disabled={busy} />
      <Text style={{ color: theme.muted }}>
        {t.signup_have_account}{" "}
        <Text style={{ color: theme.accent }} onPress={() => router.replace("/(auth)/login")}>
          {t.signup_login}
        </Text>
      </Text>
    </Screen>
  );
}
