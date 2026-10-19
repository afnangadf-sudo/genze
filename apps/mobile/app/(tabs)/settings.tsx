// Settings tab.
//
// - App language: the five fully-translated UI languages (session choice).
// - Chat language: free BCP-47 input -> PATCH /account/me {preferredLanguage}.
// - Usage: GET /usage/summary in plain language.
// - AI permissions: opens the consent screen in manage mode (revoke = DELETE /chat/consent/:provider).
// - Contact info (support email), app version, sign out.
// - Delete account: typed DELETE + password (or oauthConfirm), then the
//   SecureStore is wiped and the session ends.

import * as React from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { COMMON_LANGUAGES, isValidLanguageCode, languageDisplayName, type UsageSummary } from "@genze/shared";
import appJson from "../../app.json";
import { useLang, LANGS } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import {
  ApiClientError,
  deleteAccount,
  getUsageSummary,
  updateAccount,
} from "../../lib/api";
import { Btn, Card, Err, Field, Header, Loading, Screen } from "../../lib/components";

/**
 * Placeholder support address — replace with the real support mailbox
 * before store submission (see STORE_CHECKLIST.md).
 */
const SUPPORT_EMAIL = "support@genze.app";

function SectionTitle({ children }: { children: string }) {
  const { theme } = useLang();
  return (
    <Text style={{ fontSize: 15, fontWeight: "700", color: theme.text, marginTop: 8 }}>{children}</Text>
  );
}

