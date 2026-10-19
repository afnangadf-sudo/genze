import * as React from "react";
import { Stack } from "expo-router";

export default function ChatLayout(): React.JSX.Element {
  return <Stack screenOptions={{ headerShown: false }} />;
}
