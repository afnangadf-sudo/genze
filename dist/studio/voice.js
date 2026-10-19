// Step 9 — Studio voice: STT (Whisper primary, Google fallback), TTS
// (cheapest covering provider), and chat voice notes.
//
// VOICE_COVERAGE — 5-language check at wiring time (en/ur/ar/tr/fa):
//   Whisper STT (openai whisper-1):   all five  (99+ languages)
//   OpenAI TTS (tts-1):               all five
//   Google Cloud TTS:                 all five  (75+ languages)
//   ElevenLabs TTS:                   en, ar, tr ONLY — verified 2026-10-19
//     via web search: eleven_multilingual_v2 covers 29 languages (en, ar,
//     tr among them) but NOT Urdu or Persian; v3+ models (74 langs) add
//     them, but the default model can't be assumed. TTS for ur/fa must
//     never route to ElevenLabs — it falls through to Google/OpenAI.
// Voice cloning is NOT v1 (no endpoint, by design).
import { isValidLanguageCode } from "@genze/shared";
import multipart from "@fastify/multipart";
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../db.js";
import { sendError } from "../errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { getUserCountry, getUserLanguage, hasLiveConsent } from "../users.js";
import { getProvider } from "../providers/registry.js";
import { REGION_MAP } from "../providers/regions.js";
import { CONSENT_COPY } from "../providers/consentCopy.js";
import { getStorage } from "../storage/index.js";
import { signDownloadUrl, verifyDownloadLink } from "../storage/signed.js";
import { recordUsage } from "../usage.js";
import { speakWithElevenLabs, speakWithGoogle, speakWithOpenAI, StudioProviderError, transcribeWithGoogle, transcribeWithWhisper, } from "./providers.js";
/* ---------------- coverage matrix ---------------- */
/** The five v1 languages the wiring check covers. */
export const VOICE_CHECK_LANGUAGES = ["en", "ur", "ar", "tr", "fa"];
/**
 * Languages each provider's STT/TTS covers, as primary subtags (lowercase).
 * "*" = broad coverage beyond the five (Whisper 99+, Google 75+).
 * ElevenLabs TTS marks honestly per language (see header note): ur/fa are
 * absent, so routing never sends them there.
 */
export const VOICE_COVERAGE = {
    openai: { stt: ["en", "ur", "ar", "tr", "fa", "*"], tts: ["en", "ur", "ar", "tr", "fa"] },
    google: { stt: ["en", "ur", "ar", "tr", "fa", "*"], tts: ["en", "ur", "ar", "tr", "fa", "*"] },
    elevenlabs: { stt: [], tts: ["en", "ar", "tr"] },
};
function primarySubtag(code) {
    return code.toLowerCase().split(/[-_]/)[0];
}
/** True when the provider's STT/TTS covers the requested language. */
export function voiceCovers(provider, kind, languageCode) {
    const list = VOICE_COVERAGE[provider][kind];
    if (list.includes("*"))
        return true;
    return list.includes(primarySubtag(languageCode));
}
/** Configured + enabled (kill switch) + region-allowed + voice-capable. */
function voiceGates(provider, country) {
    const cc = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc))
        return false;
    const allowed = REGION_MAP.get(cc);
    if (!allowed || !allowed.includes(provider))
        return false;
    const p = getProvider(provider);
    return p.isConfigured() && p.isEnabled() && p.capabilities.includes("voice");
}
/** Providers that could serve TTS for this language, cheapest first
 *  (Google's free tier, then OpenAI, then ElevenLabs). Pure — no I/O. */
export function ttsCandidates(country, languageCode) {
    const order = ["google", "openai", "elevenlabs"];
    return order.filter((p) => voiceCovers(p, "tts", languageCode) && voiceGates(p, country));
}
/* ---------------- gated errors ---------------- */
export class VoiceGateError extends Error {
    code;
    provider;
    constructor(code, message, provider = null) {
        super(message);
        this.code = code;
        this.provider = provider;
    }
}
function consentMessage(provider, kind) {
    const name = CONSENT_COPY[provider]?.name ?? provider;
    const what = kind === "stt" ? "transcribe your voice recordings" : "speak text aloud";
    return (`To ${what} with ${name}, please allow Genze to share your ` +
        `${kind === "stt" ? "voice recordings" : "text"} with them first.`);
}
/**
 * Transcribe audio: Whisper primary, Google fallback on provider failure.
 * Throws VoiceGateError (NO_PROVIDER_AVAILABLE / CONSENT_REQUIRED /
 * PROVIDER_ERROR) — the route maps it to HTTP.
 */
