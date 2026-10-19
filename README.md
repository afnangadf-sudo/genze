# Genze — Step 3: Files, Projects, Library

Monorepo (`pnpm` workspaces):

- `apps/web` — Next.js 15 web app (the product UI)
- `apps/api` — Fastify + TypeScript API (auth, accounts, provider routing, chat, files, projects, library)
- `packages/shared` — shared TypeScript types + API route constants

Step 1 covered: project structure, auth (email+password, verification, reset,
optional TOTP 2FA, Google OAuth disabled-by-default), accounts (devices, sign-out,
export, **delete account and all data**), provider interface skeleton with
region routing + kill switches, and metering schema.

Step 2 adds: real **Chat** tab — threads (create/list/rename/delete), SSE
streaming replies, Anthropic + OpenAI provider integrations, a smart router that
picks the cheapest capable model per task type, region-aware routing
(fail-closed), a per-provider consent gate (403 until granted), per-reply
metering, and a clearly-labeled **demo mode** when no provider keys are set.
Manual model choice exists in the API only (hidden in the UI).

Step 3 adds: **file upload** (PDF, DOCX, XLSX/CSV, images, audio — text
extracted at upload, audio transcribed when `OPENAI_API_KEY` is set), private
local-disk storage behind an S3-compatible interface with short-lived signed
download links, **Projects** (saved instructions + attached files; chats in a
project inherit both), multi-file Q&A in chat (attached files' text injected
with a token budget; images also sent as provider vision input), and a real
**Library** tab (unified search across projects, chats and files; delete
anything).

## Prerequisites

- Node.js 20+ and `pnpm` 10 (`npm i -g pnpm`)
- Docker + Docker Compose **or** a local PostgreSQL 16 + Redis 7

## Run locally

```bash
# 1. Start Postgres (with pgvector) + Redis
docker compose up -d

# 2. Install dependencies
pnpm install

# 3. Configure (optional — the app boots with zero keys set)
cp .env.example .env
# At minimum, nothing is required: JWT secrets auto-generate in dev (with a warning).

# 4. Run database migrations
pnpm migrate

# 5. Start everything (web on :3000, api on :4000)
pnpm dev
```

Open http://localhost:3000. Sign up, verify via the token printed in the API
console (dev email mode), log in.

Without Docker: set `DATABASE_URL` and `REDIS_URL` in `.env` to your local
Postgres/Redis and skip step 1.

## Tests

```bash
pnpm test        # all workspace tests (API auth flow + provider router + chat + moderation + Apple sign-in)
pnpm typecheck   # TypeScript across the monorepo (shared, api, web, mobile)
```

### Mobile app (`apps/mobile`)

Expo (TypeScript strict) at `apps/mobile` — see its README and
`STORE_CHECKLIST.md`. Real screens against the API: auth (incl. Sign in
with Apple on iOS), AI-consent screen, chat (SSE streaming), voice mode
(tap-to-talk → STT → chat → TTS) and record mode, settings (language,
usage, consent revoke, account deletion). Research/Write/Studio are honest
"coming soon" stubs; Library is fully wired.

```bash
cd apps/mobile && npx tsc --noEmit   # strict typecheck
```

`npx expo install --fix` is required before any real run/build. No
real-device testing, EAS build, or store submission was possible here —
`STORE_CHECKLIST.md` lists everything remaining outside code (Apple
Developer $99/yr, Play $25, device testing, Play Console questionnaires,
native-speaker copy review).

API tests need a database: they use `TEST_DATABASE_URL` if set, otherwise
`DATABASE_URL` with the database name replaced by `genze_test` (created automatically).

### Web i18n checks

```bash
pnpm --filter @genze/web test   # dictionaries, RTL, rendering spot-checks
```

The web test compiles `apps/web/lib/i18n.ts` in isolation and asserts: all
five dictionaries share exactly the same key set (zero missing/extra), the
`LANGS` registry covers all codes with correct RTL flags, `langDir` returns
`rtl` for ur/ar/fa and `ltr` for en/tr, and a translated fragment renders per
language with the right `dir` (switching dictionaries changes the output).

## Adding a new language (e.g. Pashto)

Dictionary-only change — no component edits:

