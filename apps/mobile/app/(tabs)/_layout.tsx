// Bottom tabs: Chat, Voice, Research, Write, Studio, Library, Settings.
// Research / Write / Studio are honest "coming soon" cards on mobile;
// Library calls the real API.

import * as React from "react";
import { Tabs } from "expo-router";
import { useLang } from "../../lib/i18n";

export default function TabsLayout(): React.JSX.Element {
  const { t, m, theme } = useLang();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted,
        tabBarStyle: { backgroundColor: theme.card, borderTopColor: theme.border },
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tabs.Screen name="chat" options={{ title: t.tab_chat }} />
      <Tabs.Screen name="voice" options={{ title: m("tab_voice") }} />
      <Tabs.Screen name="research" options={{ title: t.tab_research }} />
      <Tabs.Screen name="write" options={{ title: t.tab_write }} />
      <Tabs.Screen name="studio" options={{ title: t.tab_studio }} />
      <Tabs.Screen name="library" options={{ title: t.tab_library }} />
      <Tabs.Screen name="settings" options={{ title: m("tab_settings") }} />
    </Tabs>
  );
}
