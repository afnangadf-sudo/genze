// Library tab — calls the real GET /library.
//
// AI-generated groups (image, audio, video) carry the visible "Made with
// AI" marker and a per-item report button. Library items are the user's
// own, so there is no shared-content block surface here; blockUser() in
// lib/api.ts is wired for shared surfaces when they land.

import * as React from "react";
import { Text, TextInput, View } from "react-native";
import type { LibraryGroup } from "@genze/shared";
import { useLang } from "../../lib/i18n";
import { ApiClientError, getLibrary } from "../../lib/api";
import { Card, Err, Header, Loading, MadeWithAi, ReportButton, Screen } from "../../lib/components";

const AI_GROUPS = new Set(["image", "audio", "video"]);

const GROUP_TITLES: Record<string, string> = {
  project: "Projects",
  chat: "Chats",
  file: "Files",
  report: "Research",
  video: "Videos",
  "agent-task": "Agent tasks",
  image: "Images",
  audio: "Audio",
};

export default function Library(): React.JSX.Element {
  const { t, m, theme, rtl } = useLang();
  const [groups, setGroups] = React.useState<LibraryGroup[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState("");

  const load = React.useCallback(
    async (q: string) => {
      try {
        setGroups(await getLibrary(q));
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : t.err_generic);
      }
    },
    [t],
  );

  React.useEffect(() => {
    void load("");
  }, [load]);

  React.useEffect(() => {
    const timer = setTimeout(() => void load(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query, load]);

  return (
    <Screen>
      <Header title={t.tab_library} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={m("library_search")}
        placeholderTextColor={theme.muted}
        textAlign={rtl ? "right" : "left"}
        style={{
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.card,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 15,
          color: theme.text,
        }}
      />
      <Err message={error} />
      {groups === null ? (
        <Loading />
      ) : groups.every((g) => g.items.length === 0) ? (
        <Text style={{ color: theme.muted }}>{m("library_empty")}</Text>
      ) : (
        <View style={{ gap: 18 }}>
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <View key={g.type} style={{ gap: 10 }}>
                <Text style={{ fontSize: 17, fontWeight: "700", color: theme.text }}>
                  {GROUP_TITLES[g.type] ?? g.type}
                </Text>
                {g.items.map((item) => (
                  <Card key={item.id}>
                    <Text style={{ fontSize: 15, fontWeight: "600", color: theme.text }} numberOfLines={2}>
                      {item.title}
                    </Text>
                    {item.snippet ? (
                      <Text style={{ fontSize: 13, color: theme.muted }} numberOfLines={3}>
                        {item.snippet}
                      </Text>
                    ) : null}
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      {AI_GROUPS.has(g.type) ? (
                        <MadeWithAi />
                      ) : (
                        <Text style={{ fontSize: 12, color: theme.muted }}>
                          {new Date(item.updatedAt).toLocaleDateString()}
                        </Text>
                      )}
                      {AI_GROUPS.has(g.type) && (
                        <ReportButton
                          targetType={g.type as "image" | "audio" | "video"}
                          targetId={item.id}
                        />
                      )}
                    </View>
                  </Card>
                ))}
              </View>
            ))}
        </View>
      )}
    </Screen>
  );
}