export default function Settings(): React.JSX.Element {
  const { t, m, lang, setLang, theme, rtl } = useLang();
  const { user, signOut, refreshUser } = useSession();

  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [usageError, setUsageError] = React.useState("");
  const [chatLang, setChatLang] = React.useState(user?.preferredLanguage ?? "en");
  const [chatLangMsg, setChatLangMsg] = React.useState("");
  const [chatLangBusy, setChatLangBusy] = React.useState(false);

  const [delConfirm, setDelConfirm] = React.useState("");
  const [delPassword, setDelPassword] = React.useState("");
  const [delNoPassword, setDelNoPassword] = React.useState(false);
  const [delError, setDelError] = React.useState("");
  const [delBusy, setDelBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    getUsageSummary()
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch((err) => {
        if (!cancelled) setUsageError(err instanceof ApiClientError ? err.message : t.err_generic);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function saveChatLang() {
    const code = chatLang.trim().toLowerCase();
    if (!isValidLanguageCode(code)) {
      setChatLangMsg(m("settings_chat_language_invalid"));
      return;
    }
    setChatLangBusy(true);
    setChatLangMsg("");
    try {
      await updateAccount({ preferredLanguage: code });
      await refreshUser();
      setChatLangMsg(m("settings_chat_language_saved"));
    } catch (err) {
      setChatLangMsg(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setChatLangBusy(false);
    }
  }

  async function doDelete() {
    setDelError("");
    if (delConfirm.trim() !== "DELETE") {
      setDelError(m("delete_type_delete"));
      return;
    }
    setDelBusy(true);
    try {
      if (delNoPassword) {
        await deleteAccount({ oauthConfirm: true });
      } else {
        await deleteAccount({ password: delPassword });
      }
      await signOut();
      // BootGate routes to login; the SecureStore was wiped by deleteAccount.
    } catch (err) {
      setDelError(err instanceof ApiClientError ? err.message : t.err_generic);
    } finally {
      setDelBusy(false);
    }
  }

  const featureName = (f: string): string => {
    switch (f) {
      case "chat":
        return t.u_feat_chat;
      case "research":
        return t.u_feat_research;
      case "agent":
        return t.u_feat_agent;
      case "video":
        return t.u_feat_video;
      case "files":
        return t.u_feat_files;
      default:
        return f;
    }
  };

  const quickLangs = ["es", "fr", "de", "hi", "ps", "zh"].filter((c) => COMMON_LANGUAGES[c]);

  return (
    <Screen>
      <Header title={t.settings_title} />

      <SectionTitle>{m("settings_language")}</SectionTitle>
      <Card>
        {LANGS.map((l) => (
          <Pressable
            key={l.code}
            onPress={() => setLang(l.code)}
            accessibilityRole="button"
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10 }}
          >
            <Text style={{ fontSize: 16, color: theme.text, flex: 1 }}>{l.nativeName}</Text>
            {lang === l.code && <Text style={{ fontSize: 16, color: theme.accent }}>{"\u2713"}</Text>}
          </Pressable>
        ))}
      </Card>

      <SectionTitle>{m("settings_chat_language")}</SectionTitle>
      <Card>
        <Text style={{ fontSize: 14, color: theme.muted }}>{m("settings_chat_language_hint")}</Text>
        <Field
          label={m("settings_chat_language")}
          value={chatLang}
          onChangeText={(v) => {
            setChatLang(v);
            setChatLangMsg("");
          }}
          autoCapitalize="none"
          placeholder="en"
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {quickLangs.map((c) => (
            <Pressable
              key={c}
              onPress={() => setChatLang(c)}
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 16,
                paddingVertical: 6,
                paddingHorizontal: 12,
              }}
            >
              <Text style={{ color: theme.text, fontSize: 14 }}>{COMMON_LANGUAGES[c]}</Text>
            </Pressable>
          ))}
        </View>
        {chatLangMsg ? <Text style={{ fontSize: 13, color: theme.muted }}>{chatLangMsg}</Text> : null}
        <Btn
          title={chatLangBusy ? t.s_loading : m("save")}
          onPress={saveChatLang}
          disabled={chatLangBusy}
        />
        <Text style={{ fontSize: 13, color: theme.muted }}>
          {`${m("current")}: ${languageDisplayName(user?.preferredLanguage ?? "en")}`}
        </Text>
      </Card>

      <SectionTitle>{m("settings_usage")}</SectionTitle>
      <Card>
        {usage === null ? (
          usageError ? (
            <Err message={usageError} />
          ) : (
            <Loading />
          )
        ) : (
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 14, color: theme.muted }}>
              {`${m("settings_usage_day")}: ${usage.day} · ${usage.plan}`}
            </Text>
            {usage.features.map((f) => (
              <View key={f.feature} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 15, color: theme.text }}>{featureName(f.feature)}</Text>
                <Text style={{ fontSize: 15, color: theme.muted }}>
                  {f.cap === null ? m("settings_usage_unlimited") : `${f.used} / ${f.cap}`}
                </Text>
              </View>
            ))}
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 15, color: theme.text }}>{m("settings_usage_credits")}</Text>
              <Text style={{ fontSize: 15, color: theme.muted }}>{usage.credits.balance}</Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 15, color: theme.text }}>{m("settings_usage_cost")}</Text>
              <Text style={{ fontSize: 15, color: theme.muted }}>${usage.costUsdToday.toFixed(4)}</Text>
            </View>
          </View>
        )}
      </Card>

      <SectionTitle>{m("settings_permissions")}</SectionTitle>
      <Card>
        <Text style={{ fontSize: 14, color: theme.muted }}>{m("settings_permissions_sub")}</Text>
        <Btn title={m("settings_permissions")} variant="ghost" onPress={() => router.push("/ai-consent?mode=manage")} />
      </Card>

      <SectionTitle>{m("settings_contact")}</SectionTitle>
      <Card>
        <Text style={{ fontSize: 14, color: theme.muted }}>{m("settings_contact_sub")}</Text>
        <Pressable onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
          <Text style={{ fontSize: 15, color: theme.accent }}>{SUPPORT_EMAIL}</Text>
        </Pressable>
      </Card>

      <SectionTitle>{m("settings_delete")}</SectionTitle>
      <Card>
        <Text style={{ fontSize: 14, color: theme.muted }}>{m("settings_delete_sub")}</Text>
        <Field
          label={m("settings_delete_confirm_word")}
          value={delConfirm}
          onChangeText={setDelConfirm}
          autoCapitalize="characters"
          placeholder="DELETE"
        />
        {!delNoPassword && (
          <Field
            label={m("settings_delete_password")}
            value={delPassword}
            onChangeText={setDelPassword}
            secure
          />
        )}
        <Pressable
          onPress={() => setDelNoPassword((v) => !v)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: delNoPassword ? theme.accent : "transparent",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {delNoPassword && <Text style={{ color: theme.accentText, fontSize: 14 }}>{"\u2713"}</Text>}
          </View>
          <Text style={{ fontSize: 14, color: theme.text, flex: 1 }}>{m("settings_delete_no_password")}</Text>
        </Pressable>
        <Err message={delError} />
        <Btn
          title={delBusy ? t.s_loading : m("settings_delete")}
          variant="danger"
          onPress={doDelete}
          disabled={delBusy}
        />
      </Card>

      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 13, color: theme.muted }}>
          {`${m("settings_version")} ${appJson.expo.version}`}
        </Text>
        <Pressable onPress={() => signOut()}>
          <Text style={{ fontSize: 15, color: theme.danger }}>{m("settings_sign_out")}</Text>
        </Pressable>
      </View>
      <Text style={{ fontSize: 13, color: theme.muted, textAlign: rtl ? "right" : "left" }}>{user?.email}</Text>
    </Screen>
  );
}
