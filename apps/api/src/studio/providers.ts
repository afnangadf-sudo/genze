// Step 9 — Studio provider HTTP implementations (image, video, STT, TTS).
//
// Written against each vendor's public API docs; NOT live-verified without
// keys (same standing as the Step 7 Steel driver — decision #108). Tests
// stub globalThis.fetch and assert request shapes + response handling.
// Every function throws StudioProviderError on failure; callers map it to
// 502 PROVIDER_ERROR (provider call failed) — distinct from 503
// NO_PROVIDER_AVAILABLE (routing found nobody).

import type { ProviderId } from "@genze/shared";
import type { ImageModelInfo, VideoModelInfo } from "./catalog.js";
import { recordProviderFailure, recordProviderSuccess } from "../providers/circuit.js";

export class StudioProviderError extends Error {
  readonly code: "PROVIDER_ERROR" | "NOT_CONFIGURED";
  constructor(code: "PROVIDER_ERROR" | "NOT_CONFIGURED", message: string) {
    super(message);
    this.code = code;
  }
}

function providerError(provider: ProviderId, res: Response): StudioProviderError {
  return new StudioProviderError(
    "PROVIDER_ERROR",
    `The ${provider} request failed (HTTP ${res.status}). Please try again in a moment.`,
  );
}

function okJson(res: Response, provider: ProviderId): Promise<unknown> {
  if (!res.ok) throw providerError(provider, res);
  return res.json() as Promise<unknown>;
}

function openaiKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new StudioProviderError("NOT_CONFIGURED", "OpenAI is not configured.");
  return k;
}

function googleKey(): string {
  const k = process.env.GOOGLE_GENAI_API_KEY;
  if (!k) throw new StudioProviderError("NOT_CONFIGURED", "Google is not configured.");
  return k;
}

function klingKey(): string {
  const k = process.env.KLING_API_KEY;
  if (!k) throw new StudioProviderError("NOT_CONFIGURED", "Kling is not configured.");
  return k;
}

function elevenlabsKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new StudioProviderError("NOT_CONFIGURED", "ElevenLabs is not configured.");
  return k;
}

/* ---------------- images ---------------- */

export type ImageAspect = "square" | "wide" | "tall";

const OPENAI_SIZES: Record<ImageAspect, string> = {
  square: "1024x1024",
  wide: "1536x1024",
  tall: "1024x1536",
};

const GOOGLE_ASPECTS: Record<ImageAspect, string> = {
  square: "1:1",
  wide: "16:9",
  tall: "9:16",
};

async function openaiImage(
  model: ImageModelInfo,
  prompt: string,
  aspect: ImageAspect,
  editOf?: Buffer,
): Promise<Buffer> {
  const key = openaiKey();
  if (editOf) {
    const form = new FormData();
    form.append("model", model.id);
    form.append("prompt", prompt);
    form.append("image", new Blob([new Uint8Array(editOf)], { type: "image/png" }), "source.png");
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    const payload = (await okJson(res, "openai")) as { data?: Array<{ b64_json?: string }> };
    const b64 = payload.data?.[0]?.b64_json;
    if (!b64) throw new StudioProviderError("PROVIDER_ERROR", "OpenAI returned no image. Please try again.");
    recordProviderSuccess("openai");
    return Buffer.from(b64, "base64");
  }
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      prompt,
      size: OPENAI_SIZES[aspect],
      n: 1,
      response_format: "b64_json",
    }),
  });
  const payload = (await okJson(res, "openai")) as { data?: Array<{ b64_json?: string }> };
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) throw new StudioProviderError("PROVIDER_ERROR", "OpenAI returned no image. Please try again.");
  recordProviderSuccess("openai");
  return Buffer.from(b64, "base64");
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