export async function transcribeAudio(opts) {
    const { buffer, mime, filename, userId, country } = opts;
    const whisperOk = voiceGates("openai", country);
    const googleOk = voiceGates("google", country);
    if (!whisperOk && !googleOk) {
        throw new VoiceGateError("NO_PROVIDER_AVAILABLE", "Speech transcription isn't available for your region right now. Please try again later.");
    }
    if (whisperOk) {
        if (!(await hasLiveConsent(userId, "openai"))) {
            throw new VoiceGateError("CONSENT_REQUIRED", consentMessage("openai", "stt"), "openai");
        }
        try {
            const text = await transcribeWithWhisper(buffer, mime, filename);
            return { text, provider: "openai", model: "whisper-1" };
        }
        catch (err) {
            if (err instanceof StudioProviderError && err.code === "NOT_CONFIGURED") {
                // Key vanished mid-flight; fall through to Google honestly.
            }
            else if (googleOk) {
                // Provider failure -> Google fallback.
            }
            else {
                throw new VoiceGateError("PROVIDER_ERROR", err instanceof Error ? err.message : "Transcription failed. Please try again.", "openai");
            }
        }
    }
    if (googleOk) {
        if (!(await hasLiveConsent(userId, "google"))) {
            throw new VoiceGateError("CONSENT_REQUIRED", consentMessage("google", "stt"), "google");
        }
        try {
            const text = await transcribeWithGoogle(buffer, mime);
            return { text, provider: "google", model: "gemini-2.5-flash" };
        }
        catch (err) {
            throw new VoiceGateError("PROVIDER_ERROR", err instanceof Error ? err.message : "Transcription failed. Please try again.", "google");
        }
    }
    throw new VoiceGateError("PROVIDER_ERROR", "Transcription failed. Please try again.");
}
/** Rough audio minutes from byte size (~128 kbps heuristic), min 3 seconds. */
export function estimateAudioMinutes(bytes) {
    return Math.max(0.05, bytes / 960_000);
}
const STT_COST_PER_MIN = { openai: 0.006, google: 0.016 };
/** USD per 1M chars. Google meters at $0 (free tier 4M chars/mo; vendor-side,
 *  untrackable here). ElevenLabs is approximate (plan-based pricing). */
export const TTS_COST_PER_M = {
    google: 0,
    openai: 15,
    elevenlabs: 30,
};
const GOOGLE_VOICE_REGIONS = {
    en: "US",
    ur: "PK",
    ar: "SA",
    tr: "TR",
    fa: "IR",
};
/** Best-effort BCP-47 language code for Google Cloud TTS voices. */
export function googleTtsLanguageCode(code) {
    const sub = primarySubtag(code);
    const region = GOOGLE_VOICE_REGIONS[sub] ?? "US";
    return `${sub}-${region}`;
}
const OPENAI_VOICES = { A: "alloy", B: "nova" };
/**
 * Speak text: cheapest provider covering the requested language
 * (Google free tier -> OpenAI -> ElevenLabs). Consent is checked on the
 * routed (best) provider; on provider failure it falls through to the next
 * covering provider that already has consent.
 */
