// Genze API entry point.
//
// `pnpm dev` / `pnpm start` -> main(): run migrations, then listen.
// Tests import buildApp() and drive it with fastify.inject (no network).
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { recordAbuseEvent, maybeAutoBan } from "./abuse.js";
import { sendError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { adminRoutes } from "./routes/admin.js";
import { systemRoutes } from "./routes/system.js";
import { chatRoutes } from "./routes/chat.js";
import { fileRoutes } from "./routes/files.js";
import { projectRoutes } from "./routes/projects.js";
import { libraryRoutes } from "./routes/library.js";
import { researchRoutes } from "./research/routes.js";
import { writeRoutes } from "./write/routes.js";
import { memoryRoutes } from "./memory/routes.js";
import { connectorRoutes } from "./connectors/routes.js";
import { customConnectorRoutes } from "./connectors/customRoutes.js";
import { browserSiteRoutes } from "./browserSites/routes.js";
import { skillsRoutes, skillAttachmentRoutes } from "./skills/routes.js";
import { gemsRoutes, gemAttachmentRoutes } from "./gems/routes.js";
import { agentRoutes } from "./agent/routes.js";
import { sweepStaleJobs } from "./research/runner.js";
import { sweepStaleAgentTasks } from "./agent/runner.js";
import { sweepStaleBrowserLogins } from "./browserSites/manager.js";
import { agentScheduleRoutes, startAgentScheduler } from "./agent/schedules.js";
import { agentNotificationRoutes } from "./agent/notifications.js";
import { studioImageRoutes, sweepStaleStudioImages } from "./studio/images.js";
import { studioVoiceRoutes, chatVoiceNoteRoutes } from "./studio/voice.js";
import { studioConsentRoutes } from "./studio/consent.js";
import { videoRoutes, sweepStaleVideoProjects } from "./studio/video/routes.js";
import { audioOverviewRoutes, sweepStaleAudioOverviews } from "./studio/audioOverviews.js";
import { moderationRoutes } from "./moderation/routes.js";
export async function buildApp(options = {}) {
    const config = loadConfig();
    const app = Fastify({ logger: options.logger ?? false, trustProxy: true });
    // CORS: the web origin is the ONLY origin that gets credentialed
    // cross-origin access (never `*` for credentialed traffic). Native apps
    // (iOS/Android) send no `Origin` header at all, and @fastify/cors only
    // controls the Access-Control-Allow-Origin header for requests that DO
    // carry an Origin — origin-less requests are passed through untouched,
    // never rejected. So the mobile app talks to this API directly with no
    // CORS config of its own.
    //
    // Mobile OAuth story (store readiness): OAuth authorization endpoints
    // redirect back to a server-side callback (e.g.
    // /api/v1/auth/oauth/google/callback), which 302s to ${APP_URL}/...
    // For native builds that URL must become a `genze://` deep link instead
    // of the web URL — see CONTRACTS.md "Step 10 — backend store-readiness"
    // (a config switch, not a CORS change; route behavior is unchanged here).
    await app.register(cors, { origin: [config.appUrl], credentials: true });
    if (!options.disableRateLimit) {
        await app.register(rateLimit, {
            global: false, // limits are opt-in per route (see routes/auth.ts)
            // NOTE: @fastify/rate-limit v10 THROWS whatever this returns (see its
            // `throw params.errorResponseBuilder(req, respCtx)`), so it must be an
            // Error carrying statusCode 429. Our setErrorHandler maps it to the
            // contract envelope below.
            errorResponseBuilder: (_req, context) => {
                const secs = Math.max(1, Math.ceil(context.ttl / 1000));
                const err = new Error(`Too many requests. Please try again in ${secs} seconds.`);
                err.statusCode = 429;
                err.code = "RATE_LIMITED";
                return err;
            },
        });
    }
    app.setErrorHandler((err, req, reply) => {
        if (reply.sent)
            return;
        const e = err;
        const status = typeof e.statusCode === "number" ? e.statusCode : 500;
        if (status === 429) {
            const code = typeof e.code === "string" ? e.code : "RATE_LIMITED";
            const message = typeof e.message === "string" && e.message ? e.message : "Too many requests.";
            // Abuse protection: hammering a rate-limited endpoint is an abuse
            // signal. Record it and auto-ban past the threshold (fire-and-forget).
            const userId = req.auth?.userId;
            if (userId) {
                void recordAbuseEvent(userId, "rate_limit", `${req.method} ${req.url}`).then(() => maybeAutoBan(userId));
            }
            return sendError(reply, 429, code, message);
        }
        if (status === 400 && e.validation) {
            return sendError(reply, 400, "VALIDATION_ERROR", "Invalid request.");
        }
        if (status >= 500)
            req.log.error(err);
        if (status >= 500)
            return sendError(reply, 500, "INTERNAL_ERROR", "Something went wrong.");
        const message = typeof e.message === "string" && e.message ? e.message : "Request failed.";
        return sendError(reply, status, status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR", message);
    });
    app.setNotFoundHandler((req, reply) => sendError(reply, 404, "NOT_FOUND", `Route ${req.method} ${req.url} not found.`));
    await app.register(authRoutes, { prefix: "/api/v1/auth" });
    await app.register(accountRoutes, { prefix: "/api/v1/account" });
    await app.register(adminRoutes, { prefix: "/api/v1/admin" });
    await app.register(systemRoutes, { prefix: "/api/v1" });
    await app.register(chatRoutes, { prefix: "/api/v1/chat" });
    await app.register(fileRoutes, { prefix: "/api/v1/files" });
    await app.register(projectRoutes, { prefix: "/api/v1/projects" });
    await app.register(libraryRoutes, { prefix: "/api/v1/library" });
    await app.register(researchRoutes, { prefix: "/api/v1/research" });
    await app.register(writeRoutes, { prefix: "/api/v1/write" });
    await app.register(memoryRoutes, { prefix: "/api/v1/memory" });
    await app.register(connectorRoutes, { prefix: "/api/v1/connectors" });
    await app.register(customConnectorRoutes, { prefix: "/api/v1/connectors/custom" });
    await app.register(browserSiteRoutes, { prefix: "/api/v1/connectors/browser-sites" });
    await app.register(skillsRoutes, { prefix: "/api/v1/skills" });
    await app.register(skillAttachmentRoutes, { prefix: "/api/v1" });
    await app.register(gemsRoutes, { prefix: "/api/v1/gems" });
    await app.register(gemAttachmentRoutes, { prefix: "/api/v1" });
    await app.register(agentRoutes, { prefix: "/api/v1/agent" });
    // step 7 agent schedules+notifications routes
    // Step 7b — agent schedules + notifications (backend-extra worker).
    // The sibling core worker registers its own core agent routes here with
    // the marker `// step 7 agent schedules+notifications routes`; these two
    // registrations are independent of it and must not be moved.
    await app.register(agentScheduleRoutes, { prefix: "/api/v1/agent" });
    await app.register(agentNotificationRoutes, { prefix: "/api/v1/agent" });
    // Step 9 — Studio: images, voice, Video Director, Audio Overviews.
    await app.register(studioImageRoutes, { prefix: "/api/v1/studio" });
    await app.register(studioVoiceRoutes, { prefix: "/api/v1/studio" });
    await app.register(studioConsentRoutes, { prefix: "/api/v1/studio" });
    await app.register(videoRoutes, { prefix: "/api/v1/studio" });
    await app.register(audioOverviewRoutes, { prefix: "/api/v1/studio" });
    // Chat voice notes live on the chat prefix (delegates to the normal
    // threaded message flow); routes/chat.ts itself is untouched.
    await app.register(chatVoiceNoteRoutes, { prefix: "/api/v1/chat" });
    // Step 10 — moderation toolkit (report/block for the mobile/web report
    // buttons). Registered under its own prefix; owner triage routes reuse
    // requireOwner.
    await app.register(moderationRoutes, { prefix: "/api/v1/moderation" });
    // In-process scheduler for agent schedules (Step 7b). Never a live ticker
    // in tests (NODE_ENV=test); tests drive runDueSchedulesOnce() directly.
    if (process.env.NODE_ENV !== "test") {
        try {
            startAgentScheduler();
        }
        catch (err) {
            console.warn("[api] agent scheduler failed to start:", err?.message ?? err);
        }
    }
    // Boot sweep: jobs stuck in `running` (the process died mid-run) fail
    // honestly instead of hanging forever.
    try {
        const swept = await sweepStaleJobs();
        const sweptAgent = await sweepStaleAgentTasks();
        const sweptLogins = await sweepStaleBrowserLogins();
        const sweptVideos = await sweepStaleVideoProjects();
        const sweptImages = await sweepStaleStudioImages();
        const sweptOverviews = await sweepStaleAudioOverviews();
        const total = swept + sweptAgent + sweptVideos + sweptImages + sweptOverviews;
        if (total > 0)
            console.log(`[api] boot sweep: marked ${total} stale job(s) failed`);
        if (sweptLogins > 0)
            console.log(`[api] boot sweep: cleared ${sweptLogins} expired browser login session(s)`);
    }
    catch (err) {
        console.warn("[api] boot sweep failed:", err?.message ?? err);
    }
    return app;
}
async function main() {
    const config = loadConfig();
    const ran = await runMigrations(config.databaseUrl);
    if (ran.length)
        console.log(`[api] migrations applied: ${ran.join(", ")}`);
    const app = await buildApp({ logger: true });
    await app.listen({ port: config.apiPort, host: "0.0.0.0" });
    console.log(`[api] listening on http://localhost:${config.apiPort}`);
}
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
    main().catch((err) => {
        console.error("[api] failed to start:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map