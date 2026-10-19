// Shared mobile UI pieces. Plain language, no pop-ups, no technical words.
// Layouts use flex and start/end alignment only — never left/right — so
// RTL languages (ur/ar/fa) render correctly.

import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLang } from "./i18n";
import { ApiClientError, reportContent, type ReportTargetType } from "./api";

export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}): React.JSX.Element {
  const { theme, rtl } = useLang();
  const body = (
    <View style={[styles.screenInner, { direction: rtl ? "rtl" : "ltr" }]}>{children}</View>
  );
  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.screenInner}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

export function Header({ title, right }: { title: string; right?: React.ReactNode }): React.JSX.Element {
  const { theme } = useLang();
  return (
    <View style={styles.headerRow}>
      <Text style={[styles.headerTitle, { color: theme.text }]}>{title}</Text>
      {right}
    </View>
  );
}

export function Btn({
  title,
  onPress,
  variant = "primary",
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}): React.JSX.Element {
  const { theme } = useLang();
  const bg =
    variant === "primary" ? theme.accent : variant === "danger" ? theme.danger : "transparent";
  const fg = variant === "ghost" ? theme.accent : theme.accentText;
  const border = variant === "ghost" ? { borderWidth: 1, borderColor: theme.border } : null;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[styles.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }, border]}
    >
      <Text style={[styles.btnText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  secure = false,
  keyboard = "default",
  autoCapitalize = "none",
  placeholder,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secure?: boolean;
  keyboard?: "default" | "email-address" | "numeric";
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  placeholder?: string;
  multiline?: boolean;
}): React.JSX.Element {
  const { theme, rtl } = useLang();
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        keyboardType={keyboard}
        autoCapitalize={autoCapitalize}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        multiline={multiline}
        textAlign={rtl ? "right" : "left"}
        style={[
          styles.fieldInput,
          {
            color: theme.text,
            borderColor: theme.border,
            backgroundColor: theme.card,
            minHeight: multiline ? 96 : 48,
            textAlignVertical: multiline ? "top" : "center",
          },
        ]}
      />
    </View>
  );
}

export function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { theme } = useLang();
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      {children}
    </View>
  );
}

export function Err({ message }: { message: string }): React.JSX.Element | null {
  const { theme } = useLang();
  if (!message) return null;
  return <Text style={[styles.err, { color: theme.danger }]}>{message}</Text>;
}

export function Loading(): React.JSX.Element {
  const { theme } = useLang();
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.accent} />
    </View>
  );
}

/** Visible "Made with AI" marker — shown under every AI-generated item. */
export function MadeWithAi(): React.JSX.Element {
  const { theme, m } = useLang();
  return (
    <Text style={[styles.aiLabel, { color: theme.muted }]}>
      {"\u2726 "}
      {m("made_with_ai")}
    </Text>
  );
}

/** Per-item report button → POST /moderation/report. Inline result, no pop-up. */
export function ReportButton({
  targetType,
  targetId,
}: {
  targetType: ReportTargetType;
  targetId: string;
}): React.JSX.Element {
  const { theme, m, t } = useLang();
  const [state, setState] = React.useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = React.useState("");

  async function send() {
    if (state === "sending" || state === "sent") return;
    setState("sending");
    setError("");
    try {
      await reportContent(targetType, targetId);
      setState("sent");
    } catch (err) {
      setState("error");
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    }
  }

  if (state === "sent") {
    return (
      <Text style={[styles.aiLabel, { color: theme.success }]}>{m("report_sent")}</Text>
    );
  }
  return (
    <View>
      <Pressable onPress={send} disabled={state === "sending"} accessibilityRole="button">
        <Text style={[styles.reportLink, { color: theme.muted }]}>
          {state === "sending" ? t.s_loading : m("report")}
        </Text>
      </Pressable>
      {state === "error" && <Text style={[styles.aiLabel, { color: theme.danger }]}>{error}</Text>}
    </View>
  );
}

/** Honest "coming soon" card for Research / Write / Studio on mobile. */
export function ComingSoon({ title, body }: { title: string; body: string }): React.JSX.Element {
  const { theme, m } = useLang();
  return (
    <Screen>
      <Header title={title} />
      <Card>
        <Text style={[styles.comingTitle, { color: theme.text }]}>{m("coming_soon")}</Text>
        <Text style={[styles.comingBody, { color: theme.muted }]}>{body}</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenInner: { padding: 20, gap: 16, flexGrow: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  headerTitle: { fontSize: 24, fontWeight: "700" },
  btn: {
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { fontSize: 16, fontWeight: "600" },
  fieldWrap: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "500" },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 },
  err: { fontSize: 14 },
  aiLabel: { fontSize: 12 },
  reportLink: { fontSize: 12, textDecorationLine: "underline" },
  comingTitle: { fontSize: 18, fontWeight: "700" },
  comingBody: { fontSize: 15, lineHeight: 22 },
});
