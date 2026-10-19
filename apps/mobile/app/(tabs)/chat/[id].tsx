// Streaming chat screen.
//
// - Streams replies via XHR-parsed SSE (lib/api.ts streamChatMessage).
// - Every assistant message shows a "Made with AI" label and a per-message
//   report button (-> POST /moderation/report).
// - A 403 CONSENT_REQUIRED arriving on send routes back to /ai-consent.
// - Stop button aborts the stream.

import * as React from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { ChatMessage, ChatStreamEvent } from "@genze/shared";
import { useLang } from "../../../lib/i18n";
import { ApiClientError, getMessages, streamChatMessage } from "../../../lib/api";
import { Err, Loading, MadeWithAi, ReportButton, Screen } from "../../../lib/components";

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

export default function ChatDetail(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, m, theme, rtl } = useLang();
  const [messages, setMessages] = React.useState<UIMessage[] | null>(null);
  const [input, setInput] = React.useState("");
  const [error, setError] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const listRef = React.useRef<FlatList<UIMessage> | null>(null);

  const load = React.useCallback(async () => {
    if (!id) return;
    try {
      const data = await getMessages(id);
      setMessages(
        data.map((msg: ChatMessage) => ({ id: msg.id, role: msg.role, content: msg.content })),
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
    }
  }, [id, t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (messages && messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages]);

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function send() {
    const content = input.trim();
    if (!content || sending || !id) return;
    setError("");
    setInput("");
    const userMsg: UIMessage = { id: `local-${Date.now()}`, role: "user", content };
    const assistantId = `stream-${Date.now()}`;
    setMessages((prev) => [...(prev ?? []), userMsg, { id: assistantId, role: "assistant", content: "", streaming: true }]);
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let finalMessageId: string | null = null;
    let streamError: string | null = null;

    const onEvent = (event: ChatStreamEvent) => {
      if (event.type === "start") {
        finalMessageId = event.messageId ?? null;
      } else if (event.type === "token") {
        const text = event.text;
        setMessages((prev) =>
          (prev ?? []).map((msg) => (msg.id === assistantId ? { ...msg, content: msg.content + text } : msg)),
        );
      } else if (event.type === "error") {
        streamError = event.message;
      } else if (event.type === "done") {
        setMessages((prev) =>
          (prev ?? []).map((msg) =>
            msg.id === assistantId
              ? { id: finalMessageId ?? msg.id, role: "assistant", content: msg.content, streaming: false }
              : msg,
          ),
        );
      }
    };

    try {
      await streamChatMessage(id, content, { onEvent, signal: controller.signal });
      if (streamError) setError(streamError);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "CONSENT_REQUIRED") {
        // The AI consent screen handles this; come back here afterwards.
        router.push("/ai-consent");
      } else if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError(t.err_generic);
      }
      // Drop the empty streaming bubble on failure.
      setMessages((prev) => (prev ?? []).filter((msg) => msg.id !== assistantId || msg.content.length > 0));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function renderItem({ item }: ListRenderItemInfo<UIMessage>) {
    const isUser = item.role === "user";
    return (
      <View
        style={{
          alignSelf: isUser ? "flex-end" : "flex-start",
          maxWidth: "85%",
          backgroundColor: isUser ? theme.accent : theme.card,
          borderColor: theme.border,
          borderWidth: isUser ? 0 : 1,
          borderRadius: 14,
          padding: 12,
          gap: 6,
        }}
      >
        <Text style={{ fontSize: 15, lineHeight: 22, color: isUser ? theme.accentText : theme.text }}>
          {item.content}
          {item.streaming && item.content.length === 0 ? m("chat_thinking") : ""}
        </Text>
        {!isUser && !item.streaming && item.content.length > 0 && (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <MadeWithAi />
            <ReportButton targetType="chat_message" targetId={item.id} />
          </View>
        )}
      </View>
    );
  }

  return (
    <Screen scroll={false}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 4 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button">
          <Text style={{ fontSize: 16, color: theme.accent }}>{m("back")}</Text>
        </Pressable>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, flex: 1 }} numberOfLines={1}>
          {t.tab_chat}
        </Text>
        {sending && (
          <Pressable onPress={stop} accessibilityRole="button">
            <Text style={{ fontSize: 16, color: theme.danger }}>{m("chat_stop")}</Text>
          </Pressable>
        )}
      </View>

      <Err message={error} />

      <View style={{ flex: 1 }}>
        {messages === null ? (
          <Loading />
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={{ gap: 10, paddingVertical: 8 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
        )}
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end", paddingTop: 8 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={m("chat_hint")}
            placeholderTextColor={theme.muted}
            multiline
            textAlign={rtl ? "right" : "left"}
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 120,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.card,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 8,
              fontSize: 15,
              color: theme.text,
            }}
          />
          <Pressable
            onPress={send}
            disabled={sending || input.trim().length === 0}
            accessibilityRole="button"
            style={{
              backgroundColor: theme.accent,
              borderRadius: 12,
              paddingVertical: 12,
              paddingHorizontal: 16,
              opacity: sending || input.trim().length === 0 ? 0.5 : 1,
            }}
          >
            <Text style={{ color: theme.accentText, fontWeight: "600" }}>{m("chat_send")}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
