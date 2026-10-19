// Step 9 tests: Studio images, voice (STT/TTS + coverage matrix), Video
// Director (estimate-before-generate gate, per-shot ops, cost accounting),
// Audio Overviews, studio consent, boot sweeps.
//
// Provider HTTP is stubbed by replacing globalThis.fetch with a dispatcher
// (step4 pattern). No real network, no real keys. Env keys are obviously-fake
// words; the key assignments are patched in via shell (decision #79 — the
// file-write pipeline mangles provider-looking literals).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  STUDIO_VIDEO_STAGE_IDS,
  type AudioOverview,
  type StudioImage,
  type StudioVideo,
} from "@genze/shared";
import { buildApp } from "../src/index.js";
import { closePool, getPool } from "../src/db.js";
import { closeRedis } from "../src/redis.js";
import { getStorage } from "../src/storage/index.js";
import { authHeader, multipartBody } from "./helpers.js";
import { testEmailOutbox } from "../src/email.js";
import {
  VOICE_CHECK_LANGUAGES,
  VOICE_COVERAGE,
  ttsCandidates,
  voiceCovers,
} from "../src/studio/voice.js";
import {
  IMAGE_CATALOG,
  VIDEO_CATALOG,
  isDeadModelId,
  isVideoModelRetired,
  normalizeShotDuration,
  pickImageProvider,
  pickVideoProvider,
  videoShotCostUsd,
} from "../src/studio/catalog.js";
import {
  sweepStaleVideoProjects,
  videoMaxSecondsPerProject,
  videoMaxSpendUsd,
} from "../src/studio/video/runner.js";
import { sweepStaleStudioImages } from "../src/studio/images.js";
import { sweepStaleAudioOverviews } from "../src/studio/audioOverviews.js";
import { __setAssemblyOverride } from "../src/studio/video/assembly.js";

// Test-only provider keys: obviously-fake words (never real secrets). The
// global fetch stub intercepts ALL provider HTTP, so these never leave the
// process. Assigned via a helper (not literal process.env.X = "..." lines)
// per decision #79 — the file-write pipeline mangles provider-looking
// literals.
const WORDS_ONLY_KEY = "words-only-test-key";
function setProviderKeys(keys: Record<string, boolean>): void {
  const map: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENAI_API_KEY",
    kling: "KLING_API_KEY",
    elevenlabs: "ELEVENLABS_API_KEY",
  };
  for (const [k, env] of Object.entries(map)) {
    if (keys[k]) process.env[env] = WORDS_ONLY_KEY;
    else delete process.env[env];
  }
}


// Proven-safe env lines (same as step4.test.ts).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-that-is-long-enough-1";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-that-is-long-enough-1";
process.env.REDIS_URL = "";
process.env.APP_URL = "http://localhost:3000";

const MANAGED = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "KLING_API_KEY",
  "ELEVENLABS_API_KEY",
  "PROVIDER_DISABLED",
  "FREE_AI_ENABLED",
  "VIDEO_MAX_SECONDS_PER_PROJECT",
  "VIDEO_MAX_SPEND_USD",
];

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedFetch = globalThis.fetch;
  whisperShouldFail = false;
  fetchLog.length = 0;
  __setAssemblyOverride(null);
  process.env.FREE_AI_ENABLED = "false"; // restore zero-keys -> demo world
});

afterEach(async () => {
  for (const k of MANAGED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch!;
  __setAssemblyOverride(null);
  // Decision #115: clean up rows (users cascade everything).
  if (createdUserIds.length > 0) {
    await getPool().query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds.length = 0;
  }
});

/* ---------------- fetch stub ---------------- */

const FAKE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FAKE_MP3_B64 = Buffer.from("ID3-FAKEAUDIO-BYTES").toString("base64");
const FAKE_MP3 = Buffer.from("ID3-FAKEAUDIO-BYTES");
const FAKE_MP4 = Buffer.from("FAKE-MP4-BYTES");

interface LoggedCall {
  url: string;
  method: string;
}
const fetchLog: LoggedCall[] = [];
let whisperShouldFail = false;

function sseWithText(text: string): string {
  const data = (o: unknown) => `data: ${JSON.stringify(o)}\n`;
  return (
    "event: message_start\n" +
    data({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } }) +
    "\n" +
    "event: content_block_delta\n" +
    data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    "\n" +
    "event: message_delta\n" +
    data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
    "\n" +
    "event: message_stop\n" +
    data({ type: "message_stop" }) +
    "\n"
  );
}

const STORYBOARD_JSON = JSON.stringify({
  shots: [
    { prompt: "A misty mountain at dawn, cinematic wide shot", durationSeconds: 8 },
    { prompt: "A river valley at noon, slow aerial drift", durationSeconds: 8 },
  ],
});

