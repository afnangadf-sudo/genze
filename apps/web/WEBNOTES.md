# Genze Web — Step 1 notes (@genze/web)

Built 2026-10-18 by the web subagent. Not run: `pnpm install`, `typecheck`, `build`
(coordinator installs at root first).

## Structure

- `app/layout.tsx` — Inter (EN) + Noto Nastaliq Urdu (UR) via next/font/google;
  boot script in <head> applies theme class + `dir`/`lang` before first paint.
- `lib/auth.ts` — token storage (`genze_access`, `genze_refresh`), `apiFetch`
  (Bearer attach; on 401 tries ONE refresh rotation then retries once; on refresh
  failure clears tokens and sends to /login, except on public auth pages).
- `lib/i18n.ts` — flat en/ur dictionary; all UI copy lives here, plain language.
- `lib/lang.tsx` — en/ur context, persisted `genze_lang`, sets `dir="rtl"` on <html> for Urdu.
- `lib/theme.tsx` — dark/light, persisted `genze_theme`, class strategy.
- `lib/countries.ts` — signup country <select>, Pakistan first, ISO-2 codes.
- `components/` — Sidebar, TabShell, ThemeToggle, LangSwitch, AiNotice, Field,
  Button, ConsentGate (stub: renders children).

## Decisions / interpretations (contract was clear; these are the judgment calls)

1. **Login 202 vs 200**: handled in-page. 202 `{twoFactorRequired, pendingToken}` shows
   the code field, then POSTs `login/2fa`. `apiFetch(..., {skipRefresh: true})` on the
   login/signup/verify/forgot/reset forms so a 401 maps to the plain-language error,
   never triggers the refresh flow.
2. **Export**: `GET /account/export` returns a raw JSON attachment, not `{data: …}`,
   so the settings page uses a direct `fetch` + blob download instead of `apiFetch`
   (which expects the `{data}` envelope). Filename: `genze-data.json`.
3. **2FA setup QR**: no QR dependency — shows the `secret` and the full `otpauthUrl`
   as copyable text plus a code field to enable. Simple, works with any authenticator app.
4. **Delete account type-to-confirm**: user types their own email address (not "DELETE")
   plus their password, then DELETE `/account` with `{password}`. OAuth-only users'
   `{oauthConfirm: true}` path is not exposed in the UI yet (Step 1; add when OAuth login ships).
5. **Devices "Sign out"**: only the current device gets a Sign out button
   (POST `/auth/logout` revokes this session, then local tokens are cleared).
   "Sign out everywhere" calls POST `/auth/logout-all`.
6. **Root page**: client-side — token present → `router.replace("/chat")`, else the
   welcome page. No server session since tokens live in localStorage.
7. **`transpilePackages: ["@genze/shared"]`** in next.config.mjs so Next compiles the
   workspace package's `.ts` source (its package.json exports `./src/index.ts` directly).
8. **Google button**: rendered only when `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === "true"`,
   linking to `${NEXT_PUBLIC_API_URL}${API_ROUTES.oauthGoogle}`.
9. **ConsentGate** wraps the tab pages and renders children for now; `/consent` is a
   plain-language stub with a disabled "Not needed yet" button.
10. **Change-password in settings**: skipped per task brief (only 2FA setup/disable UI).

## Env used (only these two)

- `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`)
- `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED`

## Still to verify after install

- `pnpm --filter @genze/web typecheck` and `next build`
  (next/font/google needs network at build time).
- One end-to-end pass against the real API once `apps/api` is built.

## Step 2 notes (@genze/web) — built 2026-10-18 by the web subagent

- `lib/chat.ts` — SSE streaming (`streamChatMessage`: fetch + ReadableStream,
  parses `data:` lines into ChatStreamEvent, ignores `: ping` comments;
  mirrors lib/auth's 401→refresh→retry flow for the streaming POST, then
  falls back to clearTokens + /login like apiFetch). REST wrappers for
  threads/messages/consent via apiFetch + API_ROUTES.
- `components/chat/ChatApp.tsx` — full chat UI inside TabShell: collapsible
  thread panel (New chat, inline rename, inline delete-confirm, active
  highlight; hidden behind a toggle on <md), Claude-like bubbles, thinking
  indicator, streaming text, STOP button (AbortController), textarea with
  Enter-to-send / Shift+Enter newline, suggestion cards in the empty state,
  "Demo" pill on demo replies, inline API error + retry (retry deletes the
  failed user message first to avoid duplicates).
- `components/ConsentGate.tsx` — real gate: GET /chat/consent, shows the
  consent card only when some provider is required && !granted; per-helper
  Allow + Allow all; quiet "Not now" link dismisses for the session only
  (API 403s still surface inline in chat). Fails open to children on fetch error.
- `app/consent/page.tsx` — consent management (name, whatSees, granted pill,
  Allow/Withdraw); empty state when nothing is required.
- `lib/i18n.ts` — all new copy in EN + natural UR (chat_*, consent_*).
- `pnpm --filter @genze/web typecheck` — CLEAN. `next build` not run
  (coordinator verifies).
