# Genze Mobile — Store Submission Checklist

Re-verified 2026-10-19 against the code in `apps/mobile`. No rule-relevant
changes since the 2026-10-18 baseline. **This app is NOT ready to publish.**
Everything below is either done in code, or explicitly listed as remaining
outside code. There are no fake "ready" claims here.

> Note: `app.json` is strict JSON (no comments allowed), so the placeholder
> bundle/package IDs (`app.genze.mobile`) are documented here and in
> `README.md` instead of inline.

## In-code compliance

| Rule | What the rule asks | Implemented in code | Re-verified 2026-10-19 |
|---|---|---|---|
| Apple 4.8 — Sign in with Apple | Third-party login (Google) requires Sign in with Apple on iOS | `app/(auth)/login.tsx` shows a Sign in with Apple button on iOS only (`Platform.OS === "ios"` + `AppleAuthentication.isAvailableAsync()`); token goes to `POST /auth/apple` (`lib/api.ts` `loginWithApple`) | Yes — button, iOS gate, backend call all present |
| Apple 5.1.2(i) — AI data-use consent | Disclose what AI helpers see; get consent before any AI request | `app/ai-consent.tsx`: shown on first launch after login **before any AI request** (`app/_layout.tsx` BootGate); lists every provider from `GET /chat/consent` with the server's plain-language `whatSees`; per-provider Allow/Withdraw; records the app-level notice via `PATCH /account/me {aiNoticeAccepted:true}` (best-effort) + a per-user SecureStore flag; decline path keeps non-AI features (Library/Settings) usable; 403 `CONSENT_REQUIRED` mid-chat routes back to this screen; revoke lives in Settings → AI permissions (manage mode) via `DELETE /chat/consent/:provider` | Yes — flow, copy source, revoke, mid-chat reroute all present |
| Apple 1.2 (incl. 2.5.19) — user content moderation | Report/block on user & AI content; published contact info | `ReportButton` (`lib/components.tsx`) on every assistant chat message and every Library image/audio/video item → `POST /moderation/report`; `blockUser()` → `POST /moderation/block` is wired in `lib/api.ts` (no shared-content surface exists in mobile v1 — Library is the user's own — so it has no UI surface yet, documented honestly); support email published in Settings → Contact us | Yes — report UI present; block wired, no fake UI |
| Apple 5.1.1(v) — account deletion | Account creation requires in-app account deletion | Settings → Delete my account: typed `DELETE` confirmation + password (or `oauthConfirm` for Google/Apple users) → `DELETE /account`, then SecureStore is wiped and the session ends (`app/(tabs)/settings.tsx`, `lib/api.ts` `deleteAccount`) | Yes |
| Play — AI-generated content policy | Label AI content; self-declare in Play Console | `MadeWithAi` marker (`lib/components.tsx`) under every assistant chat message and on every Library image/audio/video item; the "Made with AI" copy is translated in all five UI languages | Yes — markers present on all AI surfaces |
| Play — target API 36 | `targetSdkVersion 36` | `app.json`: `android.targetSdkVersion: 36`, `compileSdkVersion: 36`, `minSdkVersion: 24` | Yes |
| iOS privacy manifests | Declare required-reason API use | `app.json` → `expo.ios.privacyManifests`: `NSPrivacyAccessedAPICategoryUserDefaults` → `CA92.1` only. `file-timestamp` (C617.1), `system-boot-time` (35F9.1), `disk-space` (E174.1) are **deliberately not declared**: none of the native deps used (expo-secure-store → Keychain/Keystore, expo-apple-authentication → AuthenticationServices, expo-av → AVAudioSession, expo-speech → AVSpeechSynthesizer, expo-router/expo-web-browser) touch those APIs. **Re-verify with `npx expo prebuild` output before submission** — adding a dep later can change this. | Yes — decision recorded; prebuild re-check required |
| Microphone permission | Runtime + manifest strings for voice recording | `ios.infoPlist.NSMicrophoneUsageDescription` + `android.permissions: ["RECORD_AUDIO"]` in `app.json`; runtime `Audio.requestPermissionsAsync()` in `app/(tabs)/voice.tsx` with a plain-language denial message | Yes |

## Deliberate non-goals / honest gaps in code

- **Backend Step 10 routes do not exist yet** (verified 2026-10-19: no
  `/auth/apple`, `/moderation/*`, or `aiNoticeAccepted` in `apps/api` or
  `@genze/shared`). The client calls them and degrades gracefully:
  Apple login and moderation report/block show plain-language
  "not available yet" until the API worker lands them; the AI notice is
  stored on-device (SecureStore, per user) as the source of truth meanwhile.
- **Google sign-in deep link needs a backend change.** `GET /auth/oauth/google`
  currently 302s to the *web* callback (`${APP_URL}/auth/callback`). The
  mobile client sends `?redirect_uri=genze://auth/callback` and implements
  the `genze://auth/callback` route (`app/auth/callback.tsx`), but the
  backend must honor that parameter before Google sign-in works on mobile.
  Documented in `lib/session.tsx` and `README.md`.
- expo-av / expo-speech have **no config plugins** in the SDK — they are
  dependencies only; permissions come from `app.json` + runtime requests.
  Listed plugins: `expo-router`, `expo-apple-authentication`,
  `expo-secure-store`.
- `SUPPORT_EMAIL` in Settings (`app/(tabs)/settings.tsx`) is the placeholder
  `support@genze.app` — replace with the real support mailbox.
- Bundle/package ID `app.genze.mobile` is a **placeholder** — set the real
  IDs at store enrollment.

## Remaining OUTSIDE code (not done, not claimed)

- Apple Developer Program enrollment ($99/yr) and App Store Connect submission.
- Google Play developer account ($25 one-time) and Play Console submission,
  including the **data-safety form** and the **AI-generated content
  self-declaration** questionnaire.
- **Real-device testing** (iPhone + Android): Apple/Google sign-in,
  microphone recording, TTS voices, RTL layouts, dark mode. None of this was
  possible in this environment — no device, no EAS build.
- `pnpm install` + `npx expo install --fix` + `eas build` (see `README.md`).
- **Native-speaker review** of the Urdu, Arabic, Turkish and Persian copy
  (all new mobile strings were written fresh for v1).
- Privacy-policy and terms URLs for the store listings.
- App screenshots, feature graphic, and store descriptions.