async function googleImage(
  model: ImageModelInfo,
  prompt: string,
  aspect: ImageAspect,
  editOf?: Buffer,
): Promise<Buffer> {
  const key = googleKey();
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (editOf) {
    parts.unshift({
      inlineData: { mimeType: "image/png", data: editOf.toString("base64") },
    });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: GOOGLE_ASPECTS[aspect] },
        },
      }),
    },
  );
  const payload = (await okJson(res, "google")) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  };
  const partsOut = payload.candidates?.[0]?.content?.parts ?? [];
  const img = partsOut.find((p) => p.inlineData?.data);
  if (!img?.inlineData?.data) {
    throw new StudioProviderError("PROVIDER_ERROR", "Google returned no image. Please try again.");
  }
  recordProviderSuccess("google");
  return Buffer.from(img.inlineData.data, "base64");
}

/** Generate (or edit, when editOf is set) one image. Returns PNG bytes. */
export async function generateImageBytes(
  model: ImageModelInfo,
  prompt: string,
  aspect: ImageAspect,
  editOf?: Buffer,
): Promise<Buffer> {
  try {
    if (model.provider === "openai") return await openaiImage(model, prompt, aspect, editOf);
    if (model.provider === "google") return await googleImage(model, prompt, aspect, editOf);
    throw new StudioProviderError("PROVIDER_ERROR", "This provider can't generate images.");
  } catch (err) {
    if (err instanceof StudioProviderError && err.code === "PROVIDER_ERROR") {
      recordProviderFailure(model.provider, err);
    }
    throw err;
  }
}

/* ---------------- video ---------------- */

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 24; // ~2 minutes of polling; longer renders fail honestly

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Veo 3.1 via the Gemini API: predictLongRunning -> poll -> download bytes. */
async function veoShot(model: VideoModelInfo, prompt: string, durationS: number): Promise<Buffer> {
  const key = googleKey();
  const start = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:predictLongRunning`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { durationSeconds: durationS, aspectRatio: "16:9" },
      }),
    },
  );
  const started = (await okJson(start, "google")) as { name?: string };
  if (!started.name) throw new StudioProviderError("PROVIDER_ERROR", "Google didn't start the video. Please try again.");
  const opUrl = `https://generativelanguage.googleapis.com/v1beta/${started.name}`;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(opUrl, { headers: { "x-goog-api-key": key } });
    const op = (await okJson(res, "google")) as {
      done?: boolean;
      error?: { message?: string };
      response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
    };
    if (op.error) throw new StudioProviderError("PROVIDER_ERROR", "Google couldn't render that clip. Please try again.");
    if (op.done) {
      const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new StudioProviderError("PROVIDER_ERROR", "Google finished without a video file. Please try again.");
      const dl = await fetch(uri, { headers: { "x-goog-api-key": key } });
      if (!dl.ok) throw providerError("google", dl);
      recordProviderSuccess("google");
      return Buffer.from(await dl.arrayBuffer());
    }
  }
  throw new StudioProviderError(
    "PROVIDER_ERROR",
    "The video is taking too long to render. Please try again in a moment.",
  );
}

/**
 * Kling 3.0 text-to-video: create task -> poll -> download bytes.
 * NOTE: the exact API model_name value is unverified without a key; the
 * catalog id "kling-3.0" is sent and flagged for a live check before launch.
 */
