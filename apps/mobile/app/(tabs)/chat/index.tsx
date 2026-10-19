// Chat threads list.

import * as React from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import type { ChatThread } from "@genze/shared";
import { useLang } from "../../../lib/i18n";
import { ApiClientError, createThread, deleteThread, listThreads } from "../../../lib/api";
import { Btn, Card, Err, Header, Loading, Screen } from "../../../lib/components";

export default function ThreadsList(): React.JSX.Element {
  const { t, m, theme } = useLang();
  const [threads, setThreads] = React.useState<ChatThread[] | null>(null);
  const [error, setError] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setThreads(await listThreads());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function newChat() {
    setError("");
    try {
      const thread = await createThread();
      router.push(`/(tabs)/chat/${thread.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    }
  }

  async function remove(id: string) {
    try {
      await deleteThread(id);
      setThreads((prev) => (prev ?? []).filter((th) => th.id !== id));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    }
  }

  if (threads === null && !error) {
    return (
      <Screen>
        <Header title={t.tab_chat} />
        <Loading />
      </Screen>
    );
  }

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      <Header title={t.tab_chat} right={<Btn title={m("thread_new")} onPress={newChat} />} />
      <Err message={error} />
      {(threads ?? []).length === 0 ? (
        <Text style={{ color: theme.muted }}>{m("thread_empty")}</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {(threads ?? []).map((th) => (
            <Card key={th.id}>
              <Pressable onPress={() => router.push(`/(tabs)/chat/${th.id}`)}>
                <Text style={{ fontSize: 16, fontWeight: "600", color: theme.text }} numberOfLines={1}>
                  {th.title}
                </Text>
                <Text style={{ fontSize: 12, color: theme.muted }}>
                  {new Date(th.updatedAt).toLocaleDateString()}
                </Text>
              </Pressable>
              <Pressable onPress={() => remove(th.id)} accessibilityRole="button">
                <Text style={{ fontSize: 13, color: theme.danger }}>{t.chat_delete}</Text>
              </Pressable>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