1. In `apps/web/lib/i18n.ts`, copy any `Strings` dictionary (e.g. `ur`), name
   it after the new code (`const ps: Strings = { … }`), and translate every
   key. The `Strings` type enforces completeness: a missing key is a
   compile error, and `pnpm --filter @genze/web test` fails on any mismatch.
2. Add one line to the `LANGS` registry in the same file:
   `{ code: "ps", nativeName: "پښتو", rtl: true },`
3. Add the code to `STRINGS`: `{ en, ur, ar, tr, fa, ps }`.

That's it. The picker, `dir`/`lang` handling, fonts hook (`html[lang="ps"]`
rule in `globals.css` if it needs its own font), the settings-page preferred
language, and the server contract (`preferredLanguage`) all follow from the
registry. Backend: nothing to change — since the 2026-10-18 open-languages
correction, `users.preferred_language` accepts any BCP-47 code as free text
(no CHECK constraint) and chat/translate already work for every language
via `languageDisplayName()`.

## Environment

See `.env.example` — every key the app will ever need is documented there.
Unset AI provider keys simply report "not configured"; Google OAuth endpoints
return `503 NOT_CONFIGURED` until both OAuth vars are set.

Step 2 additions:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — chat providers. With neither set,
  chat runs in **demo mode** (canned, clearly-labeled replies; nothing leaves
  the server) so the UI is tryable with zero keys.
- `ANTHROPIC_CHAT_MODEL`, `ANTHROPIC_REASONING_MODEL`, `OPENAI_CHAT_MODEL`,
  `OPENAI_REASONING_MODEL` — optional model-id overrides for the smart router
  (defaults from Oct 2026 research; re-verify before launch).
- `PROVIDER_DISABLED` — comma-separated kill switch, e.g. `"anthropic"`;
  disabled providers are excluded from routing.

Chat API (all under `/api/v1/chat`, auth required): threads
`POST/GET /threads`, `GET/PATCH/DELETE /threads/:id`; messages
`GET /threads/:id/messages`, `POST /threads/:id/messages` (SSE
`text/event-stream`: `start` → `token`* → `done`, or terminal `error`;
accepts `fileIds` for multi-file Q&A), `DELETE /messages/:id`; consent `GET/POST /chat/consent`,
`DELETE /chat/consent/:provider`. First AI request per provider requires
consent (403 `CONSENT_REQUIRED` until granted); unknown/blocked countries get
503 `NO_PROVIDER_AVAILABLE`. Every completed reply writes a `usage_events`
metering row (no enforcement yet — Step 5).

Step 3 additions:

- File API (`/api/v1/files`, auth): `POST /` (multipart: `file` + optional
  `projectId` field; 50 MB default cap via `MAX_FILE_MB`), `GET /` (metadata
  list, `?projectId=` filter), `GET /:id` (metadata + extracted text),
  `GET /:id/link` (signed download URL), `GET /:id/download` (signed, no auth
  header), `DELETE /:id` (row + stored object).
- Project API (`/api/v1/projects`, auth): full CRUD; delete cascades to the
  project's files (rows + stored objects).
- Library API (`/api/v1/library`, auth): `GET /?q=` unified search across
  projects/chats/files (+ empty report/video/agent-task groups);
  `DELETE /:type/:id`.
- Chat threads accept `projectId`; replies inherit project instructions +
  project file context.
- Env: `MAX_FILE_MB=50`, `STORAGE_DIR=` (default `./storage`), 
  `SIGNED_LINK_TTL_SEC=900`, `FILE_CONTEXT_CHARS=60000`.

Quick wins additions:

- Temporary chat (`POST /api/v1/chat/temporary/messages`, auth): stateless
  SSE chat — `{messages: [{role, content}] (1–40, 1–8000 chars), taskType?,
  model?}`; no threads/messages ever persisted; same demo/routing/consent
  gates as threaded chat; `fileIds` rejected with 400.
- Lockdown mode: `PATCH /chat/threads/:id` accepts `{title?, lockdown?}`;
  `chatAugmentations(thread)` is the enforcement seam consulted before any
  augmentation (web/agent/memory) fires; attachments and project instructions
  keep working in lockdown.
- Thread compaction: long threads auto-summarize old messages with the same
  provider that answers (same consent), newest 10 kept verbatim; client gets
  `{"type":"compacted"}` right after the SSE `start` event.
