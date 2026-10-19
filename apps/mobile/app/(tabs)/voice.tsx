// Voice tab: two modes.
//
// 1. Tap to talk — record with expo-av -> POST /studio/voice/transcribe ->
//    POST /chat/threads/:id/messages (SSE) -> the reply is spoken back with
//    expo-speech in the user's chat language.
// 2. Record a message — record -> POST /chat/threads/:id/voice (multipart);
//    the response IS the chat SSE stream; the reply is then spoken back.
//
// Recording needs the microphone permission (requested at tap time; the
// Info.plist / manifest strings live in app.json).

import * as React from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import type { ChatStreamEvent } from "@genze/shared";
import { useLang } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import {
  ApiClientError,
  createThread,
  streamChatMessage,
  streamVoiceMessage,
  transcribeAudio,
} from "../../lib/api";
import { Card, Err, Header, Screen } from "../../lib/components";

type Phase = "idle" | "recording" | "working" | "speaking";

export default function Voice(): React.JSX.Element {
  const { t, m, theme } = useLang();
  const { user } = useSession();
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [transcript, setTranscript] = React.useState("");
  const [reply, setReply] = React.useState("");
  const [error, setError] = React.useState("");
  const recordingRef = React.useRef<Audio.Recording | null>(null);
  const threadRef = React.useRef<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
      void Speech.stop();
      const rec = recordingRef.current;
      if (rec) {
        void rec.stopAndUnloadAsync().catch(() => undefined);
        recordingRef.current = null;
      }
    };
  }, []);

  async function ensureThread(): Promise<string> {
    if (threadRef.current) return threadRef.current;
    const thread = await createThread("Voice chat");
    threadRef.current = thread.id;
    return thread.id;
  }

  function handleConsentError(err: unknown): boolean {
    if (err instanceof ApiClientError && err.code === "CONSENT_REQUIRED") {
      router.push("/ai-consent");
      return true;
    }
    return false;
  }

  /** Streams a reply and collects its full text. */
  function streamToText(
    streamFn: (onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal) => Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      abortRef.current = controller;
      let text = "";
      let streamError: string | null = null;
      const onEvent = (event: ChatStreamEvent) => {
        if (event.type === "token") {
          text += event.text;
          setReply(text);
        } else if (event.type === "error") {
          streamError = event.message;
        }
      };
      streamFn(onEvent, controller.signal).then(
        () => {
          abortRef.current = null;
          if (streamError) reject(new ApiClientError("PROVIDER_ERROR", streamError, 502));
          else resolve(text);
        },
        (err: unknown) => {
          abortRef.current = null;
          reject(err);
        },
      );
    });
  }

  function speak(text: string) {
    if (!text.trim()) return;
    setPhase("speaking");
    Speech.speak(text, {
      language: user?.preferredLanguage || "en",
      onDone: () => setPhase("idle"),
      onStopped: () => setPhase("idle"),
      onError: () => setPhase("idle"),
    });
  }

  async function startRecording(): Promise<Audio.Recording | null> {
    setError("");
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setError(m("voice_no_mic"));
        return null;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec;
      setPhase("recording");
      return rec;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t.err_generic);
      return null;
    }
  }

  async function stopRecording(): Promise<string | null> {
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (!rec) return null;
    try {
      await rec.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      setPhase("working");
      return rec.getURI();
    } catch {
      setPhase("idle");
      return null;
    }
  }

  /** Mode 1: tap to talk — transcribe, then chat, then speak the reply. */
  async function tapToTalk() {
    if (phase === "recording") {
      const uri = await stopRecording();
      if (!uri) return;
      setError("");
      try {
        setTranscript(m("voice_listening"));
        const { transcript } = await transcribeAudio(uri);
        setTranscript(transcript);
        const threadId = await ensureThread();
        const text = await streamToText((onEvent, signal) =>
          streamChatMessage(threadId, transcript, { onEvent, signal }),
        );
        speak(text);
      } catch (err) {
        setPhase("idle");
        if (!handleConsentError(err)) setError(err instanceof ApiClientError ? err.message : t.err_generic);
      }
      return;
    }
    if (phase !== "idle") return;
    setTranscript("");
    setReply("");
    await startRecording();
  }

  /** Mode 2: record a voice message — one multipart call returns the chat SSE stream. */
  async function recordMessage() {
    if (phase === "recording") {
      const uri = await stopRecording();
      if (!uri) return;
      setError("");
      try {
        const threadId = await ensureThread();
        const text = await streamToText((onEvent, signal) =>
          streamVoiceMessage(threadId, uri, { onEvent, signal }),
        );
        speak(text);
      } catch (err) {
        setPhase("idle");
        if (!handleConsentError(err)) setError(err instanceof ApiClientError ? err.message : t.err_generic);
      }
      return;
    }
    if (phase !== "idle") return;
    setTranscript("");
    setReply("");
    await startRecording();
  }

  async function stopAll() {
    abortRef.current?.abort();
    await Speech.stop();
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (rec) {
      try {
        await rec.stopAndUnloadAsync();
      } catch {
        /* already stopped */
      }
    }
    setPhase("idle");
  }

  function MicButton({ onPress, label }: { onPress: () => void; label: string }) {
    const active = phase === "recording";
    return (
      <View style={{ alignItems: "center", gap: 8 }}>
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={{
            width: 84,
            height: 84,
            borderRadius: 42,
            backgroundColor: active ? theme.danger : theme.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 32, color: theme.accentText }}>
            {active ? "\u25A0" : "\u25CF"}
          </Text>
        </Pressable>
        <Text style={{ color: theme.muted, fontSize: 13 }}>{label}</Text>
      </View>
    );
  }

  const statusText =
    phase === "recording"
      ? m("voice_recording")
      : phase === "working"
        ? m("voice_working")
        : phase === "speaking"
          ? m("voice_speaking")
          : "";

  return (
    <Screen>
      <Header title={m("voice_title")} />
      <Err message={error} />
      {statusText ? <Text style={{ color: theme.accent, fontSize: 14 }}>{statusText}</Text> : null}

      <Card>
        <Text style={{ fontSize: 17, fontWeight: "700", color: theme.text }}>{m("voice_tap_to_talk")}</Text>
        <Text style={{ fontSize: 14, color: theme.muted }}>{m("voice_tap_to_talk_sub")}</Text>
        <MicButton onPress={tapToTalk} label={phase === "recording" ? m("voice_stop") : m("voice_tap_to_talk")} />
      </Card>

      <Card>
        <Text style={{ fontSize: 17, fontWeight: "700", color: theme.text }}>{m("voice_record_message")}</Text>
        <Text style={{ fontSize: 14, color: theme.muted }}>{m("voice_record_message_sub")}</Text>
        <MicButton onPress={recordMessage} label={phase === "recording" ? m("voice_stop") : m("voice_record_message")} />
      </Card>

      {phase !== "idle" && phase !== "recording" && (
        <Pressable onPress={stopAll} accessibilityRole="button">
          <Text style={{ color: theme.danger, fontSize: 15, textAlign: "center" }}>{m("voice_stop")}</Text>
        </Pressable>
      )}

      {transcript ? (
        <Card>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.muted }}>{m("voice_you_said")}</Text>
          <Text style={{ fontSize: 15, color: theme.text }}>{transcript}</Text>
        </Card>
      ) : null}

      {reply ? (
        <Card>
          <Text style={{ fontSize: 15, lineHeight: 22, color: theme.text }}>{reply}</Text>
        </Card>
      ) : null}
    </Screen>
  );
}
