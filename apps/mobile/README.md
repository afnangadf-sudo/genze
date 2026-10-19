# Genze Mobile (Expo)

The Genze mobile app — Expo + TypeScript + expo-router. Talks to the same
Fastify backend (`/api/v1`) as the web app. See `STORE_CHECKLIST.md` for the
store-submission compliance table.

## Layout

```
apps/mobile/
  app.json              Expo config (name, scheme, bundle ids, SDK 36, privacy manifests)
  package.json          Deps (Expo SDK 54 range) + workspace @genze/shared
  tsconfig.json         Strict TS; maps @genze/shared for standalone typecheck
  babel.config.js       babel-preset-expo + expo-router/babel
  metro.config.js       Watches the monorepo root (resolves @genze/shared + web i18n)
  STORE_CHECKLIST.md    Store compliance table (Apple/Play rules)
  types/expo-modules.d.ts  Ambient declarations for Expo modules (typecheck-only;
                           real packages come from package.json at install time)
  lib/
    api.ts              API client: SecureStore tokens, refresh-on-401, XHR SSE,
                        multipart, chat/consent/voice/library/moderation, Step 10 routes
    i18n.tsx            LangProvider — reuses apps/web/lib/i18n.ts STRINGS directly
                        (it is pure, no next.js imports) + mobile-only M_STRINGS;
                        RTL via I18nManager; dark/light via useColorScheme
    session.tsx         SessionProvider — password / Apple / Google sign-in, boot restore
    theme.ts            Light/dark palette
    components.tsx      Screen, Header, Btn, Field, Card, Err, Loading,
                        MadeWithAi, ReportButton, ComingSoon
  app/
    _layout.tsx         Providers + BootGate (login -> ai-consent -> tabs)
    index.tsx           Boot redirect target
    ai-consent.tsx      AI consent screen (Apple 5.1.2(i)); manage mode from Settings
    auth/callback.tsx   genze://auth/callback deep-link handler (Google OAuth return)
    (auth)/            login, signup, verify-email, forgot-password
    (tabs)/
      chat/            threads list + streaming chat (Made-with-AI + report per message)
      voice.tsx        tap-to-talk and record-a-message (expo-av + expo-speech)
      research.tsx     honest "coming soon" stub (real thing lives on web)
      write.tsx        stub
      studio.tsx       stub
      library.tsx      real GET /library (Made-with-AI + report on AI items)
      settings.tsx     languages, usage, AI permissions, contact, delete account
```

## Setup (real machine)

```sh
cd apps/mobile
pnpm install
npx expo install --fix        # align native deps to the installed Expo SDK
EXPO_PUBLIC_API_URL=https://api.example.com npx expo start
```

`EXPO_PUBLIC_API_URL` defaults to `http://localhost:4000` (same as web's
`NEXT_PUBLIC_API_URL` default). On a physical phone, `localhost` is the
phone itself — point it at your dev machine's LAN IP.

Typecheck only (no native toolchain):

```sh
pnpm --filter genze-mobile typecheck   # tsc --noEmit
```

Note: `apps/mobile/node_modules` currently contains a typecheck-only
scaffolding (typescript, @types/react, real `react` + `react-native` types
for the compiler, plus `types/expo-modules.d.ts` shims for the Expo native
modules). A full `pnpm install` will reconcile it with `package.json`; the
shims stay until the real Expo packages are installed.

## Conventions (mirrored from web)

- Every API route comes from `API_ROUTES` (`@genze/shared`) — never
  hardcoded. The only exceptions are the Step 10 backend routes in
  `lib/api.ts` (`STEP10_ROUTES`: `/auth/apple`, `/moderation/report`,
  `/moderation/block`), which do not exist in `@genze/shared` yet; they live
  in one place and degrade gracefully until the API worker lands them.
- UI copy comes from the web `STRINGS` dictionaries (same five languages:
  en/ur/ar/tr/fa); mobile-only copy is in `M_STRINGS` in `lib/i18n.tsx`.
- Plain language, no jargon, no pop-ups — errors render inline.
- Layouts use flex + start/end alignment, never left/right (RTL-correct).

## Known backend gaps (mobile is written against them)

1. `POST /auth/apple` — Apple login needs this endpoint (token verification).
2. `POST /moderation/report`, `POST /moderation/block` — report/block UI is
   built; calls fail soft with "not available yet" until these land.
3. `PATCH /account/me {aiNoticeAccepted}` — sent best-effort; the on-device
   SecureStore flag is the source of truth meanwhile.
4. **Google OAuth mobile return** — `GET /auth/oauth/google` must honor
   `?redirect_uri=genze://auth/callback` and 302 there instead of the web
   `APP_URL` callback. The app sends the parameter and implements the
   `genze://auth/callback` route; without the backend change, Google
   sign-in strands the user on the web page.

## Not done here (honest)

- No real-device testing, no EAS build, no store submission.
- Research/Write/Studio are "coming soon" stubs on mobile by design.
- `support@genze.app` and the `app.genze.mobile` bundle/package IDs are
  placeholders (see `STORE_CHECKLIST.md`).