- Env: `COMPACTION_TRIGGER_CHARS=100000`, `COMPACTION_KEEP_MESSAGES=10`,
  `COMPACTION_SUMMARY_MAX_CHARS=4000`.

Step 4 additions:

- Research API (`/api/v1/research`, auth): `POST /jobs` `{topic, threadId?}`
  → plan generated in the background (3–6 steps via the chat router);
  `POST /jobs/:id/start` begins search → fetch → synthesize (explicit
  plan-confirmation gate — research never spends budget without a start);
  `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events` (SSE progress replay +
  live until terminal `done`/`error`), `DELETE /jobs/:id` (aborts a live run,
  deletes the row), `GET /jobs/:id/export?format=pdf|docx|md`,
  `GET /jobs/:id/citations?style=apa|mla`. Gate order: auth → validation →
  thread ownership (404) → locked thread (403 `LOCKDOWN`) → no search key
  (503 `SEARCH_NOT_CONFIGURED`, never a fake report) → no chat provider
  (503 `NO_PROVIDER_AVAILABLE`) → no consent (403 `CONSENT_REQUIRED`). One
  routed provider per job (`long-context`, consent checked once at creation).
  Reports carry `[n]` citations to pages actually opened (readability
  extraction, robots.txt honored) and must pass `validateCitations` (one
  retry, then honest failure). Jobs run in-process (`setImmediate`, no
  BullMQ); a boot sweep marks stale `running` jobs failed.
- Write API (`/api/v1/write`, auth): drafts CRUD;
  `POST /drafts` `{template: article|essay|summary|youtube-script|podcast-outline|email,
  brief, projectId?, styleId?}` (template-guided generation; project
  instructions + default/explicit style as system context);
  `POST /drafts/:id/revise` `{action: shorter|simpler|formal|translate-ur|translate-en}`
  → `{revised}` text only (the client persists); `POST /drafts/:id/fact-check`
  (background: extract claims → search → fetch → verify →
  supported/disputed/unverified + links; same LOCKDOWN/SEARCH_NOT_CONFIGURED
  gates); `GET /fact-checks/:id`; `GET /drafts/:id/export?format=docx|pdf|xlsx|pptx`
  (real files: xlsx = sections table, pptx = one slide per heading); styles
  CRUD; `PATCH /projects/:id` also accepts `{defaultStyleId}` (owned style or
  null).
- Memory API (`/api/v1/memory`, auth): list/add/edit/delete + `DELETE /memory`
  (forget everything, returns the count). Threaded chat prepends up to 20
  newest memories as `[What I remember about you:…]` system context when the
  `chatAugmentations()` seam allows it — never in temporary chat, never in
  lockdown. No automatic memory writes in v1.
- Library: the `report` group now lists research jobs; `DELETE
  /library/report/:id` reuses the research DELETE.
