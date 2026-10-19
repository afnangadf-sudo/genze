// OAuth return handler for the genze:// scheme.
//
// Google sign-in opens the system browser on the backend's OAuth start URL.
// The backend currently 302s to the WEB callback (${APP_URL}/auth/callback)
// with ?accessToken=&refreshToken= — see signInWithGoogle in lib/session.tsx
// for the documented contract gap. The moment the backend honors
// ?redirect_uri=genze://auth/callback, the OS delivers that URL here and
// this screen stores the tokens; BootGate then routes into the app.

import * as React from "react";
import { Linking, Text } from "react-native";
import { useLang } from "../../lib/i18n";
import { setTokens } from "../../lib/api";
import { Screen } from "../../lib/components";

function tokensFromUrl(url: string): { access: string; refresh: string } | null {  const qIndex = url.indexOf("?");
  if (qIndex < 0) return null;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  const access = params.get("accessToken");
  const refresh = params.get("refreshToken");
  return access && refresh ? { access, refresh } : null;
}

export default function AuthCallback(): React.JSX.Element {
  const { t, theme } = useLang();
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const handle = async (url: string | null | undefined) => {
      if (!url || cancelled) return;
      const tokens = tokensFromUrl(url);
      if (tokens) {
        await setTokens(tokens.access, tokens.refresh);
        // BootGate picks the session up on the next render — nothing else to do.
      } else {
        setFailed(true);
      }
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => void handle(e.url));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return (
    <Screen>
      <Text style={{ textAlign: "center", color: theme.muted, marginTop: 48 }}>
        {failed ? t.callback_failure : t.callback_working}
      </Text>
    </Screen>
  );
}
