// Session provider: tokens in SecureStore, the current user, and the
// sign-in/out flows (password, Apple, Google). Mirrors the web session
// behaviour: a failed refresh clears the session and the UI routes to login.

import * as React from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import type { User } from "@genze/shared";
import { API_ROUTES } from "@genze/shared";
import {
  API_BASE,
  ApiClientError,
  clearTokens,
  getMe,
  getTokens,
  login,
  loginWithApple,
  logout,
  setOnSessionExpired,
  signup,
} from "./api";

const aiConsentKey = (userId: string) => `genze_ai_consent_${userId}`;

export type SessionStatus = "loading" | "logged-in" | "logged-out";

interface SessionValue {
  status: SessionStatus;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, country: string) => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** True once the user has passed the AI consent screen on this device. */
  aiConsentSeen: () => Promise<boolean>;
  markAiConsentSeen: () => Promise<void>;
}

const SessionContext = React.createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

export function SessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = React.useState<SessionStatus>("loading");
  const [user, setUser] = React.useState<User | null>(null);

  const signOutLocal = React.useCallback(async () => {
    await clearTokens();
    setUser(null);
    setStatus("logged-out");
  }, []);

  // Boot: restore the session from SecureStore.
  React.useEffect(() => {
    let cancelled = false;
    setOnSessionExpired(() => {
      void signOutLocal();
    });
    (async () => {
      try {
        const { access } = await getTokens();
        if (!access) {
          if (!cancelled) setStatus("logged-out");
          return;
        }
        const me = await getMe();
        if (!cancelled) {
          setUser(me);
          setStatus("logged-in");
        }
      } catch {
        if (!cancelled) {
          await clearTokens();
          setStatus("logged-out");
        }
      }
    })();
    return () => {
      cancelled = true;
      setOnSessionExpired(null);
    };
  }, [signOutLocal]);

  const signIn = React.useCallback(async (email: string, password: string) => {
    const result = await login(email.trim(), password);
    setUser(result.user);
    setStatus("logged-in");
  }, []);

  const signUp = React.useCallback(async (email: string, password: string, country: string) => {
    await signup(email.trim(), password, country.toUpperCase());
  }, []);

  const signInWithApple = React.useCallback(async () => {
    if (Platform.OS !== "ios") {
      throw new ApiClientError("APPLE_UNAVAILABLE", "Sign in with Apple is only on iPhone and iPad.", 0);
    }
    const available = await AppleAuthentication.isAvailableAsync();
    if (!available) {
      throw new ApiClientError("APPLE_UNAVAILABLE", "Sign in with Apple isn't available on this device.", 0);
    }
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
    });
    if (!credential.identityToken) {
      throw new ApiClientError("APPLE_FAILED", "Apple didn't return a sign-in token. Please try again.", 0);
    }
    const result = await loginWithApple(credential.identityToken);
    setUser(result.user);
    setStatus("logged-in");
  }, []);

  const signInWithGoogle = React.useCallback(async () => {
    // Opens the system browser on the backend's Google OAuth start URL.
    // IMPORTANT — backend contract gap (documented, needs the API worker):
    // GET /auth/oauth/google currently 302s to ${APP_URL}/auth/callback
    // (the WEB callback) with the tokens in the query string. For mobile,
    // the backend must instead redirect to genze://auth/callback when the
    // request carries ?redirect_uri=genze://auth/callback (sent below).
    // Until that lands, completing Google sign-in leaves the user on the
    // web page; the app's auth/callback route handles the deep link the
    // moment the backend supports it.
    const startUrl =
      `${API_BASE}${API_ROUTES.oauthGoogle}` +
      `?redirect_uri=${encodeURIComponent("genze://auth/callback")}`;
    await WebBrowser.openBrowserAsync(startUrl, { showTitle: true });
    // If the OS delivered genze://auth/callback while the browser was open,
    // the callback route already stored the tokens — pick the session up.
    const { access } = await getTokens();
    if (access) {
      try {
        const me = await getMe();
        setUser(me);
        setStatus("logged-in");
        return;
      } catch {
        /* fall through to the "didn't work" error below */
      }
    }
    throw new ApiClientError(
      "GOOGLE_INCOMPLETE",
      "Google sign-in didn't finish. Please try again.",
      0,
    );
  }, []);

  const signOut = React.useCallback(async () => {
    await logout();
    setUser(null);
    setStatus("logged-out");
  }, []);

  const refreshUser = React.useCallback(async () => {
    const me = await getMe();
    setUser(me);
  }, []);

  const aiConsentSeen = React.useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    try {
      return (await SecureStore.getItemAsync(aiConsentKey(user.id))) === "1";
    } catch {
      return false;
    }
  }, [user]);

  const markAiConsentSeen = React.useCallback(async (): Promise<void> => {
    if (!user) return;
    try {
      await SecureStore.setItemAsync(aiConsentKey(user.id), "1");
    } catch {
      /* storage unavailable */
    }
  }, [user]);

  const value = React.useMemo<SessionValue>(
    () => ({
      status,
      user,
      signIn,
      signUp,
      signInWithApple,
      signInWithGoogle,
      signOut,
      refreshUser,
      aiConsentSeen,
      markAiConsentSeen,
    }),
    [status, user, signIn, signUp, signInWithApple, signInWithGoogle, signOut, refreshUser, aiConsentSeen, markAiConsentSeen],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