function stubFetch(): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    fetchLog.push({ url: u, method });

    if (u.includes("api.anthropic.com")) {
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as { system?: string };
      const system = String(body.system ?? "");
      let text = "Hello there";
      if (system.includes("video scriptwriter")) {
        text = "This is the narration. It describes misty mountains and a river valley. A third sentence adds drama.";
      } else if (system.includes("storyboard artist")) {
        text = STORYBOARD_JSON;
      } else if (system.includes("two-host podcast dialogue")) {
        text = "Host A: Welcome to the overview.\nHost B: Thanks, let's dive into the file.\nHost A: The file covers misty mountains.";
      }
      return new Response(sseWithText(text), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (u.includes("api.openai.com/v1/images/generations") || u.includes("api.openai.com/v1/images/edits")) {
      return Response.json({ data: [{ b64_json: FAKE_PNG_B64 }] });
    }
    if (u.includes("api.openai.com/v1/audio/transcriptions")) {
      if (whisperShouldFail) return new Response("boom", { status: 500 });
      return Response.json({ text: "hello from the voice note" });
    }
    if (u.includes("api.openai.com/v1/audio/speech")) {
      return new Response(FAKE_MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    if (u.includes("generativelanguage.googleapis.com")) {
      if (u.includes(":predictLongRunning")) {
        return Response.json({ name: "operations/test-op-1" });
      }
      if (u.includes("/operations/")) {
        return Response.json({
          done: true,
          response: {
            generateVideoResponse: { generatedSamples: [{ video: { uri: "https://genze.test/fake-clip.mp4" } }] },
          },
        });
      }
      if (u.includes(":generateContent")) {
        if (u.includes("gemini-nano-banana")) {
          return Response.json({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: FAKE_PNG_B64 } }] } }],
          });
        }
        // Gemini STT fallback.
        return Response.json({ candidates: [{ content: { parts: [{ text: "hello from google stt" }] } }] });
      }
    }
    if (u === "https://genze.test/fake-clip.mp4") {
      return new Response(FAKE_MP4, { status: 200, headers: { "content-type": "video/mp4" } });
    }
    if (u.includes("api.klingai.com/v1/videos/text2video/")) {
      return Response.json({ data: { task_status: "succeed", task_result: { videos: [{ url: "https://genze.test/fake-clip.mp4" }] } } });
    }
    if (u.includes("api.klingai.com/v1/videos/text2video")) {
      return Response.json({ code: 0, data: { task_id: "task-1" } });
    }
    if (u.includes("texttospeech.googleapis.com")) {
      return Response.json({ audioContent: FAKE_MP3_B64 });
    }
    if (u.includes("api.elevenlabs.io")) {
      return new Response(FAKE_MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error(`unexpected fetch in test: ${method} ${u}`);
  }) as typeof fetch;
}

/* ---------------- helpers ---------------- */

let app: FastifyInstance;
const createdUserIds: string[] = [];
const email = (tag: string) => `s9-${tag}-${randomUUID().slice(0, 8)}@example.com`.toLowerCase();

function lastTokenFor(to: string): string {
  const found = [...testEmailOutbox].reverse().find((e) => e.to === to);
  if (!found) throw new Error(`no token email for ${to}`);
  const m = found.text.match(/token=([0-9a-f]+)/);
  if (!m) throw new Error("no token in email");
  return m[1];
}

async function signup(tag: string, country = "PK"): Promise<{ token: string; userId: string }> {
  const em = email(tag);
  let res = await app.inject({ method: "POST", url: API_ROUTES.signup, payload: { email: em, password: "password123", country } });
  expect(res.statusCode).toBe(201);
  const userId = res.json().data.user.id as string;
  res = await app.inject({ method: "POST", url: API_ROUTES.verifyEmail, payload: { token: lastTokenFor(em) } });
  expect(res.statusCode).toBe(200);
  res = await app.inject({ method: "POST", url: API_ROUTES.login, payload: { email: em, password: "password123" } });
  expect(res.statusCode).toBe(200);
  createdUserIds.push(userId);
  return { token: (res.json().data.tokens as { accessToken: string }).accessToken, userId };
}

async function grantChatConsent(token: string, ids: string[]): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: API_ROUTES.chatConsent,
    headers: authHeader(token),
    payload: { providerIds: ids },
  });
  expect([200, 201]).toContain(res.statusCode);
}

async function grantStudioConsent(token: string, ids: string[]): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: API_ROUTES.studioConsent,
    headers: authHeader(token),
    payload: { providerIds: ids },
  });
  expect(res.statusCode).toBe(200);
}

async function pollUntil<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

function sseEvents(payload: string): Array<Record<string, unknown>> {
  return payload
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice(5).trim()) as Record<string, unknown>);
}

function voiceUpload(token: string, url: string, mime = "audio/mpeg") {
  const { payload, contentType } = multipartBody("note.m4a", mime, Buffer.from("fake-audio-bytes"));
  return app.inject({ method: "POST", url, headers: { ...authHeader(token), "content-type": contentType }, payload });
}

beforeAll(async () => {
  app = await buildApp({ disableRateLimit: true });
});

afterAll(async () => {
  await closePool();
  await closeRedis();
});

/* ---------------- images ---------------- */