- Env: `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `SERPER_API_KEY`,
  `SEARCH_PROVIDER=tavily`, `FETCH_TIMEOUT_MS=15000`, `FETCH_MAX_CHARS=30000`,
  `RESEARCH_MAX_SOURCES=8`, `RESEARCH_MAX_SEARCHES=6`.

Step 6 additions:

- Connectors API (`/api/v1/connectors`, auth): `GET /` (directory: 8
  definitions + connected flags; gated ones carry plain-language notes),
  `GET /:id/authorize` → `{url}` (OAuth PKCE; gated → 503
  `CONNECTOR_NOT_AVAILABLE`), `GET /:id/callback?code=&state=` (single-use
  state), `POST /:id/disconnect` (best-effort vendor revoke; tokens deleted,
  audit trail KEPT with a `disconnect` entry), `GET /:id/tools` (readOnly
  from `readOnlyHint`; conservative: anything not explicitly read-only needs
  confirmation), `POST /:id/tools/:tool/call` (read-only → `{result}`;
  write → `{confirmationRequired:true, confirmation}` 15-min TTL, or
  executes with `{confirmationId}`), `POST /confirmations/:id/confirm|/cancel`,
  `GET /audit` (own log, newest first), `POST /gmail/send` (direct Gmail API,
  confirmation-gated, needs `gmail.send` scope). Tokens AES-256-GCM encrypted
  (`TOKEN_ENCRYPTION_KEY`, 64 hex; prod fail-closed). Every action audited +
  metered (`feature='connector_tool'`). MCP tool descriptions/outputs are
  DATA, never instructions (labeled context block).
- Custom connectors (`/api/v1/connectors/custom`, auth): register ANY MCP
  server by URL — `POST /custom` `{name, mcpUrl (https), authType:
  'oauth'|'token', token?, fallback?}` (409 on duplicate URL); OAuth uses
  spec discovery (401 → RFC 9728 → RFC 8414 → RFC 7591 dynamic registration;
  honest 502 when the server can't do it); token-auth stores the pasted token
  encrypted. Same tools/call/confirmations/audit endpoints accept the custom
  uuid; identical gating and audit treatment. `fallback:"browser"` marker
  stored for Step 8 (set on the onedrive definition now).
- Skills API (`/api/v1/skills`, auth): CRUD (`name` 1–80, `description` ≤500,
  `instructions` 1–8000, `scripts[]`); 3 read-only built-ins ("Brand voice",
  "Meeting notes", "Spreadsheet cleanup" — clone via POST); attach/detach to
  projects (`/api/v1/projects/:id/skills`) and threads
  (`/api/v1/chat/threads/:id/skills`). Chat prepends attached skills as
  `[Skills in use:…]` after project instructions, before memory.
- Chat + connector tools: `POST /chat/threads/:id/messages` accepts
  `useConnectors?: string[]` (connected connectors; ignored for temp/demo/
  lockdown). Bounded loop: ≤3 read-only tool calls with SSE `tool_activity`
  phases; a write tool ends the stream with terminal `confirmation_required`
  (nothing executed); re-post with `confirmedActions` continues the turn
  (turn-continuation guard — no duplicate user message).
- Env: `TOKEN_ENCRYPTION_KEY=` (64 hex), `NOTION_/SLACK_/GITHUB_/DROPBOX_MCP_CLIENT_ID|_SECRET`,
  `*_MCP_URL` overrides (verified defaults: Notion `https://mcp.notion.com/mcp`,
  GitHub `https://api.githubcopilot.com/mcp/`, Slack `https://mcp.slack.com/mcp`,
  Dropbox `https://mcp.dropbox.com/mcp`). OAuth redirect URI (built-in + custom):
  `{APP_URL}/settings/connectors/callback?connector=<id|uuid>`.
- Web: Settings → Connectors (directory cards, availability badges,
  plain-language scopes, connect/disconnect, "Can't find your app?" custom
  add-card), Connector activity (audit log), Skills (manager + project
  attach); chat ConfirmationCard + connector chips + `tool_activity` phases.

Step 7 additions (agent core):

- Agent API (`/api/v1/agent`, auth): `POST /tasks {task? 3–2000, projectId?,
  threadId?}` → 201 (status `planned`; the plan is generated in the
  background → `awaiting_approval`; the run starts on
  `POST /tasks/:id/approve`). `task` is optional when `threadId` is given —
  the task text is derived from the chat thread (title + last user message).
  `GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/cancel`,
  `GET /tasks/:id/events` (SSE: replays state + pending approvals, then
  live updates), `POST /approvals/:id/decide {approve: bool}`,
  `POST /tasks/:id/takeover {action: take|release}`.
- The agent works the approved plan in a cloud browser (Steel; mock driver
  in tests). Risky steps (buying, deleting, sending, posting, submitting)
  pause the run for explicit approval (`awaiting_confirmation`) — nothing
  risky ever executes without a yes. Page content is treated as
  untrusted data; prompt-injection attempts are logged and flagged in the
  report, never followed. Every browser action is audited
  (`connector_audit_log`, `connector_id='agent'`).
- Metering: 1 credit per started minute + `usage_events` (`feature='agent'`,
  minutes + browser/LLM cost); per-task caps `AGENT_MAX_STEPS=30`,
  `AGENT_MAX_MINUTES=15`, `AGENT_MAX_SPEND_USD=2` (lazy env). Budget breach →
  `limit_stopped`. One notification per finished task.
- Env: `STEEL_API_KEY=` (unset → 503 `BROWSER_NOT_CONFIGURED`; no fake
  runs), `STEEL_API_BASE=` (default `https://api.steel.dev`),
  `AGENT_MAX_STEPS=`, `AGENT_MAX_MINUTES=`, `AGENT_MAX_SPEND_USD=`.
  The Steel driver has not been live-tested without a key (documented);
  `BrowserDriver` is the seam for a future Browser Use swap.

