// Studio API client: images, voice (transcribe/speak/chat voice notes),
// video director (estimate gate, SSE progress, shot ops), audio overviews.
// Every route comes from API_ROUTES (@genze/shared) — never hardcoded.
// Auth follows lib/auth (apiFetch with 401 -> refresh -> retry); streaming
// endpoints (video SSE, chat voice note) reuse the refresh-once pattern
// because apiFetch can't stream a Response body.

import {
  API_ROUTES,
  type AudioOverview,
  type AudioOverviewLength,
  type StudioImage,
  type StudioTranscript,
  type StudioVideo,
  type StudioVideoEvent,
} from "@genze/shared";
import type { ExtendedChatStreamEvent } from "./chat";
import { API_BASE, ApiClientError, apiFetch, getTokens, setTokens } from "./auth";

/* ---------- shared helpers ---------- */

async function toApiError(res: Response): Promise<ApiClientError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null =
    null;
  try {
    body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
  } catch {
    /* not JSON */
  }
  const code = body?.error?.code ?? "UNKNOWN";
  const message = body?.error?.message ?? `Request failed (${res.status})`;
  return new ApiClientError(code, message, res.status, body?.error?.details);
}

async function refreshOnce(): Promise<boolean> {
  const { refresh } = getTokens();
  if (!refresh) return false;
  try {
    const res = await fetch(`${API_BASE}${API_ROUTES.refresh}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { accessToken?: string; refreshToken?: string } };
    const tokens = json.data;
    if (tokens?.accessToken && tokens?.refreshToken) {
      setTokens(tokens.accessToken, tokens.refreshToken);
      return true;
    }
  } catch {
    /* network failure */
  }
  return false;
}

/** Authenticated multipart POST (no progress events needed here). */
async function postMultipart<T>(path: string, form: FormData): Promise<T> {
  const attempt = () => {
    const { access } = getTokens();
    return fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: access ? { Authorization: `Bearer ${access}` } : {},
      body: form,
    });
  };
  let res = await attempt();
  if (res.status === 401 && (await refreshOnce())) res = await attempt();
  if (!res.ok) throw await toApiError(res);
  const json = (await res.json()) as { data?: T };
  if (!json.data) throw new ApiClientError("UNKNOWN", "Request failed", res.status);
  return json.data;
}

/* ---------- images ---------- */

export async function generateImage(
  prompt: string,
  aspectRatio?: "square" | "wide" | "tall"
): Promise<StudioImage> {
  const data = await apiFetch<{ image: StudioImage }>(API_ROUTES.studioImages, {
    method: "POST",
    body: JSON.stringify({ prompt, ...(aspectRatio ? { aspectRatio } : {}) }),
  });
  return data.image;
}

export async function listImages(): Promise<StudioImage[]> {
  const data = await apiFetch<{ images: StudioImage[] }>(API_ROUTES.studioImages);
  return data.images;
}

export async function getImage(id: string): Promise<StudioImage> {
  const data = await apiFetch<{ image: StudioImage }>(API_ROUTES.studioImage(id));
  return data.image;
}

/** New picture based on an existing one + a change description. */
export async function editImage(id: string, prompt: string): Promise<StudioImage> {
  const data = await apiFetch<{ image: StudioImage }>(API_ROUTES.studioImageEdit(id), {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  return data.image;
}

/* ---------- voice ---------- */

/** Upload an audio file, get the words written out. */
export async function transcribeAudio(file: Blob): Promise<StudioTranscript> {
  const form = new FormData();
  form.append("audio", file, "recording");
  const data = await postMultipart<{ transcript: string }>(API_ROUTES.studioVoiceTranscribe, form);
  return { text: data.transcript };
}

/** Speak text aloud — returns a signed audio URL. Language is any BCP-47 code. */
export async function speakText(text: string, language: string): Promise<string> {
  const data = await apiFetch<{ audioUrl: string }>(API_ROUTES.studioVoiceSpeak, {
    method: "POST",
    body: JSON.stringify({ text, language }),
  });
  return signedUrl(data.audioUrl);
}

/**
 * Post a chat voice note: the audio goes up as multipart, the assistant's
 * reply streams back as the same SSE events as a normal message.
 */
export async function streamChatVoiceNote(
  threadId: string,
  audio: Blob,
  {
    onEvent,
    signal,
  }: { onEvent: (event: ExtendedChatStreamEvent) => void; signal?: AbortSignal }
): Promise<void> {
  const buildForm = () => {
    const form = new FormData();
    form.append("audio", audio, "voice-note");
    return form;
  };
  const attempt = () => {
    const { access } = getTokens();
    return fetch(`${API_BASE}${API_ROUTES.chatThreadVoice(threadId)}`, {
      method: "POST",
      headers: access ? { Authorization: `Bearer ${access}` } : {},
      body: buildForm(),
      signal,
    });
  };
  let res = await attempt();
  if (res.status === 401 && (await refreshOnce())) res = await attempt();
  if (!res.ok) throw await toApiError(res);
  await readSSE(res, onEvent);
}

const VOICE_KNOWN_EVENT_TYPES = new Set([
  "start",
  "token",
  "compacted",
  "done",
  "error",
  "tool_activity",
  "confirmation_required",
]);

async function readSSE(res: Response, onEvent: (event: ExtendedChatStreamEvent) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith(":")) continue;
      if (!text.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(text.slice(5).trim()) as { type?: string };
        if (ev && typeof ev.type === "string" && VOICE_KNOWN_EVENT_TYPES.has(ev.type)) {
          onEvent(ev as ExtendedChatStreamEvent);
        }
      } catch {
        /* ignore malformed lines */
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatch(chunk);
      }
    }
    if (buffer.trim().length > 0) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}

/* ---------- video director ---------- */

export async function createVideo(brief: string, targetMinutes: number): Promise<StudioVideo> {
  const data = await apiFetch<{ video: StudioVideo }>(API_ROUTES.studioVideos, {
    method: "POST",
    body: JSON.stringify({ brief, targetMinutes }),
  });
  return data.video;
}

export async function listVideos(): Promise<StudioVideo[]> {
  const data = await apiFetch<{ videos: StudioVideo[] }>(API_ROUTES.studioVideos);
  return data.videos;
}

export async function getVideo(id: string): Promise<StudioVideo> {
  const data = await apiFetch<{ video: StudioVideo }>(API_ROUTES.studioVideo(id));
  return data.video;
}

/**
 * The approval gate: generation never starts until the user taps approve.
 * Discard is implicit — the client simply never calls this.
 */
export async function approveVideo(id: string): Promise<StudioVideo> {
  const data = await apiFetch<{ video: StudioVideo }>(API_ROUTES.studioVideoApprove(id), {
    method: "POST",
  });
  return data.video;
}

export async function deleteVideo(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(API_ROUTES.studioVideo(id), { method: "DELETE" });
}

export async function regenerateShot(videoId: string, shotId: string): Promise<StudioVideo> {
  const data = await apiFetch<{ video: StudioVideo }>(API_ROUTES.studioVideoShotRegenerate(videoId, shotId), {
    method: "POST",
  });
  return data.video;
}

export async function reorderShots(
  videoId: string,
  shotId: string,
  order: string[]
): Promise<StudioVideo> {
  const data = await apiFetch<{ video: StudioVideo }>(
    API_ROUTES.studioVideoShotReorder(videoId, shotId),
    { method: "PATCH", body: JSON.stringify({ order }) }
  );
  return data.video;
}

export async function deleteShot(videoId: string, shotId: string): Promise<StudioVideo> {
  const data = await apiFetch<{ video: StudioVideo }>(API_ROUTES.studioVideoShot(videoId, shotId), {
    method: "DELETE",
  });
  return data.video;
}

export interface StudioVideoEventsCallbacks {
  onProgress: (ev: Extract<StudioVideoEvent, { type: "progress" }>) => void;
  onShot: (ev: Extract<StudioVideoEvent, { type: "shot" }>) => void;
  /** A terminal status arrived (done / failed / discarded). */
  onTerminal: (video: StudioVideo) => void;
  onError: (err: unknown) => void;
}

/**
 * Subscribes to a video's making progress. Tries the SSE /events endpoint
 * first; if it can't be established, falls back to polling GET
 * /studio/videos/:id every 2 s until a terminal status. Returns a stop
 * function the caller must run on unmount/video change.
 */
export function subscribeStudioVideo(id: string, cb: StudioVideoEventsCallbacks): () => void {
  let stopped = false;
  const controller = new AbortController();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    stopped = true;
    controller.abort();
    if (pollTimer) clearInterval(pollTimer);
  };

  function startPolling() {
    if (stopped) return;
    const tick = async () => {
      if (stopped) return;
      try {
        const video = await getVideo(id);
        if (stopped) return;
        if (video.status === "done" || video.status === "failed" || video.status === "discarded") {
          cb.onTerminal(video);
          stop();
        }
        // else: nothing new to report — the poll just keeps the connection alive
      } catch (err) {
        cb.onError(err);
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), 2000);
  }

  async function runSSE() {
    const url = `${API_BASE}${API_ROUTES.studioVideoEvents(id)}`;
    const attempt = async (): Promise<Response> => {
      const { access } = getTokens();
      return fetch(url, {
        headers: access ? { Authorization: `Bearer ${access}` } : {},
        signal: controller.signal,
      });
    };
    let res: Response;
    try {
      res = await attempt();
    } catch {
      startPolling();
      return;
    }
    if (res.status === 401 && (await refreshOnce())) {
      try {
        res = await attempt();
      } catch {
        startPolling();
        return;
      }
    }
    if (!res.ok || !res.body) {
      startPolling();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawTerminal = false;

    const dispatch = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const text = line.trim();
        if (!text || text.startsWith(":")) continue;
        if (!text.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(text.slice(5).trim()) as StudioVideoEvent;
          if (ev.type === "progress") {
            cb.onProgress(ev);
          } else if (ev.type === "shot") {
            cb.onShot(ev);
          } else if (ev.type === "done") {
            sawTerminal = true;
            getVideo(id)
              .then((video) => {
                if (!stopped) cb.onTerminal(video);
                stop();
              })
              .catch(() => {
                if (!stopped) startPolling();
              });
          } else if (ev.type === "error") {
            sawTerminal = true;
            cb.onError(new ApiClientError(ev.code, ev.message, 0));
            stop();
          }
        } catch {
          /* ignore malformed lines */
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          dispatch(chunk);
        }
      }
      if (buffer.trim().length > 0) dispatch(buffer);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      if (!sawTerminal && !stopped) startPolling();
      return;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    if (!sawTerminal && !stopped) startPolling();
  }

  void runSSE();
  return stop;
}

/* ---------- audio overviews ---------- */

export async function createAudioOverview(
  fileIds: string[],
  length: AudioOverviewLength
): Promise<AudioOverview> {
  const data = await apiFetch<{ overview: AudioOverview }>(API_ROUTES.studioAudioOverviews, {
    method: "POST",
    body: JSON.stringify({ fileIds, length }),
  });
  return data.overview;
}

export async function listAudioOverviews(): Promise<AudioOverview[]> {
  const data = await apiFetch<{ overviews: AudioOverview[] }>(API_ROUTES.studioAudioOverviews);
  return data.overviews;
}

export async function getAudioOverview(id: string): Promise<AudioOverview> {
  const data = await apiFetch<{ overview: AudioOverview }>(API_ROUTES.studioAudioOverview(id));
  return data.overview;
}

/** Prefix the API base onto a relative signed URL (never raw bytes in state). */
export function signedUrl(relativeUrl: string): string {
  return relativeUrl.startsWith("http") ? relativeUrl : `${API_BASE}${relativeUrl}`;
}