describe("studio images", () => {
  it("routes to the cheapest provider and generates in the background", async () => {
    setProviderKeys({ openai: true, google: true, anthropic: true });
    stubFetch();
    const { token } = await signup("img1");
    await grantStudioConsent(token, ["openai", "google"]);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a misty mountain at dawn", aspectRatio: "wide" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data.image as StudioImage;
    expect(created.status).toBe("pending");
    expect(created.imageUrl).toBeNull();

    const ready = await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioImage(created.id), headers: authHeader(token) });
      return r.json().data.image as StudioImage;
    }, (img) => img.status === "ready");
    expect(ready.imageUrl).toContain(`/api/v1/studio/images/${created.id}/download`);

    // Cheapest (openai flare $0.01) won over google ($0.0336).
    expect(fetchLog.some((c) => c.url.includes("api.openai.com/v1/images/generations"))).toBe(true);
    expect(fetchLog.some((c) => c.url.includes("generativelanguage.googleapis.com"))).toBe(false);

    // Signed download serves the bytes.
    const dl = await app.inject({ method: "GET", url: ready.imageUrl as string });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("image/png");

    // Metering: one cost-only row.
    const m = await getPool().query<{ units: string; cost_usd: string; provider: string }>(
      "SELECT units, cost_usd, provider FROM usage_events WHERE feature = 'image'",
    );
    expect(m.rowCount).toBe(1);
    expect(m.rows[0].provider).toBe("openai");
    expect(Number(m.rows[0].cost_usd)).toBeCloseTo(0.01, 5);

    // Library image group.
    const lib = await app.inject({ method: "GET", url: API_ROUTES.library, headers: authHeader(token) });
    const groups = lib.json().data.groups as Array<{ type: string; items: Array<Record<string, unknown>> }>;
    const images = groups.find((g) => g.type === "image")!;
    expect(images.items.length).toBe(1);
    expect(images.items[0].title).toBe("a misty mountain at dawn");
    expect(typeof images.items[0].thumbnailUrl).toBe("string");
  });

  it("honors an explicit provider choice", async () => {
    setProviderKeys({ openai: true, google: true });
    stubFetch();
    const { token } = await signup("img2");
    await grantStudioConsent(token, ["openai", "google"]);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a calm lake", provider: "google" },
    });
    expect(res.statusCode).toBe(201);
    await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioImage(res.json().data.image.id), headers: authHeader(token) });
      return r.json().data.image.status as string;
    }, (s) => s === "ready");
    expect(fetchLog.some((c) => c.url.includes("gemini-nano-banana"))).toBe(true);
  });

  it("rejects dead model ids (sora / imagen-4) with 400", async () => {
    setProviderKeys({ openai: true });
    stubFetch();
    const { token } = await signup("img3");
    for (const provider of ["imagen-4", "imagen-4-ultra", "sora", "sora-2"]) {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.studioImages,
        headers: authHeader(token),
        payload: { prompt: "a cat", provider },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(isDeadModelId("sora-2")).toBe(true);
    expect(isDeadModelId("imagen-4")).toBe(true);
    expect(isDeadModelId("gpt-image-2.5-flare")).toBe(false);
  });

  it("validates input and consent, and 503s with no provider", async () => {
    stubFetch();
    const { token } = await signup("img4");
    // No keys at all.
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a cat" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NO_PROVIDER_AVAILABLE");

    setProviderKeys({ openai: true });
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a cat" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CONSENT_REQUIRED");

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "ab" },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a cat", aspectRatio: "diagonal" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("edits an image (image + prompt variation)", async () => {
    setProviderKeys({ openai: true });
    stubFetch();
    const { token } = await signup("img5");
    await grantStudioConsent(token, ["openai"]);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a red bicycle" },
    });
    const id = res.json().data.image.id as string;
    await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioImage(id), headers: authHeader(token) });
      return r.json().data.image.status as string;
    }, (s) => s === "ready");

    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImageEdit(id),
      headers: authHeader(token),
      payload: { prompt: "make it blue" },
    });
    expect(res.statusCode).toBe(201);
    const editId = res.json().data.image.id as string;
    expect(editId).not.toBe(id);
    await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioImage(editId), headers: authHeader(token) });
      return r.json().data.image.status as string;
    }, (s) => s === "ready");
    expect(fetchLog.some((c) => c.url.includes("/v1/images/edits"))).toBe(true);
  });

  it("unit: pickImageProvider is cheapest-first and fail-closed", () => {
    const withKeys = () => {
      process.env.OPENAI_API_KEY = "words-only-test-key";
      process.env.GOOGLE_GENAI_API_KEY = "words-only-test-key";
    };
    withKeys();
    const cheapest = pickImageProvider("PK");
    expect(cheapest?.provider).toBe("openai");
    expect(cheapest?.model.id).toBe("gpt-image-2.5-flare");
    expect(pickImageProvider("PK", "google")?.model.id).toBe("gemini-nano-banana-2.1");
    expect(pickImageProvider("PK", "nope")).toBeNull();
    expect(pickImageProvider("XX")).toBeNull();
    expect(IMAGE_CATALOG[0].costUsdPerImage).toBe(0.01);
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
  });
});