Step 7b additions (agent schedules, folder scope, notifications):

- Schedules API (`/api/v1/agent/schedules`, auth): create `{title 3-80,
  task 3-2000, schedule, autoApprove?}` → 201 with the next run computed;
  list/get/patch/delete; `POST /:id/approve-first-run` lets later runs start
  on their own after the user approves the first one. Three recurring shapes:
  daily `{hour, minute}`, weekly `{weekday, hour, minute}` — weekday is
  0=Sunday … 6=Saturday, same as the web UI — and `{interval_hours: 1-168}`.
  All times UTC. Deleting a schedule leaves already-created tasks alone.
- In-process scheduler (env `AGENT_SCHEDULER_INTERVAL_MS`, default 60 s):
  each tick creates one task row per due schedule and hands it to the agent
  core (`startAgentTask`) when the schedule may run on its own
  (auto-approve, or first run approved); otherwise the task waits in
  `planned`. Missed ticks fire late (once) on the next tick — they are not
  skipped and not backfilled. Honest limitation: it does not survive
  restarts; a real queue can replace it later.
- Folder scope (`apps/api/src/agent/scope.ts`, used by the agent core):
  a task scoped to a project can only touch that project's files
  (`SCOPE_VIOLATION` otherwise); `scopeDiffSummary` lists files a task
  created in its folder.
- Notifications API (`/api/v1/agent/notifications`, auth): one notification
  per finished agent task (written by the core), newest first;
  `POST /:id/read` marks it read.

Step 8 additions (browser-based connections — sites with no API and no MCP
server):

- Browser-sites API (`/api/v1/connectors/browser-sites`, auth): `POST /`
  `{name, url}` → 201; `GET /` list; `GET /:id`; `POST /:id/login` starts a
  guided login and returns `{loginSessionId, liveViewUrl, expiresAt}` — the
  user opens the live view and logs in themselves (Genze never sees the
  password); `POST /:id/login/complete` `{loginSessionId}` captures the
  session cookies, encrypts them, and verifies them on a fresh session
  before marking the site `active`; `POST /:id/check` re-checks the session
  (only a positively logged-out page flips the site to `expired` — ambiguous
  pages never nag); `DELETE /:id` disconnects and destroys the saved login.
- Profiles are AES-256-GCM encrypted per user, reusing
  `TOKEN_ENCRYPTION_KEY` with a `genze:browser-profile:v1:` purpose label
  (no new env var). Cookies/tokens never leave the server or appear in logs.
- Login capture and health checks run through a read-only browser wrapper
  (`act()` always throws) — those paths can never click or type. The only
  write-capable path is `openSiteSessionForTask` (used by the agent), which
  requires a live, user-owned, runnable agent task whose Step 7 approval
  cards gate every state-changing action.
- Every action is audited to the connector audit log as
  `browser:<siteId>`. Browser minutes are metered (`feature='browser_site'`,
  $0.002/min, the Step 7 browser rate).
- Web: Settings → Connectors → **Websites** — add-site form, status badges
  (Logged in / Login expired / Not logged in), guided-login panel, check and
  disconnect buttons; 21 new strings in all five languages.
