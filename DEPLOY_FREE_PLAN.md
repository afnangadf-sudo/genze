# Genze Public Deployment Plan — $0/month (free tiers)

Goal (user order 2026-10-19): "dusray log bhi use kar saken" — Genze publicly
accessible so other people can sign up and use it. Zero money.

## Architecture (free)

| Piece | Service | Free tier | Notes |
|---|---|---|---|
| Web (Next.js) | Vercel | Free forever | Perfect for Next.js, auto HTTPS |
| API (Fastify/Node) | Render | 750 hrs/mo free | Sleeps after 15 min idle (wakes on request) |
| Postgres + pgvector | Neon | 0.5 GB free | pgvector supported; migrations auto-run on API boot |
| Redis | Upstash | 10k cmds/day free | Enough for sessions/rate limits at start |

Total: $0/month. All four have "Sign up with Google" (user only logs in; Nyx does the rest).

## What the user does (nothing technical)

1. Say "go" — Nyx opens each signup page (browser), user logs in with Google (2 minutes each).
2. Done. Nyx connects the pieces, deploys, tests, and hands over the public link.

## What Nyx does (everything else)

1. Create Vercel project from the repo (or direct upload), set `NEXT_PUBLIC_API_URL`.
2. Create Neon database, run `CREATE EXTENSION vector` (API runs migrations 001–019 on boot).
3. Create Upstash Redis, copy URL.
4. Deploy API to Render with env: `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`,
   `JWT_REFRESH_SECRET` (generated, 64 chars), `TOKEN_ENCRYPTION_KEY` (generated),
   `NODE_ENV=production`, `APP_URL` (public web URL).
5. Point web to API, verify: signup → consent → chat (free AI) → reply.
6. Hand over the public URL.

## Known limits (honest)

- Render free sleeps when idle: first request after idle takes ~30–60s to wake. (Upgrade later if it matters.)
- Free AI is shared: all users share the free community AI quota (rate limits). When the
  user provides a real key later (Gemini/Anthropic/OpenAI), it automatically takes priority.
- No custom domain on free tiers (URLs like genze.vercel.app). Custom domain later.
- Backups: Neon free includes point-in-time recovery (7 days).

## Blocked on (2026-10-19)

- ~~The machine's browser tool is currently broken (tabs won't open) — needed for the
  signup/login flows. Retry when it recovers.~~ RESOLVED 2026-10-19 ~13:10 PKT: browser tool works again (verified live page load).
- Needs the user's "go" ✅ (received 2026-10-19 ~13:08 PKT) + Google logins (4 quick logins, ~10 minutes total) — waiting on the user.