/* ---------------- voice: coverage matrix ---------------- */

describe("voice coverage matrix", () => {
  it("covers all five v1 languages honestly, and never routes ur/fa to ElevenLabs", () => {
    for (const lang of VOICE_CHECK_LANGUAGES) {
      // Whisper STT covers everything.
      expect(voiceCovers("openai", "stt", lang)).toBe(true);
      // OpenAI + Google TTS cover everything.
      expect(voiceCovers("openai", "tts", lang)).toBe(true);
      expect(voiceCovers("google", "tts", lang)).toBe(true);
    }
    // ElevenLabs (eleven_multilingual_v2, verified 2026-10-19): en/ar/tr yes, ur/fa no.
    expect(voiceCovers("elevenlabs", "tts", "en")).toBe(true);
    expect(voiceCovers("elevenlabs", "tts", "ar")).toBe(true);
    expect(voiceCovers("elevenlabs", "tts", "tr")).toBe(true);
    expect(voiceCovers("elevenlabs", "tts", "ur")).toBe(false);
    expect(voiceCovers("elevenlabs", "tts", "fa")).toBe(false);
    expect(VOICE_COVERAGE.elevenlabs.tts).toEqual(["en", "ar", "tr"]);
  });

  it("routing picks a covering provider per language, cheapest first", () => {
    process.env.OPENAI_API_KEY = "words-only-test-key";
    process.env.GOOGLE_GENAI_API_KEY = "words-only-test-key";
    process.env.ELEVENLABS_API_KEY = "words-only-test-key";
    for (const lang of VOICE_CHECK_LANGUAGES) {
      const cands = ttsCandidates("PK", lang);
      expect(cands.length).toBeGreaterThan(0);
      // Google (free tier) first, then OpenAI.
      expect(cands[0]).toBe("google");
      // ur/fa must never include elevenlabs (coverage), en may (region table
      // is fail-closed for elevenlabs today — see honest limitation note).
      if (lang === "ur" || lang === "fa") expect(cands).not.toContain("elevenlabs");
      for (const c of cands) expect(voiceCovers(c, "tts", lang)).toBe(true);
    }
    // Unknown language: only broad-coverage providers qualify (google "*").
    const xx = ttsCandidates("PK", "xx");
    expect(xx).toEqual(["google"]);
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
  });
});

/* ---------------- voice: TTS ---------------- */

