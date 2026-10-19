"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  ChatMessage,
  ChatThread,
  ConnectorConfirmation,
  ConnectorStatus,
  Gem,
  Project,
  TempChatMessageInput,
} from "@genze/shared";
import {
  createThread,
  deleteMessage,
  deleteThread,
  getMessages,
  listThreads,
  renameThread,
  setThreadGem,
  setThreadLockdown,
  setThreadTutorMode,
  streamChatMessage,
  streamTempChatMessage,
  type ExtendedChatStreamEvent,
} from "../../lib/chat";
import { getGem, listGems } from "../../lib/gems";
import { listProjects, createProject, updateProject } from "../../lib/projects";
import { uploadFile } from "../../lib/files";
import { addMemory } from "../../lib/memory";
import { cancelPendingWrite, listConnectors } from "../../lib/connectors";
import { ApiClientError } from "../../lib/auth";
import { friendlyErrText } from "../../lib/usage";
import { createAgentTask, friendlyAgentError } from "../../lib/agent";
import { streamChatVoiceNote } from "../../lib/studio";
import { useLang, type Strings } from "../../lib/lang";
import { Button } from "../Button";
import { ConfirmationCard } from "./ConfirmationCard";

const MAX_CONTENT = 8000;

/** File selected in the composer — uploaded in the background, then attached. */
interface Attachment {
  key: string;
  name: string;
  progress: number; // 0–100 while uploading
  fileId: string | null; // set once the upload finished
}

const ACCEPTED_FILES = ".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a";

/* ---------- tiny inline icons ---------- */

function Icon({ path, className = "h-5 w-5" }: { path: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  );
}

const ICON = {
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 5h10v14H7z",
  plus: "M12 5v14M5 12h14",
  pencil: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M18 6L6 18M6 6l12 12",
  clip: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z",
  mic: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10a7 7 0 0 1-14 0M12 17v4",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
};

/* ---------- message bubble ---------- */

interface RememberState {
  /** Called when the user taps "Remember". */
  onRemember: () => void;
  busy: boolean;
  done: boolean;
  rememberLabel: string;
  rememberedLabel: string;
}

