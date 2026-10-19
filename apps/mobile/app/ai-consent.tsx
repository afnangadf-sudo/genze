// AI consent screen (Apple 5.1.2(i)) — shown on first launch after login,
// BEFORE any AI request, and re-opened from Settings ("AI permissions") in
// manage mode. A 403 CONSENT_REQUIRED that arrives mid-chat also routes
// here.
//
// Content mirrors the web consent page: every provider comes from
// GET /chat/consent (name + plain-language whatSees), per-provider
// Allow/Withdraw. The app-level notice is recorded with
// PATCH /account/me {aiNoticeAccepted:true} (best effort — the backend
// field is part of the Step 10 contract) and, as the on-device source of
// truth, in SecureStore per user.
//
// Declining (Skip for now) keeps the non-AI features usable — Library,
// Settings, and anything that never calls an AI provider. Chat will hit
// 403 CONSENT_REQUIRED and route back here.

import * as React from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { ConsentProviderStatus } from "@genze/shared";
import { useLang } from "../lib/i18n";
import { useSession } from "../lib/session";
import {
  ApiClientError,
  getConsent,
  grantConsent,
  revokeConsent,
  updateAccount,
} from "../lib/api";
import { Btn, Card, Err, Header, Loading, Screen } from "../lib/components";

export default function AiConsent(): React.JSX.Element {
  const { t, m, theme } = useLang();
  const { markAiConsentSeen } = useSession();
  const params = useLocalSearchParams<{ mode?: string }>();
  const manage = params.mode === "manage";

  const [providers, setProviders] = React.useState<ConsentProviderStatus[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [finishing, setFinishing] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      setProviders(await getConsent());
    } catch (err) {
      setProviders([]);
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function allow(id: string) {
    setError("");
    setBusyId(id);
    try {
      await grantConsent([id]);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  async function withdraw(id: string) {
    setError("");
    setBusyId(id);
    try {
      await revokeConsent(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  async function recordNotice() {
    // App-level notice for the Step 10 backend contract. Best effort: the
    // field may not exist server-side yet — the SecureStore flag below is
    // the source of truth on this device either way.
    try {
      await updateAccount({ aiNoticeAccepted: true });
    } catch {
      /* backend field pending — local flag still records the notice */
    }
    await markAiConsentSeen();
  }

  async function finish() {
    setError("");
    setFinishing(true);
    try {
      await recordNotice();
      router.replace("/(tabs)/chat");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setFinishing(false);
    }
  }

  async function allowAllAndFinish() {
    setError("");
    setFinishing(true);
    try {
      const required = (providers ?? []).filter((p) => p.required && !p.granted);
      if (required.length > 0) await grantConsent(required.map((p) => p.id));
      await recordNotice();
      router.replace("/(tabs)/chat");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setFinishing(false);
    }
  }

  const required = (providers ?? []).filter((p) => p.required);

  return (
    <Screen>
      <Header
        title={manage ? t.consent_title : m("consent_first_title")}
        right={manage ? <Btn title={m("back")} variant="ghost" onPress={() => router.back()} /> : undefined}
      />
      <Text style={{ fontSize: 15, lineHeight: 22, color: theme.muted }}>
        {manage ? t.consent_manage_sub : m("consent_first_sub")}
      </Text>

      {providers === null ? (
        <Loading />
      ) : required.length === 0 ? (
        <Card>
          <Text style={{ fontSize: 15, color: theme.muted }}>
            {manage ? t.consent_none_needed : m("consent_demo_note")}
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {required.map((p) => (
            <Card key={p.id}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 16, fontWeight: "600", color: theme.text, flex: 1 }}>{p.name}</Text>
                {p.granted && (
                  <Text style={{ fontSize: 12, fontWeight: "600", color: theme.success }}>
                    {t.consent_allowed}
                  </Text>
                )}
              </View>
              <Text style={{ fontSize: 14, lineHeight: 20, color: theme.muted }}>{p.whatSees}</Text>
              {p.granted ? (
                <Btn
                  title={busyId === p.id ? t.s_loading : t.consent_withdraw}
                  variant="ghost"
                  disabled={busyId !== null}
                  onPress={() => withdraw(p.id)}
                />
              ) : (
                <Btn
                  title={busyId === p.id ? t.s_loading : t.consent_allow}
                  disabled={busyId !== null}
                  onPress={() => allow(p.id)}
                />
              )}
            </Card>
          ))}
        </View>
      )}

      <Err message={error} />

      {!manage && (
        <>
          <Btn
            title={finishing ? t.s_loading : `${t.consent_allow_all} — ${m("consent_continue")}`}
            onPress={allowAllAndFinish}
            disabled={finishing || providers === null}
          />
          <Btn title={m("consent_skip")} variant="ghost" onPress={finish} disabled={finishing} />
        </>
      )}
    </Screen>
  );
}