export async function synthesizeSpeech(opts) {
    const { text, language, userId, country, voice = "A" } = opts;
    const candidates = ttsCandidates(country, language);
    if (candidates.length === 0) {
        throw new VoiceGateError("NO_PROVIDER_AVAILABLE", "Text-to-speech isn't available for this language or region right now. Please try again later.");
    }
    const [first, ...rest] = candidates;
    if (!(await hasLiveConsent(userId, first))) {
        throw new VoiceGateError("CONSENT_REQUIRED", consentMessage(first, "tts"), first);
    }
    const attempt = async (p) => {
        if (p === "google") {
            return {
                audio: await speakWithGoogle(text, googleTtsLanguageCode(language)),
                provider: "google",
                model: "google-cloud-tts",
            };
        }
        if (p === "openai") {
            return {
                audio: await speakWithOpenAI(text, OPENAI_VOICES[voice]),
                provider: "openai",
                model: "tts-1",
            };
        }
        return { audio: await speakWithElevenLabs(text), provider: "elevenlabs", model: "eleven_multilingual_v2" };
    };
    try {
        return await attempt(first);
    }
    catch (err) {
        if (!(err instanceof StudioProviderError))
            throw err;
        for (const p of rest) {
            if (!(await hasLiveConsent(userId, p)))
                continue;
            try {
                return await attempt(p);
            }
            catch {
                continue;
            }
        }
        throw new VoiceGateError("PROVIDER_ERROR", err.message || "Speech generation failed. Please try again.", first);
    }
}
function voiceGateStatus(err) {
    return err.code === "NO_PROVIDER_AVAILABLE" ? 503 : err.code === "CONSENT_REQUIRED" ? 403 : 502;
}
/* ---------------- audio mime validation ---------------- */
const AUDIO_MIMES = new Set([
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/mp4",
    "audio/x-m4a",
    "audio/aac",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "video/mp4",
    "video/webm",
]);
export function isAudioMime(mime) {
    const m = mime.toLowerCase().split(";")[0].trim();
    return m.startsWith("audio/") || AUDIO_MIMES.has(m);
}
export const VOICE_NOTE_MAX_BYTES = 25 * 1024 * 1024;
/* ---------------- routes (prefix /api/v1/studio) ---------------- */
const AUDIO_BASE = "/api/v1/studio/audio";
export async function studioVoiceRoutes(app) {
    await app.register(multipart, { limits: { fileSize: VOICE_NOTE_MAX_BYTES, files: 1 } });
    app.post("/voice/transcribe", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        let part;
        try {
            part = await req.file();
        }
        catch {
            return sendError(reply, 413, "FILE_TOO_LARGE", "That recording is too big. The limit is 25 MB.");
        }
        if (!part)
            return sendError(reply, 400, "VALIDATION_ERROR", "No audio was attached.");
        const mime = (part.mimetype || "").toLowerCase();
        if (!isAudioMime(mime)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "That doesn't look like an audio file.");
        }
        let buffer;
        try {
            buffer = await part.toBuffer();
        }
        catch {
            return sendError(reply, 413, "FILE_TOO_LARGE", "That recording is too big. The limit is 25 MB.");
        }
        if (buffer.length === 0)
            return sendError(reply, 400, "VALIDATION_ERROR", "That recording is empty.");
        if (buffer.length > VOICE_NOTE_MAX_BYTES) {
            return sendError(reply, 413, "FILE_TOO_LARGE", "That recording is too big. The limit is 25 MB.");
        }
        const country = (await getUserCountry(auth.userId)) ?? "";
        try {
            const { text, provider, model } = await transcribeAudio({
                buffer,
                mime,
                filename: part.filename || "recording",
                userId: auth.userId,
                country,
            });
            const minutes = estimateAudioMinutes(buffer.length);
            await recordUsage({
                userId: auth.userId,
                feature: "voice",
                provider,
                units: minutes,
                costUsd: minutes * (STT_COST_PER_MIN[provider] ?? 0.006),
                details: { kind: "stt", model },
            });
            return reply.send({ data: { transcript: text } });
        }
        catch (err) {
            if (err instanceof VoiceGateError) {
                return sendError(reply, voiceGateStatus(err), err.code, err.message);
            }
            throw err;
        }
    });
    app.post("/voice/speak", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const body = req.body ?? {};
        const text = typeof body.text === "string" ? body.text : "";
        if (text.length < 1 || text.length > 5000) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Text must be 1–5000 characters.");
        }
        // Any BCP-47 code (user correction: no language enum restriction).
        if (!isValidLanguageCode(body.language)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "That language code doesn't look right.");
        }
        const language = body.language.toLowerCase();
        const voice = body.voice === "B" ? "B" : "A";
        const country = (await getUserCountry(auth.userId)) ?? "";
        try {
            const { audio, provider, model } = await synthesizeSpeech({
                text,
                language,
                userId: auth.userId,
                country,
                voice,
            });
            const id = uuidv4();
            const storageKey = `studio-tts-${id}.mp3`;
            await getStorage().put(storageKey, audio);
            await getPool().query(`INSERT INTO studio_audio (id, user_id, kind, provider, model, language, chars, storage_key)
         VALUES ($1, $2, 'tts', $3, $4, $5, $6, $7)`, [id, auth.userId, provider, model, language, text.length, storageKey]);
            await recordUsage({
                userId: auth.userId,
                feature: "voice",
                provider,
                units: text.length / 1000,
                costUsd: (text.length / 1e6) * (TTS_COST_PER_M[provider] ?? 15),
                details: { kind: "tts", model, language },
            });
            return reply.send({ data: { audioUrl: signDownloadUrl(id, AUDIO_BASE) } });
        }
        catch (err) {
            if (err instanceof VoiceGateError) {
                return sendError(reply, voiceGateStatus(err), err.code, err.message);
            }
            throw err;
        }
    });
    // Signed audio download (no auth header — the HMAC token is the authorization).
    app.get("/audio/:id/download", async (req, reply) => {
        const id = req.params.id;
        const query = req.query;
        const check = verifyDownloadLink(id, query.expires, query.sig);
        if (!check.ok) {
            return sendError(reply, 403, check.reason === "expired" ? "LINK_EXPIRED" : "LINK_INVALID", check.reason === "expired"
                ? "This download link has expired. Please make a new one."
                : "This download link is not valid.");
        }
        const r = await getPool().query("SELECT storage_key FROM studio_audio WHERE id = $1", [id]);
        if (!r.rowCount)
            return sendError(reply, 404, "NOT_FOUND", "Audio not found.");
        let bytes;
        try {
            bytes = await getStorage().get(r.rows[0].storage_key);
        }
        catch {
            return sendError(reply, 404, "NOT_FOUND", "Audio not found.");
        }
        reply.header("Content-Type", "audio/mpeg");
        reply.header("Content-Length", String(bytes.length));
        return reply.send(bytes);
    });
}
/* ---------------- chat voice notes (prefix /api/v1/chat) ---------------- */
/**
 * POST /chat/threads/:id/voice — transcribe the attached audio, then hand
 * the transcript to the NORMAL threaded message flow (same gates, SSE
 * stream) via an internal dispatch. The route is deliberately thin:
 * transcribe, then delegate — no duplicated gate logic, so temp-chat and
 * lockdown semantics stay exactly as the message route defines them.
 */