- Honest limitations: cookie-based profiles (sites keeping auth only in
  localStorage won't restore — the health check catches it); sites with
  aggressive bot detection may still block automation; the Steel profile
  methods are written against standard CDP but can't be live-verified
  without a Steel key (pending before launch).

Step 9 additions (Studio — images, voice, Video Director, Audio Overviews):

- **Images** (`/api/v1/studio/images`, auth): `POST /images`
  `{prompt, aspectRatio?, provider?}` → 201 (generation runs in the
  background); `GET /images`; `GET /images/:id` (metadata + signed
  `imageUrl` when ready); `POST /images/:id/edit` `{prompt}` (variation);
  `DELETE /images/:id`. Providers: `gemini-nano-banana-2.1` (Google) and
  GPT Image 2.5 (`gpt-image-2.5-flare`/`sunburst`, OpenAI) — cheapest
  capable wins by default; user can pick. Imagen 4 and Sora ids are
  rejected (400 — both dead). Metered cost-only per image.
- **Voice** (`/api/v1/studio/voice`, auth): `POST /voice/transcribe`
  (multipart audio) → Whisper, Google STT fallback; `POST /voice/speak`
  `{text, language}` → signed MP3 — the provider is the cheapest one that
  honestly covers the requested language (`VOICE_COVERAGE` matrix;
  ElevenLabs is en/ar/tr only — ur/fa never route there). Chat voice
  notes: `POST /chat/threads/:id/voice` (multipart) transcribes and then
  streams the reply as normal chat SSE. Voice cloning is NOT v1.
- **Video Director** (`/api/v1/studio/videos`, auth): `POST /videos`
  `{brief, targetMinutes?, provider?, musicFileId?}` → 201, status
  `estimating`; the background estimate job computes cost + seconds + time
  → status `awaiting_approval`. **Generation NEVER starts without**
  `POST /videos/:id/approve` (the hard gate — also checks daily limits,
  credits and env caps: `VIDEO_MAX_SECONDS_PER_PROJECT=900`,
  `VIDEO_MAX_SPEND_USD=20`). Stages: idea → script → storyboard (shot
  list) → per-shot generation (Veo 3.1 `veo-3.1-generate-001`, 4/6/8s;
  Kling 3.0 fallback, 3–15s) → voiceover → optional uploaded music bed →
  SRT captions → FFmpeg assembly → MP4 (≤15 min). Per-shot:
  `.../shots/:shotId/regenerate`, `PATCH .../shots/:shotId/reorder`
  `{order:[ids]}`, `DELETE .../shots/:shotId`, preview/download signed
  links. Progress via SSE `GET /videos/:id/events`; exactly one
  notification on finish. Credits are spent per generated second
  (`video:<id>:shot-<n>`); metering `feature='video'`, units = seconds.
  FFmpeg is shelled out to (`FFMPEG_PATH` or PATH) — verified present in
  this environment; assembly fails honestly if it's missing.
- **Audio Overviews** (`/api/v1/studio/audio-overviews`, auth):
  `POST /audio-overviews` `{fileIds, length: short|medium|long}` → a
  two-host podcast-style MP3 summarizing the user's files (script via the
  chat router, alternating TTS voices, concatenated); `GET` list/detail
  with signed playback URL; `DELETE`.
- Studio has its own consent surface (`GET/POST/DELETE /studio/consent`,
  sharing `consent_records` with chat) with capability-specific copy.
- Library gains `image` and `audio` groups; the `video` group now lists
  real `video_projects`.
- Web: the **Studio** tab — image generator/editor + gallery, TTS/STT
  cards, Video Director (estimate card with Approve/Discard, stage
  timeline, shot cards with preview/remake/reorder/delete, final player +
  download), Audio Overviews (file picker + length pills + players); a mic
  button on the chat composer for voice notes; 68 new strings in all five
  languages.
- Honest limitations: no live provider QA without keys (Veo/Kling/image/
  voice HTTP is stubbed in tests, written against public docs); Kling and
  ElevenLabs are fail-closed via the region table (no entries — they
  activate when the table is extended from official lists); generated
  music/SFX is not v1 (user-uploaded bed only); Veo 3.1 carries a
  retirement flag of **2026-11-17** — re-verify before launch.

## Deployment (one concrete path)

**Single VPS + Docker Compose + Caddy.** One small VPS runs Postgres, Redis,
the API and the web app from one compose file; Caddy terminates HTTPS
automatically (zero config) and reverse-proxies to web:3000 / api:4000.
Backups = one volume snapshot. Cheapest thing one person can operate;
no managed services needed until scale demands them.

```bash
# on the VPS
git clone <repo> && cd genze/app
cp .env.example .env   # set real JWT secrets + DATABASE_URL=postgresql://genze:genze@db:5432/genze
docker compose up -d --build
```

Caddyfile sketch:

```
genze.example.com {
    reverse_proxy web:3000
    handle /api/* {
        reverse_proxy api:4000
    }
}
```

Production rules: set real `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` (the API
refuses to boot without them when `NODE_ENV=production`), put Postgres data on
a persistent volume with daily snapshots, and never bake API keys into the web
bundle (only `NEXT_PUBLIC_*` vars are public).

## Decisions

See [DECISIONS.md](./DECISIONS.md) — the log of every significant judgment call,
including where Step 1 deviates from the original spec (Supabase → self-hosted
Postgres for zero-setup).
