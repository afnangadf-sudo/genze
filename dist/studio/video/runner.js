// Step 9 — Video Director background runner.
//
// Two background jobs (in-process, setImmediate; DB is the source of truth —
// decision #42):
//   runVideoEstimate — script + storyboard via the chat router, then the
//     cost estimate. Terminal: status 'awaiting_approval' (or 'failed').
//   runVideoProject  — per-shot generation -> voiceover (TTS) -> music ->
//     captions (SRT) -> FFmpeg assembly. Terminal: 'done' / 'failed'.
//
// HARD GATE: generation never starts without approval. The runner only acts
// on status 'running'; the estimate job never calls a video provider; the
// regenerate route 400s unless running. A test asserts no provider traffic
// pre-approval.
//
// Terminal ordering (agent-runner pattern, decision #110): report written,
// exactly ONE agent_notifications row (SQL-guarded, video_id set), metering
// rows, THEN the terminal status flip.
import { v4 as uuidv4 } from "uuid";
import { getPool } from "../../db.js";
import { getUserCountry, getUserLanguage, hasLiveConsent } from "../../users.js";
import { getStorage } from "../../storage/index.js";
import { recordUsage } from "../../usage.js";
import { routeChat } from "../../providers/models.js";
import { makeChatProvider } from "../../providers/instances.js";
import { completeWithProvider } from "../../providers/complete.js";
import { spendCredits, ensureDailyGrant, getBalance } from "../../credits.js";
import { checkLimit } from "../../limits.js";
import { CONSENT_COPY } from "../../providers/consentCopy.js";
import { VIDEO_CATALOG, isDeadModelId, isVideoModelRetired, normalizeShotDuration, pickVideoProvider, videoShotCostUsd, } from "../catalog.js";
import { StudioProviderError, generateVideoShotBytes } from "../providers.js";
import { VoiceGateError, synthesizeSpeech, TTS_COST_PER_M } from "../voice.js";
import { assembleVideo, buildSrt, concatMp3, splitSentences } from "./assembly.js";
const VIDEO_COLUMNS = "id, user_id, title, brief, target_minutes, preferred_provider, music_file_id, status, estimate, approved_at, current_stage, created_at, updated_at";
export async function getVideo(userId, id) {
    const r = await getPool().query(`SELECT ${VIDEO_COLUMNS} FROM video_projects WHERE id = $1 AND user_id = $2`, [
        id,
        userId,
    ]);
    return r.rowCount ? r.rows[0] : null;
}
export async function getVideoShots(videoId) {
    const r = await getPool().query("SELECT id, video_id, n, prompt, duration_s, provider, model, status, storage_key, error, created_at FROM video_shots WHERE video_id = $1 ORDER BY n ASC", [videoId]);
    return r.rows;
}
/* ---------------- env caps (lazy) ---------------- */
function envPositiveInt(name, def) {
    const raw = (process.env[name] ?? "").trim();
    if (!raw)
        return def;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function envPositiveNum(name, def) {
    const raw = (process.env[name] ?? "").trim();
    if (!raw)
        return def;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : def;
}
/** Max generated seconds per project (default 900 = 15 min). */
export function videoMaxSecondsPerProject() {
    return envPositiveInt("VIDEO_MAX_SECONDS_PER_PROJECT", 900);
}
/** Max estimated spend per project, USD (default 20). */
export function videoMaxSpendUsd() {
    return envPositiveNum("VIDEO_MAX_SPEND_USD", 20);
}
/* ---------------- job registry ---------------- */
const activeVideos = new Set();
const aborters = new Map();
/** Shots with a generation call in flight (runner or regenerate route). */
const activeShots = new Set();
export function enqueueVideoEstimate(videoId) {
    setImmediate(() => void runVideoEstimate(videoId).catch((err) => console.warn("[studio] video estimate failed:", err)));
}
export function enqueueVideoRun(videoId) {
    setImmediate(() => void runVideoProject(videoId).catch((err) => console.warn("[studio] video run failed:", err)));
}
export function abortVideo(videoId) {
    aborters.get(videoId)?.abort();
}
export function isShotActive(shotId) {
    return activeShots.has(shotId);
}
/** Boot sweep: jobs stuck mid-flight (dead process) fail honestly. */
export async function sweepStaleVideoProjects() {
    const r = await getPool().query(`UPDATE video_projects
     SET status = 'failed', current_stage = NULL,
         estimate = COALESCE(estimate, '{}'::jsonb) || '{"error": "The server restarted while this video was being made. Please start a new one."}'::jsonb,
         updated_at = now()
     WHERE status IN ('estimating', 'running')`);
    return r.rowCount ?? 0;
}
/* ---------------- shared helpers ---------------- */
async function setStage(videoId, stage) {
    await getPool().query("UPDATE video_projects SET current_stage = $2, updated_at = now() WHERE id = $1", [
        videoId,
        stage,
    ]);
}
async function setProgress(videoId, progress) {
    await getPool().query(`UPDATE video_projects
     SET estimate = COALESCE(estimate, '{}'::jsonb) || jsonb_build_object('progress', $2::jsonb),
         updated_at = now()
     WHERE id = $1`, [videoId, JSON.stringify(progress)]);
}
function throwIfAborted(videoId) {
    if (aborters.get(videoId)?.signal.aborted) {
        const err = new Error("aborted");
        err.aborted = true;
        throw err;
    }
}
async function routeChatProvider(userId, country) {
    const route = routeChat({ country, taskType: "long-context" });
    if (!route) {
        throw new Error("NO_CHAT_PROVIDER:No chat provider is available for your region right now.");
    }
    if (!(await hasLiveConsent(userId, route.provider))) {
        const name = CONSENT_COPY[route.provider]?.name ?? route.provider;
        throw new Error(`CONSENT_REQUIRED:To write the script with ${name}, please allow Genze to share your chat messages with them first.`);
    }
    return { provider: makeChatProvider(route.provider, route.model.id), model: route.model };
}
function plainError(err, fallback) {
    if (err instanceof Error) {
        const m = err.message.includes(":") ? err.message.split(":").slice(1).join(":").trim() : err.message;
        return m || fallback;
    }
    return fallback;
}
/* ---------------- estimate job ---------------- */
const GENERIC_DURATION_MODEL = {
    id: "generic",
    provider: "google",
    costUsdPerSecond: 0.112,
    fixedDurations: [8],
};
export async function runVideoEstimate(videoId) {
    if (activeVideos.has(videoId))
        return;
    activeVideos.add(videoId);
    const pool = getPool();
    try {
        const r = await pool.query(`SELECT ${VIDEO_COLUMNS} FROM video_projects WHERE id = $1`, [videoId]);
        if (!r.rowCount || r.rows[0].status !== "estimating")
            return;
        const video = r.rows[0];
        const userId = video.user_id;
        const country = (await getUserCountry(userId)) ?? "";
        // Resolve the video provider for pricing + valid durations. Null = no
        // provider configured: estimate with reference pricing, warn honestly.
        let videoRoute = null;
        if (video.preferred_provider && !isDeadModelId(video.preferred_provider)) {
            videoRoute = pickVideoProvider(country, video.preferred_provider);
        }
        else if (!video.preferred_provider) {
            videoRoute = pickVideoProvider(country);
        }
        const model = videoRoute?.model ?? GENERIC_DURATION_MODEL;
        const validDurations = model.fixedDurations
            ? `exactly one of ${model.fixedDurations.join(", ")} seconds`
            : `between ${model.minDurationS} and ${model.maxDurationS} seconds`;
        // Script.
        await setStage(videoId, "script");
        await setProgress(videoId, { phase: "script", done: 10, total: 100, message: "Writing the script…" });
        const chat = await routeChatProvider(userId, country);
        const targetWords = Math.max(150, video.target_minutes * 130);
        const scriptRes = await completeWithProvider(chat.provider, {
            system: "You are a video scriptwriter. Reply with the narration text only — no stage directions, no headings.",
            messages: [
                {
                    role: "user",
                    content: `Write a narration script for a ~${video.target_minutes}-minute video about the following brief. ` +
                        `Aim for about ${targetWords} spoken words, in plain engaging language.\n\nBrief: ${video.brief}`,
                },
            ],
        });
        const scriptMarkdown = scriptRes.text.slice(0, 12000);
        // Storyboard: shot list JSON.
        await setStage(videoId, "storyboard");
        await setProgress(videoId, { phase: "storyboard", done: 40, total: 100, message: "Planning the shots…" });
        const totalTargetSeconds = video.target_minutes * 60;
        const shotCount = Math.min(40, Math.max(1, Math.round(totalTargetSeconds / 8)));
        const boardRes = await completeWithProvider(chat.provider, {
            system: "You are a storyboard artist. Reply with JSON only: " +
                `{"shots": [{"prompt": "<visual description, 1-2 sentences>", "durationSeconds": <number>}]}. ` +
                `Write exactly ${shotCount} shots, each lasting ${validDurations}, that together visualize the narration. ` +
                "No markdown, no commentary — JSON only.",
            messages: [{ role: "user", content: `Narration:\n${scriptMarkdown.slice(0, 6000)}` }],
        });
        const shots = parseStoryboard(boardRes.text, shotCount, model);
        // Persist shots (provider/model marked tbd when unresolved — fixed at approve).
        for (let i = 0; i < shots.length; i++) {
            await pool.query(`INSERT INTO video_shots (id, video_id, n, prompt, duration_s, provider, model, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`, [uuidv4(), videoId, i, shots[i].prompt, shots[i].durationS, videoRoute?.provider ?? "tbd", videoRoute?.model.id ?? "tbd"]);
        }
        // Estimate.
        const totalSeconds = shots.reduce((a, s) => a + s.durationS, 0);
        if (totalSeconds > videoMaxSecondsPerProject()) {
            throw new Error(`LIMIT:This plan would generate ${totalSeconds} seconds of video, over the ${videoMaxSecondsPerProject()}-second project cap. Try a shorter video.`);
        }
        const rate = videoRoute ? videoShotCostUsd(videoRoute.model, 1) : 0.112; // kling reference rate
        const voiceoverChars = scriptMarkdown.length;
        const ttsRatePerChar = process.env.GOOGLE_GENAI_API_KEY ? 0 : 0.000015; // google free tier vs openai tts-1
        const costUsd = Math.round((totalSeconds * rate + voiceoverChars * ttsRatePerChar + 0.05) * 100) / 100;
        const estimatedMinutes = Math.max(1, Math.ceil(shots.length * 1.5) + 2);
        const warning = videoRoute
            ? null
            : "No video provider is set up yet — the clips can't be generated until one is configured.";
        const estimate = {
            costUsd,
            totalSeconds,
            estimatedMinutes,
            shots: shots.length,
            provider: videoRoute?.provider ?? null,
            model: videoRoute?.model.id ?? null,
            providerConfigured: videoRoute !== null,
            warning,
            scriptMarkdown,
            voiceoverChars,
            progress: { phase: "estimate", done: 100, total: 100, message: "Estimate ready." },
        };
        await pool.query("UPDATE video_projects SET status = 'awaiting_approval', current_stage = NULL, estimate = $2, updated_at = now() WHERE id = $1", [videoId, JSON.stringify(estimate)]);
    }
    catch (err) {
        const message = plainError(err, "The estimate couldn't be computed. Please try again.");
        await pool.query(`UPDATE video_projects
       SET status = 'failed', current_stage = NULL,
           estimate = COALESCE(estimate, '{}'::jsonb) || jsonb_build_object('error', $2::text),
           updated_at = now()
       WHERE id = $1`, [videoId, message]);
    }
    finally {
        activeVideos.delete(videoId);
    }
}
function parseStoryboard(text, wantCount, model) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m)
        throw new Error("The storyboard didn't come back as JSON. Please try again.");
    let parsed;
    try {
        parsed = JSON.parse(m[0]);
    }
    catch {
        throw new Error("The storyboard didn't come back as JSON. Please try again.");
    }
    const raw = parsed.shots;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("The storyboard came back empty. Please try again.");
    }
    const shots = raw.slice(0, 40).map((s) => ({
        prompt: typeof s.prompt === "string" && s.prompt.trim() ? s.prompt.trim().slice(0, 500) : "A cinematic establishing shot.",
        durationS: normalizeShotDuration(model, typeof s.durationSeconds === "number" ? s.durationSeconds : 8),
    }));
    void wantCount;
    return shots;
}
export async function approveVideo(userId, videoId) {
    const pool = getPool();
    const video = await getVideo(userId, videoId);
    if (!video)
        return { ok: false, status: 404, code: "NOT_FOUND", message: "Video not found." };
    if (video.status !== "awaiting_approval") {
        return {
            ok: false,
            status: 400,
            code: "VALIDATION_ERROR",
            message: "This video can't be approved in its current state.",
        };
    }
    const est = video.estimate;
    if (!est || est.totalSeconds <= 0) {
        return { ok: false, status: 400, code: "VALIDATION_ERROR", message: "There's no estimate to approve yet." };
    }
    // The provider must exist NOW (keys can vanish between estimate and approve).
    const country = (await getUserCountry(userId)) ?? "";
    let videoRoute = null;
    if (video.preferred_provider) {
        if (isDeadModelId(video.preferred_provider)) {
            return { ok: false, status: 400, code: "VALIDATION_ERROR", message: "That video model is not available." };
        }
        videoRoute = pickVideoProvider(country, video.preferred_provider);
    }
    else {
        videoRoute = pickVideoProvider(country);
    }
    if (!videoRoute) {
        return {
            ok: false,
            status: 503,
            code: "NO_PROVIDER_AVAILABLE",
            message: "Video generation isn't set up right now — no video provider is available for your region.",
        };
    }
    if (isVideoModelRetired(videoRoute.model)) {
        return { ok: false, status: 400, code: "VALIDATION_ERROR", message: "That video model is no longer available." };
    }
    if (!(await hasLiveConsent(userId, videoRoute.provider))) {
        const name = CONSENT_COPY[videoRoute.provider]?.name ?? videoRoute.provider;
        return {
            ok: false,
            status: 403,
            code: "CONSENT_REQUIRED",
            message: `To generate video with ${name}, please allow Genze to share your video descriptions with them first.`,
        };
    }
    // Env caps (hard gate).
    if (est.totalSeconds > videoMaxSecondsPerProject()) {
        return {
            ok: false,
            status: 400,
            code: "VALIDATION_ERROR",
            message: `This video would generate ${est.totalSeconds} seconds, over the ${videoMaxSecondsPerProject()}-second project cap.`,
        };
    }
    if (est.costUsd !== null && est.costUsd > videoMaxSpendUsd()) {
        return {
            ok: false,
            status: 400,
            code: "VALIDATION_ERROR",
            message: `This video is estimated at $${est.costUsd.toFixed(2)}, over the $${videoMaxSpendUsd().toFixed(2)} project spend cap.`,
        };
    }
    // Daily quota (seconds) + credit balance pre-check.
    const limit = await checkLimit(userId, "video", est.totalSeconds);
    if (!limit.ok) {
        return { ok: false, status: 429, code: "LIMIT_EXCEEDED", message: "limit" };
    }
    await ensureDailyGrant(userId);
    if ((await getBalance(userId)) < est.totalSeconds) {
        return {
            ok: false,
            status: 402,
            code: "CREDITS_EXHAUSTED",
            message: "You don't have enough credits for this video. Your free credits refill daily.",
        };
    }
    // Stamp the resolved provider/model onto the shots, then start the run.
    await pool.query("UPDATE video_shots SET provider = $2, model = $3 WHERE video_id = $1", [
        videoId,
        videoRoute.provider,
        videoRoute.model.id,
    ]);
    const providerPatch = JSON.stringify({
        provider: videoRoute.provider,
        model: videoRoute.model.id,
        providerConfigured: true,
        warning: null,
    });
    await pool.query(`UPDATE video_projects SET status = 'running', approved_at = now(), current_stage = 'shots',
       estimate = COALESCE(estimate, '{}'::jsonb) || $2::jsonb,
       updated_at = now() WHERE id = $1`, [videoId, providerPatch]);
    enqueueVideoRun(videoId);
    return { ok: true };
}
/* ---------------- project run ---------------- */
async function failProject(videoId, userId, title, message, stage) {
    const pool = getPool();
    await pool.query(`UPDATE video_projects
     SET current_stage = $2,
         estimate = COALESCE(estimate, '{}'::jsonb) || jsonb_build_object('error', $3::text),
         updated_at = now()
     WHERE id = $1`, [videoId, stage, message]);
    await insertNotification(videoId, userId, `Your video “${title}” couldn't be finished. ${message}`);
    await pool.query("UPDATE video_projects SET status = 'failed', updated_at = now() WHERE id = $1", [videoId]);
}
async function insertNotification(videoId, userId, title) {
    // Exactly one notification per video (SQL-guarded).
    await getPool().query(`INSERT INTO agent_notifications (id, user_id, video_id, title)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM agent_notifications WHERE video_id = $3)`, [uuidv4(), userId, videoId, title]);
}
async function renderShot(videoId, shot, model, userId) {
    if (activeShots.has(shot.id))
        return;
    activeShots.add(shot.id);
    try {
        await getPool().query("UPDATE video_shots SET status = 'generating', error = NULL WHERE id = $1", [shot.id]);
        // Credits per generated second (fail-closed: no deduction, no render).
        const paid = await spendCredits(userId, shot.duration_s, `video:${videoId}:shot-${shot.n}`);
        if (!paid) {
            throw new Error("CREDITS:You ran out of credits while rendering. Your free credits refill daily.");
        }
        let bytes;
        try {
            bytes = await generateVideoShotBytes(model, shot.prompt, shot.duration_s);
        }
        catch (err) {
            // One automatic retry on provider failure; then honest failure.
            if (err instanceof StudioProviderError) {
                bytes = await generateVideoShotBytes(model, shot.prompt, shot.duration_s);
            }
            else {
                throw err;
            }
        }
        const key = `studio-shot-${uuidv4()}.mp4`;
        await getStorage().put(key, bytes);
        await getPool().query("UPDATE video_shots SET status = 'ready', storage_key = $2 WHERE id = $1", [shot.id, key]);
        await recordUsage({
            userId,
            feature: "video",
            provider: shot.provider,
            units: shot.duration_s,
            costUsd: videoShotCostUsd(model, shot.duration_s),
            details: { model: model.id, shot: shot.n },
        });
    }
    finally {
        activeShots.delete(shot.id);
    }
}
export async function runVideoProject(videoId) {
    if (activeVideos.has(videoId))
        return;
    activeVideos.add(videoId);
    const aborter = new AbortController();
    aborters.set(videoId, aborter);
    const pool = getPool();
    try {
        const r = await pool.query(`SELECT ${VIDEO_COLUMNS} FROM video_projects WHERE id = $1`, [videoId]);
        if (!r.rowCount || r.rows[0].status !== "running")
            return;
        const video = r.rows[0];
        const userId = video.user_id;
        const country = (await getUserCountry(userId)) ?? "";
        const est = video.estimate;
        // Resolve the provider again (fail-closed if keys vanished mid-run).
        let videoRoute = null;
        if (video.preferred_provider && !isDeadModelId(video.preferred_provider)) {
            videoRoute = pickVideoProvider(country, video.preferred_provider);
        }
        else if (!video.preferred_provider) {
            videoRoute = pickVideoProvider(country);
        }
        if (!videoRoute || isVideoModelRetired(videoRoute.model)) {
            await failProject(videoId, userId, video.title, "Video generation isn't available right now.", "shots");
            return;
        }
        const model = videoRoute.model;
        // --- shots ---
        await setStage(videoId, "shots");
        let shots = await getVideoShots(videoId);
        for (const shot of shots) {
            throwIfAborted(videoId);
            if (shot.status === "ready")
                continue;
            const fresh = await pool.query(`SELECT status FROM video_projects WHERE id = $1`, [videoId]);
            if (!fresh.rowCount || fresh.rows[0].status !== "running")
                return; // discarded mid-run
            await setProgress(videoId, {
                phase: "shots",
                done: shots.filter((s) => s.status === "ready").length,
                total: shots.length,
                message: `Rendering clip ${shot.n + 1} of ${shots.length}…`,
            });
            try {
                await renderShot(videoId, { ...shot, provider: videoRoute.provider, model: model.id }, model, userId);
            }
            catch (err) {
                const msg = plainError(err, `Clip ${shot.n + 1} couldn't be rendered.`);
                await pool.query("UPDATE video_shots SET status = 'failed', error = $2 WHERE id = $1", [shot.id, msg]);
                await failProject(videoId, userId, video.title, msg, "shots");
                return;
            }
            shots = await getVideoShots(videoId);
        }
        throwIfAborted(videoId);
        // --- voiceover (TTS of the narration) ---
        await setStage(videoId, "voiceover");
        const narration = (est?.scriptMarkdown ?? "").trim() || video.brief;
        const language = await getUserLanguage(userId);
        const sentences = splitSentences(narration);
        const chunks = [];
        let current = "";
        for (const s of sentences) {
            if ((current + " " + s).trim().length > 4500) {
                if (current.trim())
                    chunks.push(current.trim());
                current = s;
            }
            else {
                current = (current + " " + s).trim();
            }
        }
        if (current.trim())
            chunks.push(current.trim());
        await setProgress(videoId, { phase: "voiceover", done: 0, total: chunks.length, message: "Recording the voiceover…" });
        const ttsBuffers = [];
        let voiceoverChars = 0;
        for (let i = 0; i < chunks.length; i++) {
            throwIfAborted(videoId);
            try {
                const tts = await synthesizeSpeech({
                    text: chunks[i],
                    language,
                    userId,
                    country,
                    voice: i % 2 === 0 ? "A" : "B",
                });
                ttsBuffers.push(tts.audio);
                voiceoverChars += chunks[i].length;
                await recordUsage({
                    userId,
                    feature: "voice",
                    provider: tts.provider,
                    units: chunks[i].length / 1000,
                    costUsd: (chunks[i].length / 1e6) * (TTS_COST_PER_M[tts.provider] ?? 15),
                    details: { kind: "tts", model: tts.model, source: `video:${videoId}` },
                });
            }
            catch (err) {
                const msg = err instanceof VoiceGateError ? err.message : "The voiceover couldn't be recorded.";
                await failProject(videoId, userId, video.title, msg, "voiceover");
                return;
            }
            await setProgress(videoId, {
                phase: "voiceover",
                done: i + 1,
                total: chunks.length,
                message: "Recording the voiceover…",
            });
        }
        const voiceoverBytes = await concatMp3(ttsBuffers);
        const voiceoverKey = `studio-voiceover-${uuidv4()}.mp3`;
        await getStorage().put(voiceoverKey, voiceoverBytes);
        // --- music (v1: user-uploaded bed only; generated music is honestly "not in v1") ---
        await setStage(videoId, "music");
        await setProgress(videoId, { phase: "music", done: 1, total: 1, message: "Music…" });
        let musicKey = null;
        if (video.music_file_id) {
            const f = await pool.query("SELECT storage_key, status FROM files WHERE id = $1 AND user_id = $2", [video.music_file_id, userId]);
            if (f.rowCount && f.rows[0].status === "ready")
                musicKey = f.rows[0].storage_key;
        }
        // --- captions (real SRT from narration segments) ---
        await setStage(videoId, "captions");
        await setProgress(videoId, { phase: "captions", done: 1, total: 1, message: "Writing captions…" });
        const voiceSeconds = Math.max(1, voiceoverChars / 14);
        const srt = buildSrt(sentences.length ? sentences : [narration.slice(0, 200)], voiceSeconds);
        const srtKey = `studio-captions-${uuidv4()}.srt`;
        await getStorage().put(srtKey, Buffer.from(srt, "utf8"));
        // --- assembly ---
        await setStage(videoId, "assembly");
        await setProgress(videoId, { phase: "assembly", done: 0, total: 1, message: "Assembling the final video…" });
        throwIfAborted(videoId);
        const finalShots = await getVideoShots(videoId);
        const shotKeys = finalShots.filter((s) => s.status === "ready" && s.storage_key).map((s) => s.storage_key);
        if (shotKeys.length === 0) {
            await failProject(videoId, userId, video.title, "No clips were rendered.", "assembly");
            return;
        }
        let output;
        try {
            output = await assembleVideo({ shotKeys, voiceoverKey, musicKey, srtKey }, finalShots.map((s) => s.duration_s));
        }
        catch (err) {
            const msg = err instanceof StudioProviderError ? err.message : "The final video couldn't be assembled.";
            await failProject(videoId, userId, video.title, msg, "assembly");
            return;
        }
        // --- terminal: report, notification, THEN status ---
        const totalSeconds = finalShots.reduce((a, s) => a + s.duration_s, 0);
        const reportMarkdown = `Video “${video.title}” finished: ${finalShots.length} clips, ${totalSeconds}s, ` +
            `voiceover ${voiceoverChars} chars${musicKey ? ", music bed mixed" : ""}, captions included.`;
        await pool.query(`UPDATE video_projects
       SET estimate = COALESCE(estimate, '{}'::jsonb) || jsonb_build_object('reportMarkdown', $2::text, 'output', $3::jsonb),
           updated_at = now()
       WHERE id = $1`, [
            videoId,
            reportMarkdown,
            JSON.stringify({ storageKey: output.storageKey, srtKey, voiceoverKey }),
        ]);
        await insertNotification(videoId, userId, `Your video “${video.title}” is ready.`);
        await pool.query("UPDATE video_projects SET status = 'done', current_stage = NULL, updated_at = now() WHERE id = $1", [videoId]);
    }
    catch (err) {
        if (err.aborted) {
            // Discarded mid-run: the DELETE route already flipped the status.
            return;
        }
        try {
            const r = await pool.query(`SELECT ${VIDEO_COLUMNS} FROM video_projects WHERE id = $1`, [videoId]);
            if (r.rowCount && (r.rows[0].status === "running" || r.rows[0].status === "estimating")) {
                await failProject(videoId, r.rows[0].user_id, r.rows[0].title, plainError(err, "The video couldn't be finished."), r.rows[0].current_stage);
            }
        }
        catch {
            // Last-resort: never leave the job hanging silently.
        }
    }
    finally {
        activeVideos.delete(videoId);
        aborters.delete(videoId);
    }
}
/* ---------------- shot regenerate (route-called, running only) ---------------- */
export async function regenerateShot(userId, videoId, shotId) {
    const pool = getPool();
    const video = await getVideo(userId, videoId);
    if (!video)
        return { ok: false, status: 404, code: "NOT_FOUND", message: "Video not found." };
    if (video.status !== "running") {
        return { ok: false, status: 400, code: "VALIDATION_ERROR", message: "Shots can only be re-rendered while the video is running." };
    }
    const s = await pool.query("SELECT id, video_id, n, prompt, duration_s, provider, model, status, storage_key, error, created_at FROM video_shots WHERE id = $1 AND video_id = $2", [shotId, videoId]);
    if (!s.rowCount)
        return { ok: false, status: 404, code: "NOT_FOUND", message: "Shot not found." };
    const shot = s.rows[0];
    if (isShotActive(shot.id)) {
        return { ok: false, status: 409, code: "VALIDATION_ERROR", message: "That clip is already rendering." };
    }
    const country = (await getUserCountry(userId)) ?? "";
    let videoRoute = null;
    if (video.preferred_provider && !isDeadModelId(video.preferred_provider)) {
        videoRoute = pickVideoProvider(country, video.preferred_provider);
    }
    else if (!video.preferred_provider) {
        videoRoute = pickVideoProvider(country);
    }
    if (!videoRoute || isVideoModelRetired(videoRoute.model)) {
        return { ok: false, status: 503, code: "NO_PROVIDER_AVAILABLE", message: "Video generation isn't available right now." };
    }
    if (!(await hasLiveConsent(userId, videoRoute.provider))) {
        return { ok: false, status: 403, code: "CONSENT_REQUIRED", message: "Please allow video generation first." };
    }
    // Charge again for the re-render (fail-closed).
    const paid = await spendCredits(userId, shot.duration_s, `video:${videoId}:shot-${shot.n}:regen`);
    if (!paid) {
        return { ok: false, status: 402, code: "CREDITS_EXHAUSTED", message: "You don't have enough credits to re-render that clip." };
    }
    const model = VIDEO_CATALOG.find((m) => m.id === shot.model && !isVideoModelRetired(m));
    const useModel = model ?? videoRoute.model;
    await pool.query("UPDATE video_shots SET status = 'generating', error = NULL WHERE id = $1", [shot.id]);
    // Background: the route returns the video immediately; the shot flips to ready/failed.
    setImmediate(() => (async () => {
        activeShots.add(shot.id);
        try {
            const bytes = await generateVideoShotBytes(useModel, shot.prompt, shot.duration_s);
            const key = `studio-shot-${uuidv4()}.mp4`;
            await getStorage().put(key, bytes);
            const old = shot.storage_key;
            await pool.query("UPDATE video_shots SET status = 'ready', storage_key = $2 WHERE id = $1", [shot.id, key]);
            if (old) {
                try {
                    await getStorage().delete(old);
                }
                catch { /* stray object */ }
            }
            await recordUsage({
                userId,
                feature: "video",
                provider: useModel.provider,
                units: shot.duration_s,
                costUsd: videoShotCostUsd(useModel, shot.duration_s),
                details: { model: useModel.id, shot: shot.n, regen: true },
            });
        }
        catch (err) {
            await pool.query("UPDATE video_shots SET status = 'failed', error = $2 WHERE id = $1", [
                shot.id,
                plainError(err, "That clip couldn't be rendered."),
            ]);
        }
        finally {
            activeShots.delete(shot.id);
        }
    })().catch((err) => console.warn("[studio] shot regen failed:", err)));
    return { ok: true };
}
/* ---------------- delete (route + library) ---------------- */
/** Cancel a live run and delete the project, its shots and all stored bytes. */
export async function deleteVideoProject(userId, videoId) {
    const pool = getPool();
    const video = await getVideo(userId, videoId);
    if (!video)
        return false;
    abortVideo(videoId);
    const shots = await getVideoShots(videoId);
    const keys = [];
    for (const s of shots)
        if (s.storage_key)
            keys.push(s.storage_key);
    const out = (video.estimate?.output ?? null);
    if (out?.storageKey)
        keys.push(out.storageKey);
    if (out?.srtKey)
        keys.push(out.srtKey);
    if (out?.voiceoverKey)
        keys.push(out.voiceoverKey);
    await pool.query("DELETE FROM video_projects WHERE id = $1", [videoId]);
    for (const k of keys) {
        try {
            await getStorage().delete(k);
        }
        catch { /* best effort */ }
    }
    return true;
}
//# sourceMappingURL=runner.js.map