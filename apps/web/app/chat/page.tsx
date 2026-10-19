"use client";

import { TabShell } from "../../components/TabShell";
import { ConsentGate } from "../../components/ConsentGate";
import { ChatApp } from "../../components/chat/ChatApp";

export default function ChatPage() {
  return (
    <TabShell>
      <ConsentGate>
        <ChatApp />
      </ConsentGate>
    </TabShell>
  );
}
