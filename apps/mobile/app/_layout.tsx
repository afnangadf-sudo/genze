// Root layout: providers + boot routing.
//
//  - logged out  -> /(auth)/login
//  - logged in but AI consent not seen on this device -> /ai-consent
//  - otherwise -> /(tabs)/chat
// A 403 CONSENT_REQUIRED mid-chat routes back to /ai-consent from the chat
// screen; that screen works in "manage" mode from Settings too.

import * as React from "react";
import { Text, View } from "react-native";
import { Stack, router, useGlobalSearchParams, useSegments } from "expo-router";
import { LangProvider, useLang } from "../lib/i18n";
import { SessionProvider, useSession } from "../lib/session";

function BootGate(): React.JSX.Element {
  const { status, aiConsentSeen } = useSession();
  const { theme, t, rtl } = useLang();
  const segments = useSegments();
  const params = useGlobalSearchParams<{ mode?: string }>();
  const [consentChecked, setConsentChecked] = React.useState(false);

  React.useEffect(() => {
    if (status === "loading") return;
    let cancelled = false;
    (async () => {
      const inAuth = segments[0] === "(auth)";
      const inTabs = segments[0] === "(tabs)";
      const onConsent = segments[0] === "ai-consent";
      const manageMode = onConsent && params.mode === "manage";
      if (status === "logged-out") {
        setConsentChecked(true);
        if (!inAuth && segments[0] !== "auth") router.replace("/(auth)/login");
        return;
      }
      // logged in
      const seen = await aiConsentSeen();
      if (cancelled) return;
      setConsentChecked(true);
      if (!seen && !onConsent) {
        router.replace("/ai-consent");
      } else if (seen && !manageMode && (inAuth || segments.length === 0 || onConsent)) {
        router.replace("/(tabs)/chat");
      } else if (seen && !manageMode && !inTabs && !onConsent && segments[0] !== "auth") {
        router.replace("/(tabs)/chat");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, segments, params.mode, aiConsentSeen]);

  if (status === "loading" || (status === "logged-in" && !consentChecked)) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.background,
          direction: rtl ? "rtl" : "ltr",
        }}
      >
        <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text }}>{t.app_name}</Text>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="ai-consent" />
      <Stack.Screen name="auth/callback" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

export default function RootLayout(): React.JSX.Element {
  return (
    <LangProvider>
      <SessionProvider>
        <BootGate />
      </SessionProvider>
    </LangProvider>
  );
}