async function klingShot(model: VideoModelInfo, prompt: string, durationS: number): Promise<Buffer> {
  const key = klingKey();
  const create = await fetch("https://api.klingai.com/v1/videos/text2video", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model_name: model.id,
      prompt,
      duration: String(durationS),
      aspect_ratio: "16:9",
      mode: "std",
    }),
  });
  const created = (await okJson(create, "kling")) as {
    code?: number;
    data?: { task_id?: string };
  };
  const taskId = created.data?.task_id;
  if (!taskId) throw new StudioProviderError("PROVIDER_ERROR", "Kling didn't start the video. Please try again.");
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const task = (await okJson(res, "kling")) as {
      data?: {
        task_status?: string;
        task_result?: { videos?: Array<{ url?: string }> };
      };
    };
    const status = task.data?.task_status;
    if (status === "failed") {
      throw new StudioProviderError("PROVIDER_ERROR", "Kling couldn't render that clip. Please try again.");
    }
    if (status === "succeed") {
      const url = task.data?.task_result?.videos?.[0]?.url;
      if (!url) throw new StudioProviderError("PROVIDER_ERROR", "Kling finished without a video file. Please try again.");
      const dl = await fetch(url);
      if (!dl.ok) throw providerError("kling", dl);
      recordProviderSuccess("kling");
      return Buffer.from(await dl.arrayBuffer());
    }
  }
  throw new StudioProviderError(
    "PROVIDER_ERROR",
    "The video is taking too long to render. Please try again in a moment.",
  );
}

/** Render one shot; returns MP4 bytes. */
export async function generateVideoShotBytes(
  model: VideoModelInfo,
  prompt: string,
  durationS: number,
): Promise<Buffer> {
  try {
    if (model.provider === "google") return await veoShot(model, prompt, durationS);
    if (model.provider === "kling") return await klingShot(model, prompt, durationS);
    throw new StudioProviderError("PROVIDER_ERROR", "This provider can't generate video.");
  } catch (err) {
    if (err instanceof StudioProviderError && err.code === "PROVIDER_ERROR") {
      recordProviderFailure(model.provider, err);
    }
    throw err;
  }
}

/* ---------------- speech to text ---------------- */

/** Whisper (primary STT). */
export async function transcribeWithWhisper(
  audio: Buffer,
  mime: string,
  filename: string,
): Promise<string> {
  const key = openaiKey();
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), filename);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  const payload = (await okJson(res, "openai")) as { text?: string };
  recordProviderSuccess("openai");
  return typeof payload.text === "string" ? payload.text : "";
}

/** Google STT fallback: Gemini transcribes the audio inline. */
export async function transcribeWithGoogle(audio: Buffer, mime: string): Promise<string> {
  const key = googleKey();
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: mime, data: audio.toString("base64") } },
              {
                text: "Transcribe the speech in this audio exactly, in its original language. Reply with the transcript text only.",
              },
            ],
          },
        ],
      }),
    },
  );
  const payload = (await okJson(res, "google")) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  };
  recordProviderSuccess("google");
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/* ---------------- text to speech ---------------- */

/** OpenAI tts-1. `voice` picks the speaker (alternated for dialogues). */
export async function speakWithOpenAI(text: string, voice: string): Promise<Buffer> {
  const key = openaiKey();
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "tts-1", input: text, voice, response_format: "mp3" }),
  });
  if (!res.ok) throw providerError("openai", res);
  recordProviderSuccess("openai");
  return Buffer.from(await res.arrayBuffer());
}

/** Google Cloud TTS. `languageCode` is BCP-47 (e.g. "ur-PK"). */
export async function speakWithGoogle(text: string, languageCode: string): Promise<Buffer> {
  const key = googleKey();
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: `${languageCode}-Wavenet-A` },
      audioConfig: { audioEncoding: "MP3" },
    }),
  });
  const payload = (await okJson(res, "google")) as { audioContent?: string };
  if (!payload.audioContent) {
    throw new StudioProviderError("PROVIDER_ERROR", "Google returned no audio. Please try again.");
  }
  recordProviderSuccess("google");
  return Buffer.from(payload.audioContent, "base64");
}

/** ElevenLabs (eleven_multilingual_v2). Only called for covered languages. */
export async function speakWithElevenLabs(text: string): Promise<Buffer> {
  const key = elevenlabsKey();
  const voiceId = "21m00Tcm4TlvDq8ikWAM"; // Rachel (stock voice)
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw providerError("elevenlabs", res);
  recordProviderSuccess("elevenlabs");
  return Buffer.from(await res.arrayBuffer());
}
