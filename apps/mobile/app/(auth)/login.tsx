// Login: password, Google (system browser), and Sign in with Apple (iOS).

import * as React from "react";
import { Platform, Text, View } from "react-native";
import { router } from "expo-router";
import { useLang } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { ApiClientError } from "../../lib/api";
import { Btn, Err, Field, Screen } from "../../lib/components";

export default function Login(): React.JSX.Element {
  const { t, m, theme } = useLang();
  const { signIn, signInWithApple, signInWithGoogle } = useSession();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  async function run(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "INVALID_CREDENTIALS") setError(t.err_invalid_credentials);
        else if (err.code === "EMAIL_NOT_VERIFIED") setError(t.err_not_verified);
        else if (err.code === "APPLE_UNAVAILABLE") setError(m("login_apple_unavailable"));
        else setError(err.message || t.err_generic);
      } else {
        setError(t.err_generic);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text }}>{t.login_title}</Text>
      <Field label={t.f_email} value={email} onChangeText={setEmail} keyboard="email-address" />
      <Field label={t.f_password} value={password} onChangeText={setPassword} secure />
      <Err message={error} />
      <Btn title={busy ? t.s_loading : t.login_submit} onPress={() => run(() => signIn(email, password))} disabled={busy} />

      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.border }} />
        <Text style={{ color: theme.muted }}>{m("auth_or")}</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.border }} />
      </View>

      <Btn title={t.login_google} variant="ghost" onPress={() => run(signInWithGoogle)} disabled={busy} />
      {Platform.OS === "ios" && (
        <Btn title={m("login_apple")} variant="ghost" onPress={() => run(signInWithApple)} disabled={busy} />
      )}

      <View style={{ flexDirection: "row", gap: 16, justifyContent: "center" }}>
        <Text style={{ color: theme.accent }} onPress={() => router.push("/(auth)/forgot-password")}>
          {t.login_forgot}
        </Text>
        <Text style={{ color: theme.accent }} onPress={() => router.push("/(auth)/signup")}>
          {t.login_create_account}
        </Text>
      </View>
    </Screen>
  );
}
