// Boot index: BootGate in _layout.tsx owns all routing; this screen is
// never meaningfully shown.
import * as React from "react";
import { View } from "react-native";

export default function Index(): React.JSX.Element {
  return <View style={{ flex: 1 }} />;
}