function MessageBubble({
  message,
  demoLabel,
  freeLabel,
  remember,
}: {
  message: ChatMessage;
  demoLabel: string;
  freeLabel: string;
  remember?: RememberState | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-clay-soft px-4 py-2.5 text-[15px] leading-relaxed text-stone-800 dark:bg-stone-800 dark:text-stone-100">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[95%]">
      {message.demo && (
        <span className="mb-1.5 inline-block rounded-full border border-stone-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500 dark:border-stone-700 dark:text-stone-400">
          {demoLabel}
        </span>
      )}
      {!message.demo && message.provider === "free" && (
        <span className="mb-1.5 inline-block rounded-full border border-stone-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500 dark:border-stone-700 dark:text-stone-400">
          {freeLabel}
        </span>
      )}
      <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-stone-800 dark:text-stone-100">
        {message.content}
      </div>
      {/* subtle "Remember" affordance — manual memory save, never automatic */}
      {remember && !message.demo && (
        <div className="mt-1">
          {remember.done ? (
            <span className="text-xs text-stone-400 dark:text-stone-500">
              {remember.rememberedLabel}
            </span>
          ) : (
            <button
              onClick={remember.onRemember}
              disabled={remember.busy}
              className="rounded px-1 py-0.5 text-xs text-stone-400 transition-colors hover:text-stone-600 disabled:opacity-50 dark:text-stone-500 dark:hover:text-stone-300"
            >
              {remember.rememberLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingDots({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-stone-500 dark:text-stone-400">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-400 dark:bg-stone-500"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      {label}
    </div>
  );
}

/* ---------- guided learning ("Teach me") toggle ---------- */

/**
 * The tutor-mode switch with a friendly inline explainer. Plain language
 * only — never the word "Socratic" or any jargon. Used on normal threads
 * and on the stateless temporary chat.
 */
function TeachMeSwitch({
  checked,
  disabled,
  onChange,
  t,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  t: Strings;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      <button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        disabled={disabled}
        className="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1 disabled:opacity-50"
      >
        <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
          {t.gm_tutor}
        </span>
        <span
          className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
            checked ? "bg-clay" : "bg-stone-300 dark:bg-stone-700"
          }`}
        >
          <span
            className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all ${
              checked ? "start-6" : "start-1"
            }`}
          />
        </span>
      </button>
      <button
        onClick={() => setInfoOpen((v) => !v)}
        aria-label={t.gm_tutor}
        aria-expanded={infoOpen}
        title={t.gm_tutor}
        className="rounded-full p-1 text-stone-400 transition-colors hover:bg-stone-200/60 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-300"
      >
        <Icon path={ICON.info} className="h-3.5 w-3.5" />
      </button>
      {infoOpen && (
        <p className="basis-full text-xs leading-relaxed text-stone-500 dark:text-stone-400">
          {t.gm_tutor_explainer}
        </p>
      )}
    </div>
  );
}

/* ---------- main component ---------- */

export function ChatApp() {
  const { lang, t } = useLang();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [handBusy, setHandBusy] = useState(false);
  const [handError, setHandError] = useState("");
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [composer, setComposer] = useState("");
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);

  // streaming
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamDemo, setStreamDemo] = useState(false);

  // inline rename / delete in the thread panel
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // temporary chat — local-only, never persisted
  const [tempMode, setTempMode] = useState(false);
  const [tempMessages, setTempMessages] = useState<ChatMessage[]>([]);

  // gems: the new-chat picker, the active gem chip, and guided learning
  const [gems, setGems] = useState<Gem[]>([]);
  const [selectedGemId, setSelectedGemId] = useState<string | null>(null);
  const [activeGem, setActiveGem] = useState<Gem | null>(null);
  // guided learning for the stateless temporary chat (never persisted)
  const [tempTutor, setTempTutor] = useState(false);

  // set when a "compacted" SSE event arrives for the current thread
  const [sessionCompacted, setSessionCompacted] = useState(false);

  // projects + per-project instructions
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructionsText, setInstructionsText] = useState("");
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");

  // file attachments (uploaded in the background, attached on send)
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // chat voice note: mic button on the composer records via MediaRecorder,
  // then posts the audio to the thread voice endpoint and streams the reply
  // like a normal message
  const [recording, setRecording] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStreamRef = useRef<MediaStream | null>(null);

  // "Remember" affordance — manual memory save from an assistant message
  const [remembered, setRemembered] = useState<Record<string, boolean>>({});
  const [rememberBusy, setRememberBusy] = useState<string | null>(null);

  // connectors: chips on the composer (connected connectors only), toggled ids
  // become useConnectors for the next message
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([]);

  // connector write confirmation: the stream ends with a confirmation card in
  // place of the reply; nothing executes until the user confirms
  const [pendingConfirmation, setPendingConfirmation] = useState<ConnectorConfirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [confirmNote, setConfirmNote] = useState("");
  const [toolActivity, setToolActivity] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const streamErrorRef = useRef<string>("");
  const streamTextRef = useRef<string>("");
  const streamDemoRef = useRef<boolean>(false);
  const lastContentRef = useRef<string>("");
  const activeIdRef = useRef<string | null>(null);
  const confirmationRef = useRef<boolean>(false);
  /** Thread + message the current pending confirmation belongs to. */
  const pendingInfoRef = useRef<{ threadId: string; content: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  activeIdRef.current = activeId;

  /** API errors keep the server's plain-language message; a 429
   *  LIMIT_EXCEEDED becomes the friendly "your daily limit" line with the
   *  reset time. Shown inline, never a pop-up. */
  const errText = (err: unknown) => friendlyErrText(lang, t, err);

  /** Upload errors come from the API's plain-language message; a dropped
   *  connection has no message, so fall back to the generic one. */
  const attachErrText = (err: unknown) =>
    err instanceof ApiClientError && err.code === "NETWORK_ERROR" ? t.err_generic : errText(err);

  /* initial load */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ths, projs] = await Promise.all([listThreads(), listProjects()]);
        if (cancelled) return;
        setThreads(ths);
        setProjects(projs);
        if (ths.length > 0) {
          setActiveId(ths[0].id);
          setSelectedProjectId(ths[0].projectId);
          try {
            setMessages(await getMessages(ths[0].id));
          } catch (err) {
            if (!cancelled) setError(errText(err));
          }
        }
      } catch (err) {
        if (!cancelled) setError(errText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
      // Gems are a progressive enhancement too — the picker simply stays
      // empty if the gems API is unreachable.
      try {
        const g = await listGems();
        if (!cancelled) setGems(g);
      } catch {
        /* no gems — the picker stays hidden */
      }
      // Connector chips are a progressive enhancement — chat works fine if the
      // connector API is unreachable, so this load never blocks the rest.
      try {
        const cons = await listConnectors();
        if (!cancelled) setConnectors(cons.filter((c) => c.connected));
      } catch {
        /* no connectors — the hint in the composer explains the way forward */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* auto-scroll to the newest token */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, thinking]);

  /* auto-grow the composer */
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [composer]);

  function handleEvent(ev: ExtendedChatStreamEvent) {
    if (ev.type === "start") {
      setThinking(false);
      setStreamDemo(ev.demo);
      streamTextRef.current = "";
      streamDemoRef.current = ev.demo;
    } else if (ev.type === "token") {
      setThinking(false);
      setStreamText((prev) => prev + ev.text);
      streamTextRef.current += ev.text;
    } else if (ev.type === "tool_activity") {
      // Plain-language phase line while connector tools run.
      setThinking(false);
      setToolActivity(ev.message);
    } else if (ev.type === "confirmation_required") {
      // The assistant wants to make a change via a connector: the stream ends
      // here with no reply persisted, and the confirmation card takes its place.
      confirmationRef.current = true;
      setThinking(false);
      setToolActivity("");
      setConfirmNote("");
      setConfirmError("");
      setPendingConfirmation(ev.confirmation);
    } else if (ev.type === "compacted") {
      // Older messages were auto-summarized on the server — show the marker.
      setSessionCompacted(true);
    } else if (ev.type === "error") {
      streamErrorRef.current = ev.message;
    }
    // "done" is handled by refreshing from the server after the stream ends.
    // Unknown event types are ignored.
  }

  /**
   * After a stream ends: refresh threads + messages so the UI matches the
   * server (a confirmation card, a stream error, or the persisted reply).
   */
  async function finishStream(threadId: string) {
    if (confirmationRef.current) {
      // The stream ended at a confirmation card — no assistant reply was
      // persisted; the card handles what happens next. Just refresh the
      // thread list (titles may have been auto-set).
      confirmationRef.current = false;
      setThreads(await listThreads());
    } else if (streamErrorRef.current) {
      setError(streamErrorRef.current);
    } else {
      // The completed reply is persisted server-side — reload everything so
      // the list matches the server (and picks up the auto-set title).
      const [msgs, ths] = await Promise.all([getMessages(threadId), listThreads()]);
      setMessages(msgs);
      setThreads(ths);
    }
  }

  async function send(raw: string) {
    const content = raw.trim();
    if (!content || streaming) return;
    if (tempMode) {
      await sendTemp(content);
      return;
    }
    setError("");
    setConfirmNote("");
    setToolActivity("");
    lastContentRef.current = content;
    streamErrorRef.current = "";
    let threadId = activeIdRef.current;

    try {
      if (!threadId) {
        // The chosen gem rides along on the new thread.
        const created = await createThread(
          undefined,
          selectedProjectId ?? undefined,
          selectedGemId ?? undefined
        );
        threadId = created.id;
        setThreads((prev) => [created, ...prev]);
        setActiveId(threadId);
      }
      const userMsg: ChatMessage = {
        id: `local-${Date.now()}`,
        threadId,
        role: "user",
        content,
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        demo: false,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setComposer("");
      setStreaming(true);
      setThinking(true);
      setStreamText("");

      const controller = new AbortController();
      abortRef.current = controller;
      const readyFileIds = attached.filter((a) => a.fileId).map((a) => a.fileId as string);
      setAttached([]);
      const useConns = selectedConnectors.length > 0 ? selectedConnectors : undefined;
      // Remember where this message went: a connector write confirmation ends
      // the stream, and the card's Confirm re-posts from here.
      pendingInfoRef.current = { threadId, content };
      await streamChatMessage(threadId, content, {
        signal: controller.signal,
        onEvent: handleEvent,
        fileIds: readyFileIds.length > 0 ? readyFileIds : undefined,
        useConnectors: useConns,
      });

      await finishStream(threadId);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // Stopped by the user — the server discards the partial reply.
      } else {
        setError(errText(err));
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      setStreamText("");
      setToolActivity("");
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  /* ---------- chat voice note (mic on the composer) ---------- */

  async function toggleRecording() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (streaming || voiceSending || tempMode) return;
    setError("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Mic denied or unavailable — plain inline message, never a pop-up.
      setError(t.st_voice_mic_denied);
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    voiceChunksRef.current = [];
    voiceStreamRef.current = stream;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      voiceStreamRef.current = null;
      mediaRecorderRef.current = null;
      setRecording(false);
      const blob = new Blob(voiceChunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      voiceChunksRef.current = [];
      if (blob.size > 0) void sendVoiceNote(blob);
    };
    recorder.onerror = () => {
      setRecording(false);
      setError(t.st_voice_record_error);
    };
    mediaRecorderRef.current = recorder;
    setRecording(true);
    recorder.start();
  }

  /**
   * Posts the recorded audio to the thread voice endpoint; the assistant's
   * reply streams back through the same events as a normal message.
   */
  async function sendVoiceNote(blob: Blob) {
    if (streaming || voiceSending) return;
    setError("");
    setConfirmNote("");
    setToolActivity("");
    setVoiceSending(true);
    streamErrorRef.current = "";
    let threadId = activeIdRef.current;

    try {
      if (!threadId) {
        const created = await createThread(
          undefined,
          selectedProjectId ?? undefined,
          selectedGemId ?? undefined
        );
        threadId = created.id;
        setThreads((prev) => [created, ...prev]);
        setActiveId(threadId);
      }
      // Local echo until the server's transcript replaces it on refresh.
      const userMsg: ChatMessage = {
        id: `local-voice-${Date.now()}`,
        threadId,
        role: "user",
        content: `🎙 ${t.st_voice_note}`,
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        demo: false,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStreaming(true);
      setThinking(true);
      setStreamText("");

      const controller = new AbortController();
      abortRef.current = controller;
      // Voice notes don't carry a pending connector confirmation — the card's
      // Confirm re-posts via text instead.
      pendingInfoRef.current = null;
      await streamChatVoiceNote(threadId, blob, {
        signal: controller.signal,
        onEvent: handleEvent,
      });

      await finishStream(threadId);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // Stopped by the user.
      } else {
        setError(errText(err));
      }
    } finally {
      setVoiceSending(false);
      setStreaming(false);
      setThinking(false);
      setStreamText("");
      setToolActivity("");
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }

  /* ---------- connector write confirmations ---------- */

  function toggleConnector(id: string) {
    if (streaming) return;
    setSelectedConnectors((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  /**
   * The user approved the pending write: re-post the same message with the
   * confirmation id. The server executes the approved write tool, feeds the
   * result back, and streams the final answer.
   */
  async function confirmAndResend() {
    const pc = pendingConfirmation;
    const info = pendingInfoRef.current;
    if (!pc || !info || confirmBusy || streaming) return;
    setConfirmBusy(true);
    setConfirmError("");
    setPendingConfirmation(null);
    setError("");
    setConfirmNote("");
    setStreaming(true);
    setThinking(true);
    setStreamText("");
    streamTextRef.current = "";
    streamErrorRef.current = "";
    confirmationRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const useConns = selectedConnectors.length > 0 ? selectedConnectors : undefined;
      await streamChatMessage(info.threadId, info.content, {
        signal: controller.signal,
        onEvent: handleEvent,
        useConnectors: useConns,
        confirmedActions: [{ confirmationId: pc.id }],
      });
      if (confirmationRef.current) {
        // The server asked for another confirmation (a second write).
        confirmationRef.current = false;
        setThreads(await listThreads());
      } else if (streamErrorRef.current) {
        setError(streamErrorRef.current);
      } else {
        const [msgs, ths] = await Promise.all([
          getMessages(info.threadId),
          listThreads(),
        ]);
        setMessages(msgs);
        setThreads(ths);
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // Stopped by the user.
      } else {
        setError(errText(err));
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      setStreamText("");
      setToolActivity("");
      setConfirmBusy(false);
      pendingInfoRef.current = null;
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }

  /** The user declined the pending write — cancel it server-side and drop the card. */
  async function cancelConfirmation() {
    const pc = pendingConfirmation;
    if (!pc || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError("");
    try {
      await cancelPendingWrite(pc.id);
      setPendingConfirmation(null);
      pendingInfoRef.current = null;
      setConfirmNote(t.chat_confirm_cancelled);
    } catch (err) {
      setConfirmError(errText(err));
    } finally {
      setConfirmBusy(false);
    }
  }

  /** Temporary chat: everything stays local; the reply streams from the
   *  stateless endpoint with the full local history. */
  async function sendTemp(content: string) {
    await sendTempFrom(tempMessages, content);
  }

  async function sendTempFrom(base: ChatMessage[], content: string) {
    setError("");
    lastContentRef.current = content;
    streamErrorRef.current = "";
    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      threadId: "temp",
      role: "user",
      content,
      provider: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      demo: false,
      createdAt: new Date().toISOString(),
    };
    const history: TempChatMessageInput[] = [...base, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));
    setTempMessages([...base, userMsg]);
    setComposer("");
    setStreaming(true);
    setThinking(true);
    setStreamText("");
    streamTextRef.current = "";

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamTempChatMessage(history, {
        signal: controller.signal,
        onEvent: handleEvent,
        tutor: tempTutor,
      });

      if (streamErrorRef.current) {
        setError(streamErrorRef.current);
      } else {
        const assistantMsg: ChatMessage = {
          id: `temp-${Date.now()}-reply`,
          threadId: "temp",
          role: "assistant",
          content: streamTextRef.current,
          provider: null,
          model: null,
          inputTokens: null,
          outputTokens: null,
          demo: streamDemoRef.current,
          createdAt: new Date().toISOString(),
        };
        setTempMessages((prev) => [...prev, assistantMsg]);
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // Stopped by the user — nothing was saved, the partial reply is dropped.
      } else {
        setError(errText(err));
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      setStreamText("");
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }

  /** Resend the last message after removing the failed attempt's user message. */
  async function retry() {
    const content = lastContentRef.current;
    if (!content || streaming) return;
    setError("");
    if (tempMode) {
      // Drop the failed user message, then resend from the base history.
      const last = tempMessages[tempMessages.length - 1];
      const base =
        last && last.role === "user" && last.content === content
          ? tempMessages.slice(0, -1)
          : tempMessages;
      await sendTempFrom(base, content);
      return;
    }
    const threadId = activeIdRef.current;
    if (!threadId) return;
    try {
      const msgs = await getMessages(threadId);
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (lastUser) await deleteMessage(lastUser.id);
    } catch {
      /* best effort — a duplicate user message is harmless */
    }
    await send(content);
  }

  async function selectThread(id: string) {
    if (id === activeIdRef.current || streaming) return;
    // Leaving temporary chat discards its local messages.
    setTempMode(false);
    setTempMessages([]);
    setSessionCompacted(false);
    const thread = threads.find((th) => th.id === id);
    setPendingConfirmation(null);
    pendingInfoRef.current = null;
    setConfirmNote("");
    setActiveId(id);
    setSelectedProjectId(thread ? thread.projectId : null);
    setShowInstructions(false);
    setError("");
    setConfirmDeleteId(null);
    setRenameId(null);
    setPanelOpen(false);
    setLoadingMessages(true);
    try {
      setMessages(await getMessages(id));
    } catch (err) {
      setError(errText(err));
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }

  function newChat() {
    if (streaming) return;
    setTempMode(false);
    setTempMessages([]);
    setSessionCompacted(false);
    setActiveId(null);
    setSelectedGemId(null);
    setMessages([]);
    setError("");
    setPendingConfirmation(null);
    pendingInfoRef.current = null;
    setConfirmNote("");
    setConfirmDeleteId(null);
    setRenameId(null);
    setPanelOpen(false);
    textareaRef.current?.focus();
  }

  function enterTempMode() {
    if (streaming) return;
    setTempMode(true);
    setActiveId(null);
    setMessages([]);
    setTempMessages([]);
    setSessionCompacted(false);
    setError("");
    setPendingConfirmation(null);
    pendingInfoRef.current = null;
    setConfirmNote("");
    setConfirmDeleteId(null);
    setRenameId(null);
    setPanelOpen(false);
    textareaRef.current?.focus();
  }

  async function commitRename(id: string) {
    const value = renameValue.trim().slice(0, 80);
    setRenameId(null);
    if (!value) return;
    try {
      const updated = await renameThread(id, value);
      setThreads((prev) => prev.map((th) => (th.id === id ? updated : th)));
    } catch (err) {
      setError(errText(err));
    }
  }

  async function confirmDelete(id: string) {
    try {
      await deleteThread(id);
      setConfirmDeleteId(null);
      setThreads((prev) => prev.filter((th) => th.id !== id));
      if (id === activeIdRef.current) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      setError(errText(err));
    }
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(composer);
    }
  }

  /* ---------- projects ---------- */

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  function openInstructions() {
    if (!selectedProject) return;
    setInstructionsText(selectedProject.instructions);
    setInstructionsSaved(false);
    setShowInstructions(true);
  }

  async function saveInstructions() {
    if (!selectedProject || instructionsSaving) return;
    setInstructionsSaving(true);
    setInstructionsSaved(false);
    try {
      const updated = await updateProject(selectedProject.id, {
        instructions: instructionsText.trim(),
      });
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setInstructionsSaved(true);
      setTimeout(() => setShowInstructions(false), 1200);
    } catch (err) {
      setError(errText(err));
    } finally {
      setInstructionsSaving(false);
    }
  }

  async function commitNewProject() {
    const title = newProjectTitle.trim().slice(0, 80);
    if (!title) {
      setCreatingProject(false);
      setNewProjectTitle("");
      return;
    }
    try {
      const created = await createProject(title);
      setProjects((prev) => [created, ...prev]);
      setSelectedProjectId(created.id);
    } catch (err) {
      setError(errText(err));
    } finally {
      setCreatingProject(false);
      setNewProjectTitle("");
    }
  }

  /* ---------- file attachments ---------- */

  function removeAttachment(key: string) {
    setAttached((prev) => prev.filter((a) => a.key !== key));
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    e.target.value = "";
    if (!list || list.length === 0) return;
    setAttachError("");
    const fresh: Attachment[] = Array.from(list).map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      name: f.name,
      progress: 0,
      fileId: null,
    }));
    setAttached((prev) => [...prev, ...fresh]);
    const projectId = selectedProjectId ?? undefined;
    await Promise.all(
      fresh.map(async (chip, i) => {
        const file = list[i];
        try {
          const uploaded = await uploadFile(file, projectId, (pct) =>
            setAttached((prev) =>
              prev.map((a) => (a.key === chip.key ? { ...a, progress: pct } : a))
            )
          );
          setAttached((prev) =>
            prev.map((a) => (a.key === chip.key ? { ...a, fileId: uploaded.id, progress: 100 } : a))
          );
        } catch (err) {
          setAttached((prev) => prev.filter((a) => a.key !== chip.key));
          setAttachError(attachErrText(err));
        }
      })
    );
  }

  const suggestions = [t.chat_suggestion_1, t.chat_suggestion_2, t.chat_suggestion_3];
  const activeThread = threads.find((th) => th.id === activeId) ?? null;
  const selectedGem = selectedGemId ? gems.find((g) => g.id === selectedGemId) ?? null : null;
  const shownMessages = tempMode ? tempMessages : messages;
  const showEmpty = !loading && !loadingMessages && shownMessages.length === 0 && !streaming;
  const showStreamBubble = streaming && (thinking || streamText.length > 0);
  const showCompacted = sessionCompacted || activeThread?.compacted === true;

  async function toggleLockdown() {
    if (!activeThread || streaming) return;
    try {
      const updated = await setThreadLockdown(activeThread.id, !activeThread.lockdown);
      setThreads((prev) => prev.map((th) => (th.id === updated.id ? updated : th)));
    } catch (err) {
      setError(errText(err));
    }
  }

  /** Removes the gem from the active thread (the thread keeps working). */
  async function removeGem() {
    if (!activeThread || streaming) return;
    try {
      const updated = await setThreadGem(activeThread.id, null);
      setThreads((prev) => prev.map((th) => (th.id === updated.id ? updated : th)));
    } catch (err) {
      setError(errText(err));
    }
  }

  /** Toggles guided learning ("Teach me") on the active thread. */
  async function toggleTutor() {
    if (!activeThread || streaming) return;
    try {
      const updated = await setThreadTutorMode(activeThread.id, !activeThread.tutorMode);
      setThreads((prev) => prev.map((th) => (th.id === updated.id ? updated : th)));
    } catch (err) {
      setError(errText(err));
    }
  }

  /** "Hand to agent": creates an agent task from this thread and opens it
   *  in the Agent tab. Errors show inline in the toolbar — never pop-ups. */
  async function handToAgent() {
    const threadId = activeIdRef.current;
    if (!threadId || handBusy || tempMode) return;
    setHandBusy(true);
    setHandError("");
    try {
      const task = await createAgentTask({ threadId });
      router.push(`/agent?task=${task.id}`);
    } catch (err) {
      setHandError(friendlyAgentError(err, t));
    } finally {
      setHandBusy(false);
    }
  }

  /** Manual "Remember" — saves an assistant message to memory, with a plain
   *  inline confirmation. Hidden in temporary chat, lockdown, and demos. */
  async function rememberMessage(m: ChatMessage) {
    if (rememberBusy || remembered[m.id]) return;
    setRememberBusy(m.id);
    try {
      await addMemory(m.content.slice(0, 500));
      setRemembered((prev) => ({ ...prev, [m.id]: true }));
    } catch {
      /* the button stays; the user can try again */
    } finally {
      setRememberBusy(null);
    }
  }

  const showRemember = !tempMode && !!activeThread && !activeThread.lockdown;

  /* Keeps the active-gem chip in sync with the open thread (prefers the
   * already-loaded list; fetches the gem only when it isn't there). */
  useEffect(() => {
    let cancelled = false;
    const gid = activeThread?.gemId ?? null;
    if (!gid) {
      setActiveGem(null);
      return;
    }
    const known = gems.find((g) => g.id === gid);
    if (known) {
      setActiveGem(known);
      return;
    }
    getGem(gid)
      .then((g) => {
        if (!cancelled) setActiveGem(g);
      })
      .catch(() => {
        if (!cancelled) setActiveGem(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread?.gemId, gems]);

  return (
    <div className="relative flex h-[calc(100dvh-12rem)] min-h-[26rem] overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      {/* backdrop for the panel on small screens */}
      {panelOpen && (
        <button
          aria-label={t.chat_cancel}
          className="absolute inset-0 z-10 bg-black/30 md:hidden"
          onClick={() => setPanelOpen(false)}
        />
      )}

      {/* thread panel */}
      <aside
        className={`${
          panelOpen ? "absolute inset-y-0 start-0 z-20 flex" : "hidden"
        } w-64 shrink-0 flex-col border-e border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900 md:static md:z-auto md:flex`}
        aria-label={t.chat_threads}
      >
        <div className="flex items-center justify-between gap-2 p-3">
          <Button variant="ghost" className="flex-1 justify-start gap-2" onClick={newChat}>
            <Icon path={ICON.plus} className="h-4 w-4" />
            {t.chat_new}
          </Button>
          <button
            className="rounded-lg p-2 text-stone-500 hover:bg-stone-200/60 md:hidden dark:text-stone-400 dark:hover:bg-stone-800"
            onClick={() => setPanelOpen(false)}
            aria-label={t.chat_cancel}
          >
            <Icon path={ICON.close} className="h-5 w-5" />
          </button>
        </div>
        {/* temporary chat — clearly separate from saved chats */}
        <div className="px-3 pb-3">
          <button
            onClick={enterTempMode}
            aria-label={t.chat_temp}
            title={t.chat_temp_banner}
            className={`flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-2 text-sm font-medium transition-colors ${
              tempMode
                ? "border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-200"
                : "border-stone-300 text-stone-500 hover:border-amber-400 hover:text-amber-700 dark:border-stone-700 dark:text-stone-400 dark:hover:border-amber-600 dark:hover:text-amber-400"
            }`}
          >
            <Icon path={ICON.spark} className="h-4 w-4" />
            {t.chat_temp}
          </button>
        </div>

        {/* project selector + per-project instructions — hidden in temporary chat */}
        {!tempMode && (
        <div className="px-3 pb-3">
          <label
            htmlFor="project-select"
            className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500"
          >
            {t.chat_project_label}
          </label>
          <select
            id="project-select"
            value={selectedProjectId ?? ""}
            onChange={(e) => {
              if (e.target.value === "__new__") {
                setCreatingProject(true);
                setShowInstructions(false);
                return;
              }
              setSelectedProjectId(e.target.value === "" ? null : e.target.value);
              setShowInstructions(false);
            }}
            className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-2 text-sm text-stone-700 focus:border-clay focus:outline-none dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
          >
            <option value="">{t.chat_project_none}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
            <option value="__new__">{t.chat_project_new}</option>
          </select>
          {creatingProject && (
            <div className="mt-2 flex gap-1.5">
              <input
                autoFocus
                value={newProjectTitle}
                maxLength={80}
                onChange={(e) => setNewProjectTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitNewProject();
                  if (e.key === "Escape") {
                    setCreatingProject(false);
                    setNewProjectTitle("");
                  }
                }}
                placeholder={t.chat_project_name}
                aria-label={t.chat_project_name}
                className="min-w-0 flex-1 rounded-lg border border-clay bg-white px-2.5 py-1.5 text-sm text-stone-800 outline-none dark:bg-stone-900 dark:text-stone-100"
              />
              <Button className="shrink-0 px-3 py-1.5 text-xs" onClick={commitNewProject}>
                {t.chat_instructions_save}
              </Button>
            </div>
          )}
          {selectedProject && !showInstructions && (
            <button
              onClick={openInstructions}
              className="mt-1.5 rounded-md px-2 py-1 text-xs text-stone-500 underline-offset-2 hover:bg-stone-200/60 hover:text-stone-700 hover:underline dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            >
              {t.chat_instructions_btn}
            </button>
          )}
          {selectedProject && showInstructions && (
            <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50 p-2.5 dark:border-stone-700 dark:bg-stone-800/60">
              <label
                htmlFor="project-instructions"
                className="mb-1 block text-xs text-stone-500 dark:text-stone-400"
              >
                {t.chat_instructions_label}
              </label>
              <textarea
                id="project-instructions"
                rows={3}
                maxLength={4000}
                value={instructionsText}
                onChange={(e) => {
                  setInstructionsText(e.target.value);
                  setInstructionsSaved(false);
                }}
                className="w-full resize-none rounded-md border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-800 focus:border-clay focus:outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
              />
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  className="px-3 py-1.5 text-xs"
                  onClick={saveInstructions}
                  disabled={instructionsSaving}
                >
                  {instructionsSaved ? t.chat_instructions_saved : t.chat_instructions_save}
                </Button>
                <Button
                  variant="ghost"
                  className="px-3 py-1.5 text-xs"
                  onClick={() => setShowInstructions(false)}
                >
                  {t.chat_cancel}
                </Button>
              </div>
            </div>
          )}
        </div>
        )}

        {/* gem picker — only for a brand-new chat (not temporary, not an open thread) */}
        {!tempMode && !activeId && gems.length > 0 && (
          <div className="px-3 pb-3">
            <label
              htmlFor="gem-select"
              className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500"
            >
              {t.gm_pick_label}
            </label>
            <select
              id="gem-select"
              value={selectedGemId ?? ""}
              onChange={(e) =>
                setSelectedGemId(e.target.value === "" ? null : e.target.value)
              }
              className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-2 text-sm text-stone-700 focus:border-clay focus:outline-none dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
            >
              <option value="">{t.gm_pick_none}</option>
              {gems.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.builtin ? ` (${t.k_builtin})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {loading ? (
            <p className="px-3 py-4 text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
          ) : threads.length === 0 ? (
            <p className="px-3 py-4 text-sm text-stone-500 dark:text-stone-400">{t.chat_no_threads}</p>
          ) : (
            <ul className="space-y-0.5">
              {threads.map((thread) => {
                const active = thread.id === activeId;
                if (confirmDeleteId === thread.id) {
                  return (
                    <li
                      key={thread.id}
                      className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/20"
                    >
                      <p className="text-sm text-stone-700 dark:text-stone-200">{t.chat_delete_confirm}</p>
                      <div className="mt-2 flex gap-2">
                        <Button
                          variant="danger"
                          className="px-3 py-1.5 text-xs"
                          onClick={() => confirmDelete(thread.id)}
                        >
                          {t.chat_delete_yes}
                        </Button>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-xs"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          {t.chat_cancel}
                        </Button>
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={thread.id}>
                    <div
                      className={`group flex items-center gap-1 rounded-lg px-2 py-2 ${
                        active
                          ? "bg-clay-soft dark:bg-stone-800"
                          : "hover:bg-stone-100 dark:hover:bg-stone-800/60"
                      }`}
                    >
                      {renameId === thread.id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          maxLength={80}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(thread.id);
                            if (e.key === "Escape") setRenameId(null);
                          }}
                          onBlur={() => commitRename(thread.id)}
                          className="min-w-0 flex-1 rounded-md border border-clay bg-white px-2 py-1 text-sm text-stone-800 outline-none dark:bg-stone-900 dark:text-stone-100"
                          aria-label={t.chat_rename}
                        />
                      ) : (
                        <button
                          className="min-w-0 flex-1 truncate text-start text-sm text-stone-700 dark:text-stone-200"
                          onClick={() => selectThread(thread.id)}
                          title={thread.title}
                        >
                          {thread.title}
                        </button>
                      )}
                      {renameId !== thread.id && (
                        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <button
                            className="rounded-md p-1.5 text-stone-400 hover:bg-stone-200/70 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-stone-700 dark:hover:text-stone-300"
                            onClick={() => {
                              setRenameId(thread.id);
                              setRenameValue(thread.title);
                              setConfirmDeleteId(null);
                            }}
                            aria-label={t.chat_rename}
                            title={t.chat_rename}
                          >
                            <Icon path={ICON.pencil} className="h-3.5 w-3.5" />
                          </button>
                          <button
                            className="rounded-md p-1.5 text-stone-400 hover:bg-stone-200/70 hover:text-red-600 dark:text-stone-500 dark:hover:bg-stone-700 dark:hover:text-red-400"
                            onClick={() => {
                              setConfirmDeleteId(thread.id);
                              setRenameId(null);
                            }}
                            aria-label={t.chat_delete}
                            title={t.chat_delete}
                          >
                            <Icon path={ICON.trash} className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* chat column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* small-screen header */}
        <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2 md:hidden dark:border-stone-800">
          <button
            className="rounded-lg p-2 text-stone-600 hover:bg-stone-200/60 dark:text-stone-300 dark:hover:bg-stone-800"
            onClick={() => setPanelOpen(true)}
            aria-label={t.chat_threads}
          >
            <Icon path={ICON.menu} />
          </button>
          <span className="text-sm font-medium text-stone-700 dark:text-stone-200">{t.tab_chat}</span>
        </div>

        {/* temporary-chat banner — nothing is saved */}
        {tempMode && (
          <div className="border-b border-dashed border-amber-400 bg-amber-50 px-4 py-2.5 sm:px-6 dark:border-amber-700/70 dark:bg-amber-950/30">
            <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2.5">
              <span className="shrink-0 rounded-full border border-dashed border-amber-500 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:border-amber-600 dark:text-amber-400">
                {t.chat_temp_badge}
              </span>
              <p className="min-w-0 flex-1 text-sm text-amber-800 dark:text-amber-200">
                {t.chat_temp_banner}
              </p>
              {/* guided learning works in temporary chat too — stateless */}
              <TeachMeSwitch
                checked={tempTutor}
                disabled={streaming}
                onChange={() => setTempTutor((v) => !v)}
                t={t}
              />
            </div>
          </div>
        )}

        {/* lockdown toolbar — one row above the messages, normal threads only */}
        {!tempMode && activeThread && (
          <div className="border-b border-stone-200 dark:border-stone-800">
            <div className="flex items-center justify-between gap-3 px-4 py-2 sm:px-6">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-stone-700 dark:text-stone-200">
                  {activeThread.title}
                </p>
                <p className="text-xs text-stone-500 dark:text-stone-400">{t.chat_lockdown_hint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={handToAgent}
                  disabled={handBusy || streaming}
                  title={t.agent_hand}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-clay-dark hover:bg-clay-soft/60 disabled:opacity-50 dark:text-clay dark:hover:bg-stone-800"
                >
                  <Icon path={ICON.spark} className="h-4 w-4" />
                  {handBusy ? t.agent_handed : t.agent_hand}
                </button>
                <button
                  role="switch"
                  aria-checked={activeThread.lockdown}
                  onClick={toggleLockdown}
                  className="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1"
                >
                  <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
                    {t.chat_lockdown}
                  </span>
                  <span
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
                      activeThread.lockdown
                        ? "bg-clay"
                        : "bg-stone-300 dark:bg-stone-700"
                    }`}
                  >
                    <span
                      className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all ${
                        activeThread.lockdown ? "start-6" : "start-1"
                      }`}
                    />
                  </span>
                </button>
              </div>
            </div>
            {/* gem chip + guided-learning toggle — second header row */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2.5 sm:px-6">
              {activeGem && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-clay/40 bg-clay-soft px-3 py-1 text-xs font-medium text-clay-dark dark:border-stone-700 dark:bg-stone-800 dark:text-clay">
                  <span className="max-w-[12rem] truncate">{activeGem.name}</span>
                  <button
                    onClick={removeGem}
                    disabled={streaming}
                    aria-label={t.gm_remove}
                    title={t.gm_remove}
                    className="rounded-full p-0.5 text-clay-dark/60 transition-colors hover:bg-clay/20 hover:text-clay-dark disabled:opacity-50 dark:text-clay/70 dark:hover:bg-stone-700 dark:hover:text-clay"
                  >
                    <Icon path={ICON.close} className="h-3 w-3" />
                  </button>
                </span>
              )}
              <TeachMeSwitch
                checked={activeThread.tutorMode}
                disabled={streaming}
                onChange={toggleTutor}
                t={t}
              />
            </div>
            {handError && (
              <p role="alert" className="px-4 pb-2 text-xs text-red-700 sm:px-6 dark:text-red-400">
                {handError}
              </p>
            )}
          </div>
        )}

        {/* messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          {showEmpty ? (
            <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center">
              <h2 className="text-xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
                {tempMode ? t.chat_temp : t.chat_empty_title}
              </h2>
              <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
                {tempMode ? t.chat_temp_banner : t.chat_empty_sub}
              </p>
              {tempMode && (
                <span className="mt-3 inline-block rounded-full border border-dashed border-amber-500 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:border-amber-600 dark:text-amber-400">
                  {t.chat_temp_badge}
                </span>
              )}
              {selectedGem && selectedGem.starterPrompts.length > 0 ? (
                <>
                  <p className="mt-6 text-sm text-stone-500 dark:text-stone-400">
                    {t.gm_starter_label}
                  </p>
                  <div className="mt-3 w-full space-y-2.5">
                    {selectedGem.starterPrompts.map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          setComposer(p);
                          textareaRef.current?.focus();
                        }}
                        className="block w-full rounded-xl border border-stone-200 px-4 py-3 text-start text-sm text-stone-700 transition-colors hover:border-clay hover:bg-clay-soft/50 dark:border-stone-700 dark:text-stone-200 dark:hover:border-clay dark:hover:bg-stone-800"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="mt-6 w-full space-y-2.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="block w-full rounded-xl border border-stone-200 px-4 py-3 text-start text-sm text-stone-700 transition-colors hover:border-clay hover:bg-clay-soft/50 dark:border-stone-700 dark:text-stone-200 dark:hover:border-clay dark:hover:bg-stone-800"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-5">
              {loadingMessages && (
                <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
              )}
              {/* older messages were summarized into the context */}
              {showCompacted && (
                <div className="flex items-center gap-3" role="note">
                  <span className="h-px flex-1 bg-stone-200 dark:bg-stone-700" aria-hidden />
                  <span className="text-xs text-stone-400 dark:text-stone-500">{t.chat_compacted}</span>
                  <span className="h-px flex-1 bg-stone-200 dark:bg-stone-700" aria-hidden />
                </div>
              )}
              {shownMessages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  demoLabel={t.chat_demo}
                  freeLabel={t.chat_free_ai}
                  remember={
                    showRemember && m.role === "assistant"
                      ? {
                          onRemember: () => rememberMessage(m),
                          busy: rememberBusy === m.id,
                          done: !!remembered[m.id],
                          rememberLabel: t.m_remember,
                          rememberedLabel: t.m_remembered,
                        }
                      : null
                  }
                />
              ))}
              {showStreamBubble && (
                <div className="max-w-[95%]">
                  {streamDemo && (
                    <span className="mb-1.5 inline-block rounded-full border border-stone-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500 dark:border-stone-700 dark:text-stone-400">
                      {t.chat_demo}
                    </span>
                  )}
                  {thinking ? (
                    <ThinkingDots label={toolActivity || t.chat_thinking} />
                  ) : (
                    <>
                      {toolActivity && (
                        <p className="mb-1 text-xs text-stone-400 dark:text-stone-500">
                          {toolActivity}
                        </p>
                      )}
                      <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-stone-800 dark:text-stone-100">
                        {streamText}
                        <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-stone-400 align-middle dark:bg-stone-500" />
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* connector write confirmation — takes the reply's place */}
              {pendingConfirmation && (
                <ConfirmationCard
                  confirmation={pendingConfirmation}
                  connectorName={
                    connectors.find((c) => c.id === pendingConfirmation.connectorId)?.name ??
                    pendingConfirmation.connectorId
                  }
                  busy={confirmBusy}
                  error={confirmError}
                  t={t}
                  onConfirm={confirmAndResend}
                  onCancel={cancelConfirmation}
                />
              )}
              {confirmNote && !pendingConfirmation && (
                <p className="mx-auto max-w-2xl text-sm text-stone-500 dark:text-stone-400">
                  {confirmNote}
                </p>
              )}
            </div>
          )}
        </div>

        {/* inline error */}
        {error && (
          <div className="border-t border-stone-200 px-4 py-2.5 sm:px-6 dark:border-stone-800">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
              <Button variant="ghost" className="shrink-0 px-3 py-1.5 text-xs" onClick={retry}>
                {t.chat_retry}
              </Button>
            </div>
          </div>
        )}

        {/* composer */}
        <div className="border-t border-stone-200 px-4 py-3 sm:px-6 dark:border-stone-800">
          {/* attached files (chips) + inline upload errors */}
          {(attached.length > 0 || attachError) && (
            <div className="mx-auto mb-2 max-w-2xl">
              {attached.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {attached.map((a) => (
                    <span
                      key={a.key}
                      className="flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300"
                    >
                      <Icon path={ICON.clip} className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-[12rem] truncate">{a.name}</span>
                      {a.fileId === null && (
                        <span className="shrink-0 text-stone-400 dark:text-stone-500">
                          {t.chat_sending} {a.progress}%
                        </span>
                      )}
                      <button
                        onClick={() => removeAttachment(a.key)}
                        aria-label={t.chat_remove_file}
                        title={t.chat_remove_file}
                        className="rounded-full p-0.5 text-stone-400 hover:bg-stone-200/70 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-stone-700 dark:hover:text-stone-300"
                      >
                        <Icon path={ICON.close} className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {attachError && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400">{attachError}</p>
              )}
            </div>
          )}
        {/* connector chips — connected connectors only; toggled ones are
            sent as useConnectors with the next message. Hidden in temporary
            chat (server ignores connectors there anyway). */}
        {!tempMode && (
          <div className="mx-auto mb-2 max-w-2xl">
            {connectors.length === 0 ? (
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {t.chat_no_connector}{" "}
                <Link
                  href="/settings"
                  className="underline underline-offset-2 hover:text-stone-700 dark:hover:text-stone-200"
                >
                  {t.chat_connect_settings}
                </Link>
              </p>
            ) : (
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label={t.chat_connectors}
              >
                <span className="text-xs text-stone-500 dark:text-stone-400">
                  {t.chat_connectors}:
                </span>
                {connectors.map((c) => {
                  const on = selectedConnectors.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleConnector(c.id)}
                      disabled={streaming}
                      aria-pressed={on}
                      title={c.blurb}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                        on
                          ? "border-clay bg-clay-soft text-clay-dark dark:bg-stone-800 dark:text-clay"
                          : "border-stone-300 text-stone-500 hover:border-clay hover:text-clay-dark dark:border-stone-700 dark:text-stone-400 dark:hover:border-clay dark:hover:text-clay"
                      }`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
          <div className="mx-auto flex max-w-2xl items-end gap-2">
            {!tempMode && (
              <button
                onClick={() => fileInputRef.current?.click()}
                aria-label={t.chat_attach_file}
                title={t.chat_attach_file}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-200/60 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
              >
                <Icon path={ICON.clip} />
              </button>
            )}
            {!tempMode && (
              <button
                onClick={toggleRecording}
                disabled={streaming || voiceSending}
                aria-label={recording ? t.st_voice_stop : t.st_voice_record}
                title={recording ? t.st_voice_stop : t.st_voice_record}
                aria-pressed={recording}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${
                  recording
                    ? "bg-red-600 text-white hover:bg-red-700"
                    : "text-stone-500 hover:bg-stone-200/60 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
                }`}
              >
                <Icon path={ICON.mic} className={recording ? "h-5 w-5 animate-pulse" : undefined} />
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_FILES}
              className="hidden"
              onChange={handleFiles}
            />
            <textarea
              ref={textareaRef}
              rows={1}
              value={composer}
              maxLength={MAX_CONTENT}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder={t.chat_ask_placeholder}
              aria-label={t.chat_ask_placeholder}
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-stone-300 bg-white px-4 py-3 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500"
            />
            {streaming ? (
              <button
                onClick={stop}
                aria-label={t.chat_stop}
                title={t.chat_stop}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-stone-700 text-white transition-colors hover:bg-stone-800 dark:bg-stone-200 dark:text-stone-900 dark:hover:bg-white"
              >
                <Icon path={ICON.stop} className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={() => send(composer)}
                disabled={!composer.trim() || recording}
                aria-label={t.chat_send}
                title={t.chat_send}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-clay text-white transition-colors hover:bg-clay-dark disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon path={ICON.send} className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