describe("studio voice: TTS", () => {
  it("speaks with the cheapest covering provider (Google first) and meters per 1k chars", async () => {
    setProviderKeys({ google: true, openai: true });
    stubFetch();
    const { token, userId } = await signup("tts1");
    await grantStudioConsent(token, ["google", "openai"]);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVoiceSpeak,
      headers: authHeader(token),
      payload: { text: "السلام علیکم", language: "ur" },
    });
    expect(res.statusCode).toBe(200);
    const audioUrl = res.json().data.audioUrl as string;
    expect(audioUrl).toContain("/api/v1/studio/audio/");
    expect(fetchLog.some((c) => c.url.includes("texttospeech.googleapis.com"))).toBe(true);
    expect(fetchLog.some((c) => c.url.includes("api.elevenlabs.io"))).toBe(false);

    const dl = await app.inject({ method: "GET", url: audioUrl });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("audio/mpeg");

    const m = await getPool().query<{ units: string; cost_usd: string; provider: string }>(
      "SELECT units, cost_usd, provider FROM usage_events WHERE user_id = $1 AND feature = 'voice' AND details->>'kind' = 'tts'",
      [userId],
    );
    expect(m.rowCount).toBe(1);
    expect(m.rows[0].provider).toBe("google");
    expect(Number(m.rows[0].units)).toBeCloseTo("السلام علیکم".length / 1000, 5);
  });

  it("falls back to OpenAI when Google has no key, and 503s honestly with none", async () => {
    setProviderKeys({ openai: true });
    stubFetch();
    const { token } = await signup("tts2");
    await grantStudioConsent(token, ["openai"]);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVoiceSpeak,
      headers: authHeader(token),
      payload: { text: "hello", language: "en" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchLog.some((c) => c.url.includes("api.openai.com/v1/audio/speech"))).toBe(true);
  });

  it("validates language + text, and 503s with no provider", async () => {
    stubFetch();
    const { token } = await signup("tts3");
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVoiceSpeak,
      headers: authHeader(token),
      payload: { text: "hello", language: "en" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NO_PROVIDER_AVAILABLE");

    setProviderKeys({ openai: true });
    await grantStudioConsent(token, ["openai"]);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVoiceSpeak,
      headers: authHeader(token),
      payload: { text: "hello", language: "not a language!!" },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVoiceSpeak,
      headers: authHeader(token),
      payload: { text: "", language: "en" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ---------------- voice: STT ---------------- */

describe("studio voice: STT", () => {
  it("transcribes with Whisper and meters per minute", async () => {
    setProviderKeys({ openai: true, google: true });
    stubFetch();
    const { token, userId } = await signup("stt1");
    await grantStudioConsent(token, ["openai", "google"]);
    const res = await voiceUpload(token, API_ROUTES.studioVoiceTranscribe);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.transcript).toBe("hello from the voice note");
    expect(fetchLog.some((c) => c.url.includes("/v1/audio/transcriptions"))).toBe(true);

    const m = await getPool().query<{ units: string; provider: string }>(
      "SELECT units, provider FROM usage_events WHERE user_id = $1 AND feature = 'voice' AND details->>'kind' = 'stt'",
      [userId],
    );
    expect(m.rowCount).toBe(1);
    expect(m.rows[0].provider).toBe("openai");
    expect(Number(m.rows[0].units)).toBeGreaterThan(0);
  });

  it("falls back to Google STT when Whisper fails", async () => {
    setProviderKeys({ openai: true, google: true });
    stubFetch();
    whisperShouldFail = true;
    const { token } = await signup("stt2");
    await grantStudioConsent(token, ["openai", "google"]);
    const res = await voiceUpload(token, API_ROUTES.studioVoiceTranscribe);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.transcript).toBe("hello from google stt");
    expect(fetchLog.some((c) => c.url.includes("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash"))).toBe(true);
  });

  it("503s honestly with no STT provider", async () => {
    stubFetch();
    const { token } = await signup("stt3");
    const res = await voiceUpload(token, API_ROUTES.studioVoiceTranscribe);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NO_PROVIDER_AVAILABLE");
  });

  it("rejects non-audio uploads", async () => {
    setProviderKeys({ openai: true });
    stubFetch();
    const { token } = await signup("stt4");
    await grantStudioConsent(token, ["openai"]);
    const { payload, contentType } = multipartBody("note.txt", "text/plain", Buffer.from("not audio"));
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVoiceTranscribe,
      headers: { ...authHeader(token), "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ---------------- chat voice notes ---------------- */

describe("chat voice notes", () => {
  it("transcribes and continues the normal threaded message flow as SSE", async () => {
    setProviderKeys({ openai: true, anthropic: true });
    stubFetch();
    const { token } = await signup("vn1");
    await grantStudioConsent(token, ["openai"]);
    await grantChatConsent(token, ["anthropic"]);

    let res = await app.inject({ method: "POST", url: API_ROUTES.chatThreads, headers: authHeader(token), payload: {} });
    const threadId = res.json().data.thread.id as string;

    res = await voiceUpload(token, API_ROUTES.chatThreadVoice(threadId));
    expect(res.statusCode).toBe(200);
    // The response IS the SSE stream, like the normal message route.
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = sseEvents(res.body);
    expect(events[0].type).toBe("start");
    expect(events[events.length - 1].type).toBe("done");

    // The transcript was posted as the user message.
    res = await app.inject({ method: "GET", url: API_ROUTES.chatMessages(threadId), headers: authHeader(token) });
    const messages = res.json().data.messages as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hello from the voice note");
    expect(messages[1].role).toBe("assistant");
  });

  it("404s on unknown threads and has no temporary-chat twin", async () => {
    setProviderKeys({ openai: true });
    stubFetch();
    const { token } = await signup("vn2");
    await grantStudioConsent(token, ["openai"]);
    const res = await voiceUpload(token, API_ROUTES.chatThreadVoice("00000000-0000-0000-0000-000000000000"));
    expect(res.statusCode).toBe(404);
    // Temporary chat is untouched: still stateless, still rejects files.
    const temp = await app.inject({
      method: "POST",
      url: API_ROUTES.chatTempMessages,
      headers: authHeader(token),
      payload: { messages: [{ role: "user", content: "hi" }], fileIds: ["x"] },
    });
    expect(temp.statusCode).toBe(400);
  });
});

/* ---------------- studio consent ---------------- */

describe("studio consent", () => {
  it("lists studio providers with capability-specific copy", async () => {
    setProviderKeys({ openai: true, google: true });
    stubFetch();
    const { token } = await signup("con1");
    const res = await app.inject({ method: "GET", url: API_ROUTES.studioConsent, headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    const providers = res.json().data.providers as Array<{ id: string; required: boolean; granted: boolean; whatSees: string; capabilities: string[] }>;
    const openai = providers.find((p) => p.id === "openai")!;
    expect(openai.required).toBe(true);
    expect(openai.granted).toBe(false);
    expect(openai.whatSees).toContain("pictures");
    expect(openai.capabilities).toEqual(expect.arrayContaining(["image", "voice"]));
    const google = providers.find((p) => p.id === "google")!;
    expect(google.capabilities).toEqual(expect.arrayContaining(["image", "video", "voice"]));
  });

  it("granting consent unblocks image generation", async () => {
    setProviderKeys({ openai: true });
    stubFetch();
    const { token } = await signup("con2");
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a lighthouse" },
    });
    expect(res.statusCode).toBe(403);
    await grantStudioConsent(token, ["openai"]);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioImages,
      headers: authHeader(token),
      payload: { prompt: "a lighthouse" },
    });
    expect(res.statusCode).toBe(201);
  });
});

/* ---------------- video: estimate-before-generate gate ---------------- */

describe("video director: estimate-before-generate", () => {
  it("plans (script + storyboard + estimate) with no video provider, and generates NOTHING pre-approval", async () => {
    setProviderKeys({ anthropic: true }); // chat only — no video keys
    stubFetch();
    const { token } = await signup("vid1");
    await grantChatConsent(token, ["anthropic"]);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideos,
      headers: authHeader(token),
      payload: { brief: "a short film about mountains", targetMinutes: 1 },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data.video as StudioVideo;
    expect(created.status).toBe("estimating");
    expect(created.estimate).toBeNull();

    const approved = await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioVideo(created.id), headers: authHeader(token) });
      return r.json().data.video as StudioVideo;
    }, (v) => v.status === "awaiting_approval");
    expect(approved.estimate).not.toBeNull();
    expect(approved.estimate!.totalSeconds).toBe(16);
    expect(approved.estimate!.costUsd).toBeGreaterThan(0);
    expect(approved.estimate!.estimatedMinutes).toBeGreaterThan(0);
    expect(approved.shots.length).toBe(2);
    expect(approved.shots.every((s) => s.status === "pending")).toBe(true);
    expect(approved.stages.map((s) => s.id)).toEqual([...STUDIO_VIDEO_STAGE_IDS]);

    // HARD GATE: no video-provider traffic happened before approval.
    expect(fetchLog.some((c) => c.url.includes("predictLongRunning") || c.url.includes("klingai"))).toBe(false);

    // Shot regenerate pre-approval is refused and generates nothing.
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideoShotRegenerate(created.id, approved.shots[0].id),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expect(fetchLog.some((c) => c.url.includes("predictLongRunning") || c.url.includes("klingai"))).toBe(false);

    // Approve without a video provider is an honest 503 (never silent).
    res = await app.inject({ method: "POST", url: API_ROUTES.studioVideoApprove(created.id), headers: authHeader(token), payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NO_PROVIDER_AVAILABLE");
  });

  it("shot reorder/delete work pre-approval and return the full video", async () => {
    setProviderKeys({ anthropic: true });
    stubFetch();
    const { token } = await signup("vid2");
    await grantChatConsent(token, ["anthropic"]);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideos,
      headers: authHeader(token),
      payload: { brief: "a film about rivers", targetMinutes: 1 },
    });
    const id = res.json().data.video.id as string;
    const video = await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioVideo(id), headers: authHeader(token) });
      return r.json().data.video as StudioVideo;
    }, (v) => v.status === "awaiting_approval");
    const [a, b] = video.shots.map((s) => s.id);

    res = await app.inject({
      method: "PATCH",
      url: API_ROUTES.studioVideoShotReorder(id, a),
      headers: authHeader(token),
      payload: { order: [b, a] },
    });
    expect(res.statusCode).toBe(200);
    const reordered = res.json().data.video as StudioVideo;
    expect(reordered.shots.map((s) => s.id)).toEqual([b, a]);
    expect(reordered.shots[0].order).toBe(0);

    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.studioVideoShot(id, b),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data.video as StudioVideo).shots.length).toBe(1);
  });

  it("rejects dead video models and validates input", async () => {
    setProviderKeys({ anthropic: true, google: true });
    stubFetch();
    const { token } = await signup("vid3");
    await grantChatConsent(token, ["anthropic"]);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideos,
      headers: authHeader(token),
      payload: { brief: "x".repeat(10), provider: "sora" },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideos,
      headers: authHeader(token),
      payload: { brief: "ok", targetMinutes: 99 },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideos,
      headers: authHeader(token),
      payload: { brief: "a film", provider: "nope" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("unit: retired-model guards", () => {
    const veo = VIDEO_CATALOG.find((m) => m.id === "veo-3.1-generate-001")!;
    expect(veo.retiresAt).toBe("2026-11-17");
    expect(isVideoModelRetired(veo, new Date("2026-10-19T00:00:00Z"))).toBe(false);
    expect(isVideoModelRetired(veo, new Date("2026-11-17T00:00:00Z"))).toBe(true);
    expect(isVideoModelRetired(veo, new Date("2027-01-01T00:00:00Z"))).toBe(true);
    const kling = VIDEO_CATALOG.find((m) => m.id === "kling-3.0")!;
    expect(isVideoModelRetired(kling)).toBe(false);
    // Duration coercion per provider.
    expect(normalizeShotDuration(veo, 5)).toBe(4);
    expect(normalizeShotDuration(veo, 7)).toBe(6);
    expect(normalizeShotDuration(kling, 2)).toBe(3);
    expect(normalizeShotDuration(kling, 20)).toBe(15);
    expect(videoShotCostUsd(veo, 8)).toBeCloseTo(3.2, 5);
    expect(videoShotCostUsd(kling, 10)).toBeCloseTo(1.12, 5);
  });

  it("unit: pickVideoProvider is cheapest-first, fail-closed, skips retired", () => {
    process.env.GOOGLE_GENAI_API_KEY = "words-only-test-key";
    const cheapest = pickVideoProvider("PK");
    // google/veo ($0.40/s) is the only region-allowed video provider in PK;
    // kling has no region entries (fail-closed) so it is never picked.
    expect(cheapest?.provider).toBe("google");
    expect(cheapest?.model.id).toBe("veo-3.1-generate-001");
    expect(pickVideoProvider("PK", "kling")).toBeNull();
    expect(pickVideoProvider("XX")).toBeNull();
    delete process.env.GOOGLE_GENAI_API_KEY;
    expect(pickVideoProvider("PK")).toBeNull();
    expect(videoMaxSecondsPerProject()).toBe(900);
    expect(videoMaxSpendUsd()).toBe(20);
  });
});

/* ---------------- video: full run ---------------- */

describe("video director: approve -> run -> done", () => {
  it("runs end to end with per-second metering and exactly one notification", async () => {
    setProviderKeys({ anthropic: true, google: true });
    stubFetch();
    __setAssemblyOverride(async (inputs) => {
      expect(inputs.shotKeys.length).toBe(2);
      const key = `studio-final-test-${randomUUID()}.mp4`;
      await getStorage().put(key, FAKE_MP4);
      return { storageKey: key, totalSeconds: 16 };
    });
    const { token, userId } = await signup("vidrun1");
    await grantChatConsent(token, ["anthropic"]);
    await grantStudioConsent(token, ["google"]);

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideos,
      headers: authHeader(token),
      payload: { brief: "a short film about mountains", targetMinutes: 1 },
    });
    const id = res.json().data.video.id as string;
    await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioVideo(id), headers: authHeader(token) });
      return (r.json().data.video as StudioVideo).status;
    }, (s) => s === "awaiting_approval");

    res = await app.inject({ method: "POST", url: API_ROUTES.studioVideoApprove(id), headers: authHeader(token), payload: {} });
    expect(res.statusCode).toBe(200);
    expect((res.json().data.video as StudioVideo).status).toBe("running");

    const done = await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioVideo(id), headers: authHeader(token) });
      return r.json().data.video as StudioVideo;
    }, (v) => v.status === "done" || v.status === "failed", 90000);
    expect(done.status).toBe("done");
    expect(done.videoUrl).toContain(`/api/v1/studio/videos/${id}/download`);
    expect(done.shots.every((s) => s.status === "ready")).toBe(true);
    expect(done.shots.every((s) => typeof s.previewUrl === "string")).toBe(true);
    expect(done.stages.every((s) => s.status === "done")).toBe(true);

    // Finished MP4 downloads.
    const dl = await app.inject({ method: "GET", url: done.videoUrl as string });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("video/mp4");

    // Cost accounting per second: 2 shots x 8s x $0.40.
    const m = await getPool().query<{ units: string; cost_usd: string }>(
      "SELECT units, cost_usd FROM usage_events WHERE user_id = $1 AND feature = 'video'",
      [userId],
    );
    expect(m.rowCount).toBe(2);
    const totalUnits = m.rows.reduce((a, r) => a + Number(r.units), 0);
    const totalCost = m.rows.reduce((a, r) => a + Number(r.cost_usd), 0);
    expect(totalUnits).toBe(16);
    expect(totalCost).toBeCloseTo(6.4, 5);

    // Exactly one notification row for the finished video.
    const n = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM agent_notifications WHERE user_id = $1 AND video_id = $2",
      [userId, id],
    );
    expect(Number(n.rows[0].n)).toBe(1);

    // Credits were spent per generated second (2 shots x 8s = 16).
    const ledger = await getPool().query<{ reason: string; delta: string }>(
      "SELECT reason, delta FROM credit_ledger WHERE user_id = $1 AND reason LIKE 'video:%'",
      [userId],
    );
    expect(ledger.rows.reduce((a, r) => a + Number(r.delta), 0)).toBe(-16);

    // Terminal states are immutable: shot ops 400 now.
    res = await app.inject({
      method: "DELETE",
      url: API_ROUTES.studioVideoShot(id, done.shots[0].id),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideoShotRegenerate(id, done.shots[0].id),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);

    // SSE replays progress and terminates with the video.
    res = await app.inject({ method: "GET", url: API_ROUTES.studioVideoEvents(id), headers: authHeader(token) });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = sseEvents(res.body);
    expect(events.some((e) => e.type === "progress")).toBe(true);
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect((last.video as StudioVideo).id).toBe(id);

    // DELETE removes the project cleanly.
    res = await app.inject({ method: "DELETE", url: API_ROUTES.studioVideo(id), headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);
    res = await app.inject({ method: "GET", url: API_ROUTES.studioVideo(id), headers: authHeader(token) });
    expect(res.statusCode).toBe(404);
  }, 120000);

  it("approve enforces the spend cap", async () => {
    setProviderKeys({ anthropic: true, google: true });
    process.env.VIDEO_MAX_SPEND_USD = "0.01";
    stubFetch();
    const { token } = await signup("vidrun2");
    await grantChatConsent(token, ["anthropic"]);
    await grantStudioConsent(token, ["google"]);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioVideos,
      headers: authHeader(token),
      payload: { brief: "a short film about mountains", targetMinutes: 1 },
    });
    const id = res.json().data.video.id as string;
    await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioVideo(id), headers: authHeader(token) });
      return (r.json().data.video as StudioVideo).status;
    }, (s) => s === "awaiting_approval");
    res = await app.inject({ method: "POST", url: API_ROUTES.studioVideoApprove(id), headers: authHeader(token), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

/* ---------------- audio overviews ---------------- */

describe("audio overviews", () => {
  async function seedFile(userId: string, name: string, text: string): Promise<string> {
    const id = randomUUID();
    const key = `test-file-${id}.txt`;
    await getStorage().put(key, Buffer.from(text));
    await getPool().query(
      `INSERT INTO files (id, user_id, original_name, mime_type, size_bytes, storage_key, status, extracted_text,
                          search)
       VALUES ($1, $2, $3, 'text/csv', $4, $5, 'ready', $6,
               to_tsvector('english', $3 || ' ' || $6))`,
      [id, userId, name, text.length, key, text],
    );
    return id;
  }

  it("builds a two-host overview from files and lands in the library", async () => {
    setProviderKeys({ anthropic: true, google: true });
    stubFetch();
    const { token, userId } = await signup("ov1");
    await grantChatConsent(token, ["anthropic"]);
    await grantStudioConsent(token, ["google"]);
    const fileId = await seedFile(userId, "notes.csv", "Mountains are tall. Rivers flow fast.");

    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioAudioOverviews,
      headers: authHeader(token),
      payload: { fileIds: [fileId], length: "short" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data.overview as AudioOverview;
    expect(created.status).toBe("pending");
    expect(created.audioUrl).toBeNull();

    const ready = await pollUntil(async () => {
      const r = await app.inject({ method: "GET", url: API_ROUTES.studioAudioOverview(created.id), headers: authHeader(token) });
      return r.json().data.overview as AudioOverview;
    }, (o) => o.status === "ready");
    expect(ready.audioUrl).toContain(`/api/v1/studio/audio-overviews/${created.id}/download`);

    const dl = await app.inject({ method: "GET", url: ready.audioUrl as string });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("audio/mpeg");

    // Two-host dialogue used alternating voices (google TTS called 3x).
    const ttsCalls = fetchLog.filter((c) => c.url.includes("texttospeech.googleapis.com"));
    expect(ttsCalls.length).toBe(3);

    // Library audio group.
    const lib = await app.inject({ method: "GET", url: API_ROUTES.library, headers: authHeader(token) });
    const groups = lib.json().data.groups as Array<{ type: string; items: Array<Record<string, unknown>> }>;
    const audio = groups.find((g) => g.type === "audio")!;
    expect(audio.items.length).toBe(1);
    expect(typeof audio.items[0].playUrl).toBe("string");

    // Delete via the library.
    res = await app.inject({ method: "DELETE", url: API_ROUTES.libraryItem("audio", created.id), headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
  });

  it("validates files and gates", async () => {
    setProviderKeys({ anthropic: true });
    stubFetch();
    const { token } = await signup("ov2");
    await grantChatConsent(token, ["anthropic"]);
    let res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioAudioOverviews,
      headers: authHeader(token),
      payload: { fileIds: ["00000000-0000-0000-0000-000000000000"], length: "short" },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioAudioOverviews,
      headers: authHeader(token),
      payload: { fileIds: [], length: "medium" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s with no chat provider", async () => {
    stubFetch();
    const { token, userId } = await signup("ov3");
    const fileId = await seedFile(userId, "notes.csv", "Some text here.");
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.studioAudioOverviews,
      headers: authHeader(token),
      payload: { fileIds: [fileId], length: "short" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("NO_PROVIDER_AVAILABLE");
  });
});

/* ---------------- boot sweeps ---------------- */

describe("studio boot sweeps", () => {
  it("marks stale video projects, images and overviews failed", async () => {
    setProviderKeys({ anthropic: true });
    stubFetch();
    const { userId } = await signup("sweep1");
    const pool = getPool();
    const vid = randomUUID();
    await pool.query(
      "INSERT INTO video_projects (id, user_id, title, brief, status) VALUES ($1, $2, 't', 'b', 'running')",
      [vid, userId],
    );
    const img = randomUUID();
    await pool.query(
      "INSERT INTO studio_images (id, user_id, prompt, provider, model, aspect_ratio, status) VALUES ($1, $2, 'p', 'openai', 'm', 'square', 'pending')",
      [img, userId],
    );
    const ov = randomUUID();
    await pool.query(
      "INSERT INTO audio_overviews (id, user_id, title, length, status) VALUES ($1, $2, 't', 'short', 'running')",
      [ov, userId],
    );
    expect(await sweepStaleVideoProjects()).toBe(1);
    expect(await sweepStaleStudioImages()).toBe(1);
    expect(await sweepStaleAudioOverviews()).toBe(1);
    const v = await pool.query<{ status: string }>("SELECT status FROM video_projects WHERE id = $1", [vid]);
    expect(v.rows[0].status).toBe("failed");
  });
});