export async function chatVoiceNoteRoutes(app) {
    await app.register(multipart, { limits: { fileSize: VOICE_NOTE_MAX_BYTES, files: 1 } });
    app.post("/threads/:id/voice", { preHandler: authenticate }, async (req, reply) => {
        const auth = req.auth;
        const threadId = req.params.id;
        const owned = await getPool().query("SELECT id FROM chat_threads WHERE id = $1 AND user_id = $2", [
            threadId,
            auth.userId,
        ]);
        if (!owned.rowCount)
            return sendError(reply, 404, "NOT_FOUND", "Chat not found.");
        let part;
        try {
            part = await req.file();
        }
        catch {
            return sendError(reply, 413, "FILE_TOO_LARGE", "That voice note is too big. The limit is 25 MB.");
        }
        if (!part)
            return sendError(reply, 400, "VALIDATION_ERROR", "No voice note was attached.");
        const mime = (part.mimetype || "").toLowerCase();
        if (!isAudioMime(mime)) {
            return sendError(reply, 400, "VALIDATION_ERROR", "That doesn't look like an audio file.");
        }
        let buffer;
        try {
            buffer = await part.toBuffer();
        }
        catch {
            return sendError(reply, 413, "FILE_TOO_LARGE", "That voice note is too big. The limit is 25 MB.");
        }
        if (buffer.length === 0)
            return sendError(reply, 400, "VALIDATION_ERROR", "That voice note is empty.");
        if (buffer.length > VOICE_NOTE_MAX_BYTES) {
            return sendError(reply, 413, "FILE_TOO_LARGE", "That voice note is too big. The limit is 25 MB.");
        }
        const country = (await getUserCountry(auth.userId)) ?? "";
        let transcript;
        let sttProvider;
        try {
            const stt = await transcribeAudio({
                buffer,
                mime,
                filename: part.filename || "voice-note",
                userId: auth.userId,
                country,
            });
            transcript = stt.text;
            sttProvider = stt.provider;
        }
        catch (err) {
            if (err instanceof VoiceGateError) {
                return sendError(reply, voiceGateStatus(err), err.code, err.message);
            }
            throw err;
        }
        const content = transcript.trim().slice(0, 8000);
        if (!content) {
            return sendError(reply, 400, "VALIDATION_ERROR", "We couldn't hear anything in that voice note.");
        }
        await recordUsage({
            userId: auth.userId,
            feature: "voice",
            provider: sttProvider,
            units: estimateAudioMinutes(buffer.length),
            costUsd: estimateAudioMinutes(buffer.length) * (STT_COST_PER_MIN[sttProvider] ?? 0.006),
            details: { kind: "stt", source: "chat-voice-note" },
        });
        // Delegate: the transcript becomes the user message on the normal path.
        const inner = await app.inject({
            method: "POST",
            url: `/api/v1/chat/threads/${threadId}/messages`,
            headers: { authorization: req.headers.authorization ?? "" },
            payload: { content },
        });
        reply.code(inner.statusCode);
        for (const [name, value] of Object.entries(inner.headers)) {
            if (value !== undefined)
                reply.header(name, value);
        }
        return reply.send(inner.body);
    });
}
//# sourceMappingURL=voice.js.map